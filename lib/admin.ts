import { bearerOf, tokenOk } from "./crypto";
import type { Ctx } from "./ctx";
import { CONV_ID_RE, armWake, convKeyOf, normalize, windowOpen } from "./conv";
import { CONTROLS_KEY, controlsOf, setAutoReply } from "./controls";
import { readAll, REJECTIONS_KEY, update } from "./store";
import type { Conv, Rejections } from "./types";
import { armedOf, kickPendingWakes, runWake, type Armed } from "./wake";

type Json = Record<string, unknown>;
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

export function adminAuthorized(ctx: Ctx, req: Request): boolean {
  return tokenOk(bearerOf(req), ctx.cfg.adminToken);
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="admin"' },
  });

function summary(c: Conv, now: number): Json {
  const outs = Object.values(c.outs).sort((a, b) => b.createdAt - a.createdAt);
  return {
    id: c.id,
    name: c.name ?? null,
    wa_id: c.wa_id,
    state: c.state,
    unhandled: c.unhandled,
    last_inbound_at: iso(c.lastInboundAt),
    window_open: windowOpen(c, now),
    wake: {
      status: c.wake.status,
      failures: c.wake.status === "failed" ? c.wake.attempts : 0,
      next_retry_at: iso(c.wake.nextRetryAt),
    },
    last_reply_status: outs[0]?.status ?? null,
    escalation_reason: c.escalation?.reason ?? null,
    hold_reason: c.hold?.reason ?? null,
    updated_at: iso(c.updatedAt),
  };
}

export async function adminGet(ctx: Ctx, req: Request): Promise<Response> {
  if (!adminAuthorized(ctx, req)) return unauthorized();
  const now = ctx.now();
  const convId = new URL(req.url).searchParams.get("conversation");
  if (convId) {
    const r = CONV_ID_RE.test(convId) ? await ctx.store.get<Conv>(convKeyOf(convId)) : null;
    if (!r) return Response.json({ error: "not_found" }, { status: 404 });
    const c = normalize(structuredClone(r.value), now);
    // The lease is a credential for the MCP tools; never expose it.
    c.lease = undefined;
    c.messages = c.messages.slice(-50);
    return Response.json(c);
  }
  const { snap, items } = await readAll<Conv>(ctx.store, "conv/", [CONTROLS_KEY, REJECTIONS_KEY]); // whole overview = 1 read
  const controls = controlsOf(snap);
  const rej = snap.get<Rejections>(REJECTIONS_KEY);
  const conversations = items
    .map((r) => summary(normalize(structuredClone(r.value), now), now))
    .sort((a, b) => String(b.last_inbound_at ?? "").localeCompare(String(a.last_inbound_at ?? "")));
  return Response.json({
    controls: { auto_reply: controls.autoReply, launch_mode: ctx.cfg.launchMode },
    rejections: { count: (rej?.value.count ?? 0) + ctx.state.rejPending, last: iso(rej?.value.last) },
    conversations,
  });
}

const bad = () => Response.json({ error: "bad request" }, { status: 400 });

/**
 * Erase ONE conversation (customer number, profile name, message text, reply records, wake log, lease) in a single commit.
 * Shared by `POST /api/admin {action:"delete_conversation"}` and `DELETE /api/admin/conversations/<id>`.
 * The record is flagged and the store drops it in that same commit (see compactConv). Not touched: global controls and the
 * bad-signature counter (no customer data), Workers Logs (ids and counters only), Durable Object point-in-time-recovery copies.
 */
export async function eraseConversationResult(ctx: Ctx, id: string, via: "admin_api" | "admin_mcp" = "admin_api"): Promise<{ status: number; body: Json }> {
  const r = await update<Conv, Json>(ctx, convKeyOf(id), (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    c.deleted = true;
    c.lease = undefined;
    c.leaseExpiry = undefined;
    c.updatedAt = ctx.now();
    return { next: c, result: { ok: true, deleted: true } };
  });
  ctx.log("admin", { action: "delete_conversation", conv: id, ok: r.result.ok === true, via });
  return { status: r.result.error === "not_found" ? 404 : 200, body: r.result };
}

async function eraseConversation(ctx: Ctx, id: string): Promise<Response> {
  const r = await eraseConversationResult(ctx, id);
  return Response.json(r.body, { status: r.status });
}

/** DELETE /api/admin/conversations/<id> (Bearer ADMIN_TOKEN): per-conversation erase. 200 {ok,deleted}, 400 bad id, 401, 404. */
export async function adminErase(ctx: Ctx, req: Request, id: string): Promise<Response> {
  if (!adminAuthorized(ctx, req)) return unauthorized();
  if (!CONV_ID_RE.test(id)) return bad();
  return eraseConversation(ctx, id);
}

export async function adminPost(ctx: Ctx, req: Request): Promise<Response> {
  if (!adminAuthorized(ctx, req)) return unauthorized();
  let body: { action?: string; value?: string; conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return bad();
  }
  const action = body?.action;
  if (action === "set_auto_reply") {
    if (body.value !== "paused" && body.value !== "active") return bad();
    await setAutoReply(ctx, body.value);
    ctx.log("admin", { action, value: body.value });
    const kicked = body.value === "active" ? await kickPendingWakes(ctx) : 0;
    return Response.json({ ok: true, auto_reply: body.value, woken: kicked });
  }
  const id = body?.conversation_id;
  if (typeof id !== "string" || !CONV_ID_RE.test(id)) return bad();
  const known = ["takeover", "release", "release_hold", "reopen", "resolve", "wake", "delete_conversation"];
  if (!action || !known.includes(action)) return bad();

  if (action === "delete_conversation") return eraseConversation(ctx, id);

  let fire: Armed | null = null;
  const r = await update<Conv, Json>(ctx, convKeyOf(id), (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    const now = ctx.now();
    normalize(c, now);
    c.updatedAt = now;
    switch (action) {
      case "takeover":
        c.prevState = c.state === "human_takeover" ? c.prevState : c.state;
        c.state = "human_takeover";
        c.lease = undefined;
        c.leaseExpiry = undefined;
        return { next: c, result: { ok: true, state: c.state } };
      case "release":
        if (c.state !== "human_takeover" && c.state !== "escalated") {
          return { next: undefined, result: { ok: false, error: "not_in_takeover" } };
        }
        c.state = "replied";
        c.unhandled = 0;
        c.escalation = undefined;
        return { next: c, result: { ok: true, state: c.state } };
      case "release_hold":
        if (c.state !== "held_for_review") return { next: undefined, result: { ok: false, error: "not_held" } };
        c.state = "replied";
        c.hold = undefined;
        return { next: c, result: { ok: true, state: c.state } };
      case "reopen":
        if (c.state !== "escalated" && c.state !== "human_takeover") {
          return { next: undefined, result: { ok: false, error: "not_escalated" } };
        }
        c.state = "pending";
        c.escalation = undefined;
        return { next: c, result: { ok: true, state: c.state } };
      case "resolve":
        c.state = "replied";
        c.unhandled = 0;
        c.lease = undefined;
        c.leaseExpiry = undefined;
        c.escalation = undefined;
        return { next: c, result: { ok: true, state: c.state } };
      default: // wake
        if (c.state !== "pending") return { next: undefined, result: { ok: false, error: "not_pending_or_in_flight" } };
        armWake(c, now, now, true);
        fire = armedOf(c);
        return { next: c, result: { ok: true } };
    }
  });
  ctx.log("admin", { action, conv: id, ok: r.result.ok === true });
  const f = fire as Armed | null;
  if (f && r.wrote) ctx.schedule(() => runWake(ctx, f));
  const status = r.result.error === "not_found" ? 404 : 200;
  return Response.json(r.result, { status });
}
