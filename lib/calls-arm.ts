import { disarmRemote, enableMetaSip, prepareArm, type DisarmReport } from "./calls-remote";
import { ARM_KEY, callingGate, remoteOf, tombstone, type ArmRow, type Json } from "./calls";
import type { Ctx } from "./ctx";
import { update } from "./store";

/**
 * Arm / disarm voice calling. "Armed" means: the business number is registered at xAI AND Meta calling over SIP is switched on, for a short
 * window the owner opened. Disarm undoes both. Safety nets, in order: the call that uses the last allowed slot disarms right after it ends;
 * a Durable Object alarm (dead-man) disarms when the window is over even if the Worker restarts; the daily cron retries a failed disarm.
 * Nothing here returns or logs a credential: results carry statuses and booleans.
 */
export interface ArmDeps {
  /** schedule (at = epoch ms) or clear (null) the dead-man alarm */
  setDeadman(at: number | null): Promise<void>;
}

export const ARM_MIN_MINUTES = 1;
export const ARM_MAX_MINUTES = 60;
export const ARM_MAX_CALLS = 5;
const STALE_ARMING_MS = 2 * 60_000;
const DEADMAN_GRACE_MS = 30_000;

export const deadmanAt = (expiresAt: number, maxCallSeconds: number) => expiresAt + maxCallSeconds * 1000 + DEADMAN_GRACE_MS;

export interface ArmArgs {
  minutes: number;
  maxCalls: number;
  /** required in live mode: digits of the number, must equal the owner-approved CALLING_GO_NUMBER */
  number?: string;
  /** public URL of /api/xai-sip on this Worker */
  webhookUrl: string;
}

export async function armCalling(ctx: Ctx, a: ArmArgs, deps: ArmDeps): Promise<Json> {
  const cfg = ctx.cfg;
  const gate = callingGate(cfg);
  if (!gate.ok) return { ok: false, error: "calling_gate_closed", reason: gate.reason, hint: "The owner opens the gate with Worker settings (docs/VOICE-CALLS.md). No tool can." };
  if (cfg.callingMode === "live" && a.number !== cfg.callingGoNumber) return { ok: false, error: "number_must_match_owner_approved_number" };
  const remote = remoteOf(ctx);
  const pnid = cfg.callingPhoneNumberId;
  if (!remote || !pnid) return { ok: false, error: "not_configured" };
  const now = ctx.now();
  const expiresAt = now + a.minutes * 60_000;
  const mode = cfg.callingMode === "live" ? "live" : "test";

  // 1. claim the arm slot (create-or-replace-a-tombstone, compare-and-swap: two racing arms cannot both win)
  const claim = await update<ArmRow, { ok: boolean; error?: string; until?: number }>(ctx, ARM_KEY, (cur) => {
    if (cur && cur.state === "armed") return { next: undefined, result: { ok: false, error: now <= cur.expiresAt ? "already_armed" : "previous_window_not_closed_run_disarm_first", until: cur.expiresAt } };
    if (cur && cur.state === "arming" && now - cur.armedAt < STALE_ARMING_MS) return { next: undefined, result: { ok: false, error: "arming_in_progress" } };
    if (cur && cur.needsRetry) return { next: undefined, result: { ok: false, error: "previous_disarm_incomplete_run_disarm_first" } };
    const row: ArmRow = { state: "arming", mode, pnid, armedAt: now, expiresAt, maxCalls: a.maxCalls, callsStarted: 0, callsFinished: 0 };
    return { next: row, result: { ok: true } };
  });
  if (!claim.result.ok) return { ok: false, error: claim.result.error, ...(claim.result.until ? { armed_until: new Date(claim.result.until).toISOString() } : {}) };

  // 2. checks + xAI registration
  let prep;
  try {
    prep = await prepareArm(remote, { pnid, goNumber: cfg.callingMode === "live" ? cfg.callingGoNumber : undefined, webhookUrl: a.webhookUrl, label: "wab-bot-calling" });
  } catch {
    prep = { ok: false as const, step: "network_error" };
  }
  if (!prep.ok) {
    await update<ArmRow, null>(ctx, ARM_KEY, (cur) => ({ next: cur ? { ...cur, state: "disarmed", disarmedAt: ctx.now(), disarmReason: "arm_failed:" + prep.step } : undefined, result: null }));
    return { ok: false, error: "arm_failed", step: prep.step, ...("status" in prep && prep.status ? { status: prep.status } : {}) };
  }

  // 3. store the signing secret and the cleanup handles BEFORE Meta is switched on, then set the dead-man alarm
  await update<ArmRow, null>(ctx, ARM_KEY, (cur) => ({
    next: cur ? { ...cur, state: "armed", number: prep.number, xaiPhoneId: prep.xaiPhoneId, whSecret: prep.signingSecret, prior: prep.prior } : undefined,
    result: null,
  }));
  try { await deps.setDeadman(deadmanAt(expiresAt, cfg.callMaxSeconds)); } catch { /* the cron sweep is the second net */ }

  // 4. Meta calling ON
  let enabled = false;
  try { enabled = (await enableMetaSip(remote, pnid, { sipWebhooks: cfg.callSipWebhooks })).ok; } catch { enabled = false; }
  if (!enabled) {
    const d = await disarmCalling(ctx, "meta_enable_failed", deps);
    return { ok: false, error: "arm_failed", step: "meta_enable", disarmed: d.ok === true };
  }
  ctx.log("calls_armed", { mode, minutes: a.minutes, max_calls: a.maxCalls });
  return {
    ok: true,
    mode,
    armed_until: new Date(expiresAt).toISOString(),
    max_calls: a.maxCalls,
    number_hint: "…" + (prep.number as string).slice(-2),
    note: "Calling is ON for this window only. It switches itself off after the last allowed call or when the window ends. Call the number from an allowed caller now.",
  };
}

/** Switch calling off and clear the secret. Safe to call any time, with or without an arm row. */
export async function disarmCalling(ctx: Ctx, reason: string, deps: ArmDeps): Promise<Json> {
  const remote = remoteOf(ctx);
  const cur = (await ctx.store.get<ArmRow>(ARM_KEY))?.value ?? null;
  const pnid = cur?.pnid ?? ctx.cfg.callingPhoneNumberId;
  if (!remote || !pnid) return { ok: false, error: "not_configured", hint: "Need WA_ACCESS_TOKEN, XAI_API_KEY and a phone number id to undo anything remotely. Disable calling in the Meta app dashboard instead." };
  let report: DisarmReport;
  try {
    report = await disarmRemote(remote, { pnid, xaiPhoneId: cur?.xaiPhoneId, prior: cur?.prior });
  } catch {
    report = { meta: "failed", meta_status: null, xai: cur?.xaiPhoneId ? "failed" : "skipped", xai_status: null };
  }
  const now = ctx.now();
  if (cur) await update<ArmRow, null>(ctx, ARM_KEY, (c) => ({ next: c ? tombstone(c, report, now, reason) : undefined, result: null }));
  const ok = report.meta !== "failed" && report.xai !== "failed";
  if (ok) await deps.setDeadman(null).catch(() => undefined);
  ctx.log("calls_disarmed", { reason: reason.slice(0, 40), ok });
  return {
    ok,
    meta: report.meta,
    xai_number: report.xai,
    ...(ok ? {} : { hint: "A step failed. Run disarm again; the dead-man alarm and daily cron also retry. If it keeps failing, disable calling in the Meta app dashboard and delete the number in the xAI console." }),
  };
}

/** Cron safety net: close a window that outlived itself, retry a disarm that failed. Returns true if it acted. */
export async function sweepCalling(ctx: Ctx, deps: ArmDeps): Promise<boolean> {
  const cur = (await ctx.store.get<ArmRow>(ARM_KEY))?.value ?? null;
  if (!cur) return false;
  const now = ctx.now();
  const overdue = (cur.state === "armed" || cur.state === "arming") && now > deadmanAt(cur.expiresAt, ctx.cfg.callMaxSeconds);
  if (!overdue && !(cur.state === "disarmed" && cur.needsRetry)) return false;
  await disarmCalling(ctx, overdue ? "window_over_sweep" : "retry", deps);
  return true;
}
