import type { Ctx } from "./ctx";
import { fetchTimeout } from "./ctx";
import { randomHex } from "./crypto";
import { armWake, convKeyOf, normalize } from "./conv";
import { readAll, update, updateMulti } from "./store";
import type { Conv } from "./types";

export const WAKE_EVENT = "whatsapp_conversation_pending";
const WAKE_TIMEOUT_MS = 10000;
/** a stale-scheduled wake (successful but never claimed) is re-fired at most this many times */
export const MAX_REARMS = 3;
/** opportunistic retry pass: at most one per instance per this interval (each pass is one document read) */
export const RETRY_PASS_MIN_MS = 5 * 60 * 1000;

export const wakeBackoffMs = (attempts: number): number =>
  Math.min(6 * 3600 * 1000, 60000 * 2 ** Math.min(attempts, 9));

/** Content-free wake payload: IDs and counters only. */
export function wakePayload(c: Conv, dueAt: number) {
  return {
    event: WAKE_EVENT,
    conversation_id: c.id,
    pending_messages: c.unhandled,
    wake_at: new Date(dueAt).toISOString(),
    note: "Use the WAB bot MCP: list_pending / claim_conversation. No message content in this payload.",
  };
}

async function post(ctx: Ctx, c: Conv, dueAt: number): Promise<{ ok: boolean; code: number }> {
  const { cfg } = ctx;
  if (!cfg.wakeUrl) return { ok: false, code: -1 };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.wakeKey) {
    if (cfg.wakeAuth === "bearer") headers["Authorization"] = `Bearer ${cfg.wakeKey}`;
    if (cfg.wakeHeader) headers[cfg.wakeHeader] = cfg.wakeKey;
    else if (cfg.wakeAuth === "header") headers["Authorization"] = cfg.wakeKey;
  }
  try {
    const r = await fetchTimeout(ctx, cfg.wakeUrl, { method: "POST", headers, body: JSON.stringify(wakePayload(c, dueAt)) }, WAKE_TIMEOUT_MS);
    return { ok: r.status >= 200 && r.status < 300, code: r.status };
  } catch {
    return { ok: false, code: 0 };
  }
}

/** What an armed wake needs to be fired: only the holder of `runner` may fire it. */
export interface Armed {
  id: string;
  runner: string;
  dueAt: number;
}

export const armedOf = (c: Conv): Armed => ({ id: c.id, runner: c.wake.runner!, dueAt: c.wake.dueAt! });

/**
 * Debounced wake. Only the invocation holding the runner token fires it, so concurrent tasks send one wake.
 * Cost: 1 GET (verify the token is still current) + the POST. A SUCCESSFUL wake writes NOTHING (the next
 * claim_conversation records it as sent in its own write); a FAILED wake costs 1 put (backoff bookkeeping).
 * If the instance dies before firing, the conversation stays scheduled and the retry pass re-fires it after
 * STALE_WAKE_MS.
 */
export async function runWake(ctx: Ctx, a: Armed): Promise<void> {
  const key = convKeyOf(a.id);
  const wait = a.dueAt - ctx.now();
  if (wait > 0) await ctx.sleep(wait);
  const cur = await ctx.store.get<Conv>(key);
  if (!cur) return;
  const now0 = ctx.now();
  const c = normalize(structuredClone(cur.value), now0);
  const w = c.wake;
  if (w.status !== "scheduled" || w.runner !== a.runner || c.state !== "pending") return;
  const r = await post(ctx, c, a.dueAt);
  ctx.log("wake", { conv: a.id, ok: r.ok, code: r.code, pending: c.unhandled });
  if (r.ok) return;
  await update<Conv, null>(ctx, key, (cc) => {
    if (!cc || cc.wake.status !== "scheduled" || cc.wake.runner !== a.runner) return { next: undefined, result: null };
    const now = ctx.now();
    const ww = cc.wake;
    ww.log.push({ at: now, ok: false, code: r.code });
    if (ww.log.length > 20) ww.log.splice(0, ww.log.length - 20);
    ww.status = "failed";
    ww.runner = undefined;
    ww.attempts += 1;
    ww.nextRetryAt = now + wakeBackoffMs(ww.attempts);
    ww.lastError = `wake_http_${r.code}`;
    cc.updatedAt = now;
    return { next: cc, result: null };
  });
}

/** Called from claim_conversation's write: record the outcome of the wake that brought the agent here. */
export function settleWakeOnClaim(c: Conv, now: number) {
  const w = c.wake;
  if (w.status === "scheduled" && (w.dueAt ?? now) <= now) {
    w.log.push({ at: w.dueAt ?? now, ok: true, code: 200 }); // 2xx assumed: success is not persisted when it happens
    if (w.log.length > 20) w.log.splice(0, w.log.length - 20);
    w.status = "sent";
  } else if (w.status === "scheduled" || w.status === "failed") {
    w.status = "none";
  }
  w.attempts = 0;
  w.rearms = 0;
  w.lastError = undefined;
  w.nextRetryAt = undefined;
  w.runner = undefined;
  w.dueAt = undefined;
}

function retryDue(c: Conv, now: number, staleMs: number): boolean {
  if (c.state !== "pending") return false;
  const w = c.wake;
  return (
    (w.status === "failed" && (w.nextRetryAt ?? 0) <= now) ||
    (w.status === "scheduled" && (w.dueAt ?? 0) + staleMs <= now && (w.rearms ?? 0) < MAX_REARMS)
  );
}

/** Arm every conversation in `ids` that `want` accepts, in ONE put; returns what to fire. */
async function armMany(ctx: Ctx, ids: string[], want: (c: Conv, now: number) => boolean): Promise<Armed[]> {
  if (!ids.length) return [];
  const r = await updateMulti<Armed[]>(ctx, ids.map(convKeyOf), (curs) => {
    const now = ctx.now();
    const armed: Armed[] = [];
    const next = curs.map((cur: Conv | null) => {
      if (!cur) return undefined;
      normalize(cur, now);
      if (!want(cur, now)) return undefined;
      armed.push(armedOf(cur));
      return cur;
    });
    return { next: armed.length ? next : [], result: armed };
  });
  return r.result;
}

/** Retry pass: failed-and-due and stale-scheduled wakes. Read-only (1 GET) unless something is due (then 1 put + wake). */
export async function retryFailedWakes(ctx: Ctx): Promise<number> {
  const { items } = await readAll<Conv>(ctx.store, "conv/");
  const now0 = ctx.now();
  const ids = items
    .map((r) => normalize(structuredClone(r.value), now0))
    .filter((c) => retryDue(c, now0, ctx.cfg.staleWakeMs))
    .map((c) => c.id);
  const armed = await armMany(ctx, ids, (c, now) => {
    if (!retryDue(c, now, ctx.cfg.staleWakeMs)) return false;
    const w = c.wake;
    if (w.status === "scheduled") w.rearms = (w.rearms ?? 0) + 1;
    w.status = "scheduled";
    w.dueAt = now;
    w.runner = randomHex(8);
    c.updatedAt = now;
    return true;
  });
  for (const a of armed) await runWake(ctx, a);
  ctx.log("retry_wakes", { tried: armed.length });
  return armed.length;
}

/** Throttled opportunistic retry pass (called from webhook POSTs; at most one GET per RETRY_PASS_MIN_MS per instance). */
export function maybeRetryInBackground(ctx: Ctx) {
  const now = ctx.now();
  if (now - ctx.state.lastRetryPass < RETRY_PASS_MIN_MS && ctx.state.lastRetryPass !== 0) return;
  ctx.state.lastRetryPass = now;
  ctx.schedule(async () => {
    try {
      await retryFailedWakes(ctx);
    } catch (e) {
      ctx.log("deferred_error", { where: "retry_pass", err: e instanceof Error ? e.name : "unknown" });
    }
  }, "maintenance");
}

/** After setting auto-reply to active: wake every pending conversation now (one put for all of them). */
export async function kickPendingWakes(ctx: Ctx): Promise<number> {
  const { items } = await readAll<Conv>(ctx.store, "conv/");
  const now0 = ctx.now();
  const ids = items.map((r) => normalize(structuredClone(r.value), now0)).filter((c) => c.state === "pending").map((c) => c.id);
  const armed = await armMany(ctx, ids, (c, now) => c.state === "pending" && armWake(c, now, now));
  for (const a of armed) ctx.schedule(() => runWake(ctx, a));
  return armed.length;
}
