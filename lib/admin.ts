import { decidePayment, deleteContact, listContacts, upsertContact } from "./business";
import { alertsConfigured, sendAlert } from "./alerts";
import { bearerOf, tokenOk } from "./crypto";
import type { Ctx } from "./ctx";
import { CONV_ID_RE, armWake, convKeyOf, normalize, windowOpen } from "./conv";
import { CONTROLS_KEY, controlsOf, setAutoReply } from "./controls";
import { readAll, REJECTIONS_KEY, update } from "./store";
import type { Conv, Rejections } from "./types";
import { armedOf, kickPendingWakes, runWake, type Armed } from "./wake";
import { createInvite, redeemInvite, SESSION_MS, sessionCookie, sessionOf, sessionValue } from "./staff";
import { staffReply, startConversation } from "./tools";
import { randomHex } from "./crypto";
import { runMediaJob, safeFilename, wantsMedia } from "./media";
import { applyInbound } from "./webhook";
import { claimConversation, getHistory, sendReply } from "./tools";
import { isMonoOggOpus, synthesize, uploadVoice } from "./voice-reply";

type Json = Record<string, unknown>;
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/** Bearer ADMIN_TOKEN only (owner / owner's bot). Required for invites and anything outside the inbox. */
export const ownerAuthorized = (ctx: Ctx, req: Request): boolean => tokenOk(bearerOf(req), ctx.cfg.adminToken);

/**
 * Inbox access: the owner's bearer token, OR a staff session cookie (lib/staff.ts). A cookie alone may read; a changing request
 * made with the cookie must also carry `X-Staff-Request: 1`, which a cross-site page cannot add without a CORS preflight.
 */
export function adminAuthorized(ctx: Ctx, req: Request): boolean {
  if (ownerAuthorized(ctx, req)) return true;
  if (sessionOf(req, ctx.cfg.adminToken, ctx.now()) === null) return false;
  return req.method === "GET" || req.method === "HEAD" || req.headers.get("x-staff-request") === "1";
}

const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/** POST /api/staff/login {code}: redeem a one-time invite, set the session cookie. Same 401 for every failure. */
export async function staffLogin(ctx: Ctx, req: Request): Promise<Response> {
  let code: unknown;
  try { code = ((await req.json()) as { code?: unknown })?.code; } catch { /* fall through */ }
  const ok = typeof code === "string" && !!ctx.cfg.adminToken && ctx.cfg.adminToken.length >= 16 && (await redeemInvite(ctx, code));
  if (!ok) return new Response(JSON.stringify({ ok: false, error: "invalid_or_used_code" }), { status: 401, headers: JSONH });
  const exp = ctx.now() + SESSION_MS;
  return new Response(JSON.stringify({ ok: true, expires_at: new Date(exp).toISOString() }), {
    status: 200, headers: { ...JSONH, "Set-Cookie": sessionCookie(sessionValue(ctx.cfg.adminToken!, exp), Math.floor(SESSION_MS / 1000)) },
  });
}

export function staffLogout(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...JSONH, "Set-Cookie": sessionCookie("", 0) } });
}

/** GET /api/staff/session: is this browser signed in (cookie) or holding the owner token? */
export function staffSession(ctx: Ctx, req: Request): Response {
  const exp = sessionOf(req, ctx.cfg.adminToken, ctx.now());
  const owner = ownerAuthorized(ctx, req);
  return new Response(JSON.stringify({ ok: exp !== null || owner, via: owner ? "owner_token" : exp !== null ? "staff_session" : null, expires_at: exp ? new Date(exp).toISOString() : null }), { status: exp !== null || owner ? 200 : 401, headers: JSONH });
}

/** POST /api/admin/start-conversation (Bearer ADMIN_TOKEN): owner-run bot-started messages through the SAME guarded function as the MCP tool. */
export async function adminStartConversation(ctx: Ctx, req: Request): Promise<Response> {
  if (!ownerAuthorized(ctx, req)) return unauthorized();
  let b: Record<string, unknown>;
  try { b = (await req.json()) as Record<string, unknown>; } catch { return bad(); }
  const s = (k: string, max: number) => (typeof b[k] === "string" && (b[k] as string).length <= max ? (b[k] as string) : undefined);
  const tp = Array.isArray(b.template_params) && b.template_params.length <= 20 && b.template_params.every((x) => typeof x === "string" && x.length <= 1000) ? (b.template_params as string[]) : undefined;
  const r = await startConversation(ctx, {
    conversation_id: s("conversation_id", 24), to: s("to", 24), text: s("text", 4000), template_name: s("template_name", 100),
    template_language: s("template_language", 20), template_params: tp, idempotency_key: s("idempotency_key", 100),
  });
  ctx.log("admin", { action: "start_conversation", ok: r.ok === true, err: r.ok === true ? undefined : String(r.error ?? "") });
  return Response.json(r);
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="admin"' },
  });

/** Short preview of the newest message for the inbox list (staff are authorised to see the conversation). */
function lastMessage(c: Conv): Json | null {
  const m = c.messages[c.messages.length - 1];
  return m ? { from: m.dir === "in" ? "customer" : "business", at: iso(m.ts), type: m.type, preview: m.text.slice(0, 120) } : null;
}

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
    opted_out: !!c.optOut,
    needs_human: c.state === "escalated" || c.state === "held_for_review" || (c.state === "human_takeover" && c.unhandled > 0),
    last_message: lastMessage(c),
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
    return Response.json({ ...c, opted_out: !!c.optOut, window_open: windowOpen(c, now) });
  }
  const { snap, items } = await readAll<Conv>(ctx.store, "conv/", [CONTROLS_KEY, REJECTIONS_KEY]); // whole overview = 1 read
  const controls = controlsOf(snap);
  const rej = snap.get<Rejections>(REJECTIONS_KEY);
  const conversations = items
    .map((r) => summary(normalize(structuredClone(r.value), now), now))
    .sort((a, b) => String(b.last_inbound_at ?? "").localeCompare(String(a.last_inbound_at ?? "")));
  return Response.json({
    controls: { auto_reply: controls.autoReply, launch_mode: ctx.cfg.launchMode, template_allowlist: ctx.cfg.templateAllowlist },
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
  let body: { action?: string; value?: string; conversation_id?: string; text?: string; template_name?: string; template_language?: string; idempotency_key?: string; ttl_minutes?: number; media?: unknown; contact?: Record<string, unknown>; number?: string; tag?: string; known?: boolean; offset?: number };
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
  if (action === "test_alert") {
    // owner only: one test alert to every configured channel (docs/ALERTS.md); no conversation, no customer
    if (!ownerAuthorized(ctx, req)) return unauthorized();
    if (!alertsConfigured(ctx)) return Response.json({ ok: false, error: "alerts_not_configured" });
    const rec = await sendAlert(ctx, { event: "test", reason: "test alert from the admin page" });
    return Response.json({ ok: !!rec, webhook: rec?.webhook ?? null, whatsapp: rec?.whatsapp ?? null });
  }
  if (action === "contact_upsert" || action === "contact_delete" || action === "contact_list") {
    // the account directory (docs/BUSINESS-MODE.md) is the OWNER's: staff sessions can read conversations but not change who is a known account
    if (!ownerAuthorized(ctx, req)) return unauthorized();
    const r = action === "contact_upsert"
      ? await upsertContact(ctx, typeof body.contact === "object" && body.contact ? body.contact : {})
      : action === "contact_delete"
        ? await deleteContact(ctx, body.number)
        : await listContacts(ctx, { tag: typeof body.tag === "string" ? body.tag : undefined, known: typeof body.known === "boolean" ? body.known : undefined, offset: Number.isInteger(body.offset) ? Math.max(0, body.offset!) : 0, limit: 100 });
    ctx.log("admin", { action, ok: r.ok === true });
    return Response.json(r, { status: r.ok === true ? 200 : 400 });
  }
  if (action === "staff_invite") {
    if (!ownerAuthorized(ctx, req)) return unauthorized(); // a staff session can never mint more sessions
    const inv = await createInvite(ctx, typeof body.ttl_minutes === "number" ? body.ttl_minutes : 15);
    return Response.json({ ok: true, ...inv, sign_in_at: new URL("/admin", req.url).toString(), note: "One-time code: valid once, until expires_at. It is not the admin token." });
  }
  const id = body?.conversation_id;
  if (typeof id !== "string" || !CONV_ID_RE.test(id)) return bad();
  const known = ["takeover", "release", "release_hold", "reopen", "resolve", "wake", "delete_conversation", "reply", "opt_out", "opt_in", "payment_verify"];
  if (!action || !known.includes(action)) return bad();

  if (action === "delete_conversation") return eraseConversation(ctx, id);
  if (action === "payment_verify") {
    const r = await decidePayment(ctx, convKeyOf(id), String(body.value ?? ""));
    ctx.log("admin", { action, conv: id, ok: r.ok === true });
    return Response.json(r, { status: r.error === "not_found" ? 404 : 200 });
  }
  if (action === "reply") {
    const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
    const r = await staffReply(ctx, { conversation_id: id, text: str(body.text, 4000), template_name: str(body.template_name, 100), template_language: str(body.template_language, 20), idempotency_key: str(body.idempotency_key, 100), media: body.media });
    ctx.log("admin", { action, conv: id, ok: r.ok === true });
    return Response.json(r, { status: r.error === "not_found" ? 404 : 200 });
  }

  let fire: Armed | null = null;
  const r = await update<Conv, Json>(ctx, convKeyOf(id), (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    const now = ctx.now();
    normalize(c, now);
    c.updatedAt = now;
    switch (action) {
      case "opt_out":
        c.optOut = { at: now, via: "staff" };
        return { next: c, result: { ok: true, opted_out: true } };
      case "opt_in":
        if (!c.optOut) return { next: undefined, result: { ok: true, opted_out: false } };
        c.optOut = undefined;
        return { next: c, result: { ok: true, opted_out: false } };
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

/** Fake, reserved-range customer number of the media self-test conversation (never a real person). */
export const SELFTEST_WA = "15550100099";

/**
 * POST /api/admin/media-selftest?kind=audio|image|document[&voice=1][&caption=...][&filename=...][&via=graph] (Bearer ADMIN_TOKEN only; 404 unless MEDIA_SELFTEST=1).
 * via=graph first uploads the sample to the number's own Meta media store and then downloads it by media id (the real webhook path).
 * The body is the media file itself (sample audio or image). It runs the SAME understanding path as a WhatsApp message (caps,
 * Workers AI, fallback, counters) and stores the result as an inbound message in a self-test conversation with a fake number,
 * WITHOUT waking the agent. Read it with get_history (or the inbox), then erase it with delete_conversation. Nothing is sent to
 * WhatsApp and the bytes are never stored. Answers status codes only, never the transcript.
 */
export async function adminMediaSelftest(ctx: Ctx, req: Request): Promise<Response> {
  if (!ctx.cfg.mediaSelftest) return Response.json({ error: "not_found" }, { status: 404 });
  if (!ownerAuthorized(ctx, req)) return unauthorized();
  const url = new URL(req.url);
  const k = url.searchParams.get("kind");
  const type = k === "image" || k === "audio" || k === "document" ? k : null;
  if (!type) return bad();
  const kind = wantsMedia(ctx, type);
  if (!kind) return Response.json({ ok: false, error: "feature_off" });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 16_000_000) return bad();
  const caption = kind !== "audio" ? url.searchParams.get("caption")?.slice(0, 1000) || undefined : undefined;
  const filename = kind === "document" ? safeFilename(url.searchParams.get("filename") ?? "sample.pdf") : undefined;
  const voice = kind === "audio" && url.searchParams.get("voice") === "1";
  const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim() || undefined;
  const id = `selftest.${randomHex(8)}`;
  let job: { kind: typeof kind; voice: boolean; caption?: string; mime?: string; bytes?: Uint8Array; mediaId?: string; filename?: string } = { kind, voice, caption, mime, bytes, ...(filename ? { filename } : {}) };
  if (url.searchParams.get("via") === "graph") {
    // Exercise the REAL webhook download path: upload the sample to this number's own Meta media store (no message is sent; Meta
    // keeps uploads for 30 days), then let the job fetch it back by media id with the stored token, exactly as for a customer's file.
    const pnid = ctx.cfg.phoneNumberIds[0];
    if (!pnid || !ctx.cfg.waAccessToken) return Response.json({ ok: false, error: "needs_phone_number_id_and_token" });
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mime ?? "application/octet-stream");
    form.set("file", new Blob([bytes as unknown as ArrayBuffer], { type: mime ?? "application/octet-stream" }), kind === "image" ? "sample.jpg" : kind === "document" ? (filename ?? "sample.pdf") : "sample.ogg");
    let up: Response;
    try {
      up = await ctx.fetch(`https://graph.facebook.com/${ctx.cfg.graphVersion}/${encodeURIComponent(pnid)}/media`, { method: "POST", headers: { Authorization: `Bearer ${ctx.cfg.waAccessToken}` }, body: form });
    } catch {
      return Response.json({ ok: false, error: "upload_network" });
    }
    const uj = (await up.json().catch(() => ({}))) as { id?: unknown };
    if (!up.ok || typeof uj.id !== "string") return Response.json({ ok: false, error: `upload_http_${up.status}` });
    job = { kind, voice, caption, mime, mediaId: uj.id, ...(filename ? { filename } : {}) };
  }
  const pn = ctx.cfg.phoneNumberIds[0] ?? "selftest";
  const r = await applyInbound(ctx, { pn, waba: ctx.cfg.wabaId ?? "selftest", wa: SELFTEST_WA }, [
    { id, type, text: "", ts: ctx.now(), name: "media self-test", media: job },
  ], { selftest: true });
  const j = r.jobs[0];
  if (!j) return Response.json({ ok: false, error: "not_added" });
  const o = await runMediaJob(ctx, j, { wake: false });
  ctx.log("admin", { action: "media_selftest", kind, ok: o?.ok === true });
  return Response.json({ ok: o?.ok === true, conversation_id: r.conv, message_id: id, media_status: o?.media.st ?? null, reason: o?.ok === false ? o.code : null, language: o?.media.lang ?? null });
}

/**
 * Owner-only voice-reply self-test (404 unless MEDIA_SELFTEST=1; docs/VOICE-REPLIES.md). Body: the reply text (UTF-8, up to 1500
 * characters). Query: lang (two letters, required), where=do (default, the production path) or worker (encode in this request,
 * to measure its CPU limit), upload=1 (upload to this number's Meta media store and read back Meta's mime type and size; nothing is
 * sent), audio=1 (return the Ogg file itself instead of JSON, to inspect it), send=1&to=<digits> (ONE real voice reply through the
 * full send_reply path to a TEST_RECIPIENTS number, test mode only, on a self-test conversation that is erased afterwards).
 * Returns status, sizes and timings only.
 */
export async function adminVoiceSelftest(ctx: Ctx, req: Request): Promise<Response> {
  if (!ctx.cfg.mediaSelftest) return Response.json({ error: "not_found" }, { status: 404 });
  if (!ownerAuthorized(ctx, req)) return unauthorized();
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  const lang = q("lang") ?? "";
  const text = (await req.text()).trim();
  if (!/^[a-z]{2}$/.test(lang) || !text || text.length > 1500) return bad();
  const pn = ctx.cfg.phoneNumberIds[0];
  if (q("send") === "1") {
    const to = (q("to") ?? "").replace(/\D/g, "");
    if (ctx.cfg.launchMode === "live" || !ctx.cfg.testRecipients.includes(to)) return Response.json({ ok: false, error: "send_only_to_test_recipients_in_test_mode" });
    if (!pn) return Response.json({ ok: false, error: "needs_phone_number_id" });
    const vctx: Ctx = { ...ctx, cfg: { ...ctx.cfg, voiceReplies: "mirror" } };
    const r = await applyInbound(vctx, { pn, waba: ctx.cfg.wabaId ?? "selftest", wa: to }, [
      { id: `selftest.${randomHex(8)}`, type: "audio", text: `[voice note, transcribed, language: ${lang}] (voice reply self-test)`, ts: ctx.now(), name: "voice self-test" },
    ], { selftest: true });
    const cl = await claimConversation(vctx, r.conv);
    if (cl.ok !== true) return Response.json({ ok: false, error: "claim_failed", conversation_id: r.conv });
    await getHistory(vctx, r.conv, String(cl.lease), 5);
    const t0 = Date.now();
    const res = await sendReply(vctx, { conversation_id: r.conv, lease: String(cl.lease), text, voice_language: lang, idempotency_key: `voice-selftest-${randomHex(6)}` });
    const ms = Date.now() - t0;
    const snap = await ctx.store.get<Conv>(convKeyOf(r.conv));
    const sent = snap?.value.messages.filter((m) => m.dir === "out").pop();
    const erased = await eraseConversationResult(ctx, r.conv);
    ctx.log("admin", { action: "voice_selftest_send", ok: res.ok === true });
    return Response.json({ ok: res.ok === true, result: res, message_id: sent?.id ?? null, stored_type: sent?.type ?? null, stored_text_kept: sent?.text === text, wall_ms: ms, erased: erased.status === 200 });
  }
  const where = q("where") === "worker" ? "worker" : "do";
  const t0 = Date.now();
  const s = await synthesize(ctx, text, lang, where === "worker" ? "inline" : "do");
  const t1 = Date.now();
  if (!s.ok) return Response.json({ ok: false, error: s.code, ms: t1 - t0 });
  if (q("audio") === "1") return new Response(s.ogg as unknown as BodyInit, { headers: { "content-type": "audio/ogg; codecs=opus", "cache-control": "no-store" } });
  const el = s.provider === "elevenlabs";
  const out: Json = { ok: true, lang, provider: s.provider ?? "workers-ai", model: el ? ctx.cfg.elevenlabsModelId : s.provider === "xai" ? `xai:${ctx.cfg.xaiTtsVoice}` : ctx.cfg.voiceTtsModel, where: el ? "worker" : where, tts_and_encode_ms: t1 - t0, tts_bytes: s.ttsBytes, ogg_bytes: s.ogg.length, seconds: Math.round(s.seconds * 10) / 10, mono_ogg_opus: isMonoOggOpus(s.ogg), ...(el ? { model: s.modelId ?? ctx.cfg.elevenlabsModelId, voice_id: s.voiceId ?? null, voice_from: s.voiceFrom ?? null, chars_sent: s.chars ?? null, pronunciation_dictionaries: s.dictionaries ?? 0 } : {}) };
  if (q("upload") === "1") {
    if (!pn || !ctx.cfg.waAccessToken) return Response.json({ ...out, ok: false, error: "needs_phone_number_id_and_token" });
    const up = await uploadVoice(ctx, pn, s.ogg);
    if (!up.ok) return Response.json({ ...out, ok: false, error: up.code });
    let meta: { mime_type?: unknown; file_size?: unknown } = {};
    try {
      const r = await ctx.fetch(`https://graph.facebook.com/${ctx.cfg.graphVersion}/${encodeURIComponent(up.id)}`, { headers: { Authorization: `Bearer ${ctx.cfg.waAccessToken}` } });
      meta = (await r.json().catch(() => ({}))) as typeof meta;
    } catch { /* reported as nulls */ }
    out.upload = { media_id_returned: true, meta_mime_type: typeof meta.mime_type === "string" ? meta.mime_type : null, meta_file_size: typeof meta.file_size === "number" ? meta.file_size : null, ms: Date.now() - t1 };
  }
  ctx.log("admin", { action: "voice_selftest", where, provider: s.provider ?? "workers-ai", ogg_bytes: s.ogg.length, ok: true });
  return Response.json(out);
}
