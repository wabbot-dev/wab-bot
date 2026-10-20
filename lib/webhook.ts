import { tokenOk, verifySignature } from "./crypto";
import type { Ctx } from "./ctx";
import { armWake, capMessages, convId, convKeyOf, MAX_SEEN_IDS, newConv, normalize, seenKey } from "./conv";
import { normDigits, servesNumber } from "./config";
import { isStoreBusy, REJECTIONS_KEY, update } from "./store";
import type { Conv, Msg, OutRec } from "./types";
import { fallbackText, pendingText, runMediaJob, wantsMedia, type MediaJob, type RawMedia } from "./media";
import { armedOf, maybeRetryInBackground, runWake, type Armed } from "./wake";

export { REJECTIONS_KEY };
const IGNORED_TYPES = new Set(["system", "unsupported", "errors"]);
const MAX_TEXT = 4000;

/** Row that remembers the last successful subscribe handshake (read by the admin MCP get_status; contains no secrets). */
export const VERIFY_KEY = "meta/verify";
export interface VerifyRec { at: number; count: number }

/** Persist "Meta (or someone holding the verify token) completed the handshake". Best effort, off the response path. */
export function recordHandshake(ctx: Ctx): void {
  ctx.schedule(async () => {
    try {
      await update<VerifyRec, null>(ctx, VERIFY_KEY, (cur) => ({ next: { at: ctx.now(), count: (cur?.count ?? 0) + 1 }, result: null }));
    } catch {
      /* status only: never fail a handshake over it */
    }
  }, "maintenance");
}

/** GET /api/webhook: Meta subscribe handshake. */
export function handleVerify(ctx: Ctx, url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge !== null && tokenOk(token, ctx.cfg.waVerifyToken)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * Count a rejected webhook WITHOUT touching the store: the count lives in memory and the store merges it into
 * the next essential write (row-store.ts), so a flood of forged requests costs zero put()s.
 */
function recordRejection(ctx: Ctx) {
  ctx.state.rejPending++;
  ctx.state.rejLast = ctx.now();
  ctx.log("webhook_signature_rejected", { pending: ctx.state.rejPending });
}

interface RawMsg {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  button?: { text?: string };
  image?: RawMedia;
  audio?: RawMedia;
  video?: { caption?: string };
  document?: { caption?: string };
  reaction?: { emoji?: string };
  location?: { name?: string };
}

/** Text we store for a message (never downloads media). */
export function extractText(m: RawMsg): string {
  const t = m.type ?? "unknown";
  let s: string | undefined;
  switch (t) {
    case "text": s = m.text?.body; break;
    case "interactive": s = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title; break;
    case "button": s = m.button?.text; break;
    case "image": s = m.image?.caption; break;
    case "video": s = m.video?.caption; break;
    case "document": s = m.document?.caption; break;
    case "reaction": return `[reaction ${m.reaction?.emoji ?? ""}]`.replace(" ]", "]");
    case "location": s = m.location?.name ? `[location: ${m.location.name}]` : "[location]"; break;
  }
  if (s === undefined || s === "") s = `[${t} without text]`;
  return s.slice(0, MAX_TEXT);
}

interface StatusEv {
  id?: string;
  status?: string;
  recipient_id?: string;
  biz_opaque_callback_data?: string;
  errors?: { code?: number }[];
}

export interface Incoming {
  id: string;
  type: string;
  text: string;
  ts: number;
  name?: string;
  /** set for an audio/image message that will be transcribed/described in the background (lib/media.ts) */
  media?: Omit<MediaJob, "convId" | "msgId">;
}

/** A voice note waits for its transcript before the agent is woken: the wake is armed this far out and fired early when the job ends. */
export const MEDIA_WAKE_WAIT_MS = 25000;

/**
 * Inbound audio/image with media understanding on: a background job will replace the placeholder text. Without the AI binding or
 * the WhatsApp token the fallback marker is stored at once (no job, no delay).
 */
function mediaIncoming(ctx: Ctx, m: RawMsg, base: Incoming): Incoming {
  const kind = wantsMedia(ctx, base.type);
  if (!kind) return base;
  const raw = kind === "audio" ? m.audio : m.image;
  const caption = kind === "image" && raw?.caption ? String(raw.caption).slice(0, 1000) : undefined;
  const job = { kind, voice: kind === "audio" && raw?.voice === true, caption, mediaId: typeof raw?.id === "string" ? raw.id : undefined, mime: typeof raw?.mime_type === "string" ? raw.mime_type : undefined };
  if (!ctx.ai || !ctx.cfg.waAccessToken || !job.mediaId) {
    return { ...base, text: fallbackText(job) };
  }
  return { ...base, text: pendingText(job), media: job };
}

/** Opt-out keywords (whole message, trimmed, case-insensitive). START clears an opt-out. */
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "ARRET", "ARRÊT", "إيقاف"]);
const OPT_TYPES = new Set(["text", "button", "interactive"]);
export function optKeyword(type: string, text: string): "stop" | "start" | null {
  if (!OPT_TYPES.has(type)) return null;
  const t = text.trim().replace(/[.!]+$/, "").toLocaleUpperCase();
  if (STOP_WORDS.has(t)) return "stop";
  if (t === "START") return "start";
  return null;
}

function tsMs(sec: string | undefined, now: number): number {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? Math.min(now, n * 1000) : now;
}

export async function applyInbound(
  ctx: Ctx,
  meta: { pn: string; waba: string; wa: string },
  incoming: Incoming[],
  /** selftest: owner media self-test (lib/admin.ts): arm no wake and leave the returned jobs to the caller */
  opts: { selftest?: boolean } = {},
): Promise<{ added: number; dup: number; conv: string; jobs: MediaJob[] }> {
  const id = convId(meta.pn, meta.waba, meta.wa);
  const r = await update<Conv, { added: number; dup: number; armed: Armed | null; jobs: MediaJob[] }>(ctx, convKeyOf(id), (cur) => {
    const now = ctx.now();
    const c = cur ?? newConv(meta.pn, meta.waba, meta.wa, now);
    normalize(c, now);
    const was = c.state;
    let added = 0;
    let dup = 0;
    let wakeable = false;
    const jobs: MediaJob[] = [];
    for (const m of incoming) {
      const sk = seenKey(m.id);
      if (c.seenIds.includes(sk)) { dup++; continue; }
      added++;
      c.seenIds.push(sk);
      const reaction = m.type === "reaction";
      const msg: Msg = { id: m.id, dir: "in", type: m.type, text: m.text, ts: m.ts };
      if (m.media) {
        msg.media = { kind: m.media.kind, st: "pending" };
        jobs.push({ ...m.media, convId: id, msgId: m.id });
      }
      if (!reaction) {
        msg.seq = ++c.inSeq;
        c.lastInboundAt = Math.max(c.lastInboundAt ?? 0, m.ts);
      }
      c.messages.push(msg);
      if (m.name) c.name = m.name;
      // The message is still stored and still wakes the agent (it may confirm); only bot-started sends are refused while opted out.
      const kw = optKeyword(m.type, m.text);
      if (kw === "stop") c.optOut = { at: m.ts, via: "customer" };
      else if (kw === "start") c.optOut = undefined;
      if (ctx.cfg.wakeTypes.includes(m.type)) { c.unhandled++; wakeable = true; }
    }
    if (c.seenIds.length > MAX_SEEN_IDS) c.seenIds.splice(0, c.seenIds.length - MAX_SEEN_IDS);
    capMessages(c, ctx.cfg.maxMessages);
    if (added === 0) return { next: undefined, result: { added, dup, armed: null, jobs: [] } };
    let armed: Armed | null = null;
    if (wakeable && c.state === "replied") c.state = "pending";
    // a conversation that just (re)entered "pending" always gets a fresh wake; inside a burst the first one stands.
    // With a voice note/image being understood, the wake waits for the job (which fires it early) up to MEDIA_WAKE_WAIT_MS.
    const due = now + (jobs.length ? Math.max(ctx.cfg.wakeDebounceMs, MEDIA_WAKE_WAIT_MS) : ctx.cfg.wakeDebounceMs);
    if (!opts.selftest && wakeable && c.state === "pending" && armWake(c, now, due, was !== "pending" || jobs.length > 0)) armed = armedOf(c);
    c.updatedAt = now;
    return { next: c, result: { added, dup, armed, jobs } };
  });
  ctx.log("inbound", { conv: id, added: r.result.added, dup: r.result.dup, armed: !!r.result.armed, media: r.result.jobs.length });
  // One background job per NEW media message (a redelivery was deduped above and gets none). It fires the wake early when done.
  if (!opts.selftest) for (const j of r.result.jobs) ctx.schedule(async () => { await runMediaJob(ctx, j); });
  const armed = r.result.armed;
  if (armed) ctx.schedule(() => runWake(ctx, armed));
  return { added: r.result.added, dup: r.result.dup, conv: id, jobs: r.result.jobs };
}

function findOut(c: Conv, wamid: string | undefined, rk: string | undefined): OutRec | undefined {
  if (rk && c.outs[rk]) return c.outs[rk];
  if (wamid) return Object.values(c.outs).find((o) => o.wamid === wamid);
  return undefined;
}

/**
 * Status events never wake and never trigger replies. To save writes, only two kinds are
 * persisted: 'failed', and any status for a send whose outcome is uncertain (reconcile).
 * Plain sent/delivered/read for a normal send cost 0 writes (and 0 reads when this instance sent it).
 */
async function applyStatus(ctx: Ctx, meta: { pn: string; waba: string }, st: StatusEv) {
  if (!st.recipient_id || !st.status) return;
  const rk0 = /^rk:(.+)$/.exec(st.biz_opaque_callback_data ?? "")?.[1];
  // A send this instance saw succeed: its sent/delivered/read receipts change nothing, skip even the read.
  if (st.status !== "failed" && rk0 && ctx.state.confirmed.has(rk0)) return;
  const id = convId(meta.pn, meta.waba, st.recipient_id);
  const key = convKeyOf(id);
  const cur = await ctx.store.get<Conv>(key);
  if (!cur) return;
  const rk = /^rk:(.+)$/.exec(st.biz_opaque_callback_data ?? "")?.[1];
  const o = findOut(cur.value, st.id, rk);
  if (!o) return;
  const matters = st.status === "failed" || o.status === "uncertain" || o.status === "sending";
  if (!matters) return;
  await update<Conv, null>(ctx, key, (c) => {
    if (!c) return { next: undefined, result: null };
    const out = findOut(c, st.id, rk);
    if (!out) return { next: undefined, result: null };
    const now = ctx.now();
    if (st.status === "failed") {
      out.status = "failed";
      out.error = `status_failed_${st.errors?.[0]?.code ?? "unknown"}`;
    } else if (st.status === "sent" || st.status === "delivered" || st.status === "read") {
      if (out.status === "uncertain" || out.status === "sending") out.status = st.status;
    }
    if (st.id) out.wamid = st.id;
    out.updatedAt = now;
    const msg = c.messages.find((m) => m.rk === out.key);
    if (msg) {
      msg.status = out.status;
      if (st.id) msg.id = st.id;
    }
    c.updatedAt = now;
    return { next: c, result: null };
  });
  ctx.log("status_applied", { conv: id, status: st.status });
}

/**
 * Meta call webhooks (field "calls": SIP call_created / terminate), only with CALL_SIP_WEBHOOKS=1 (a test aid, off by default). Nothing is stored:
 * one log line per event with the event type, Meta's call id, status, direction, duration, Meta's timestamps and an error code. No phone numbers, names or SDP.
 */
const short = (x: unknown, n = 40) => (typeof x === "string" || typeof x === "number" ? String(x).slice(0, n) : null);
function logCallEvents(ctx: Ctx, v: any): void {
  if (!ctx.cfg.callSipWebhooks || !Array.isArray(v?.calls)) return;
  const pn = String(v?.metadata?.phone_number_id ?? "");
  if (pn && !servesNumber(ctx.cfg, pn)) return;
  for (const c of v.calls.slice(0, 10)) {
    ctx.log("meta_call_event", {
      event: short(c?.event), call_id: short(c?.id, 80), status: short(c?.status), direction: short(c?.direction), duration: short(c?.duration),
      ts: short(c?.timestamp), start: short(c?.start_time), end: short(c?.end_time), err: short(c?.errors?.[0]?.code),
    });
  }
}

/** POST /api/webhook */
export async function handleWebhookPost(ctx: Ctx, req: Request): Promise<Response> {
  // HMAC is computed over the exact received bytes (no decode/re-encode round trip), then the same bytes are parsed.
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), ctx.cfg.waAppSecret)) {
    recordRejection(ctx);
    return new Response("invalid signature", { status: 401 });
  }
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }
  try {
    if (body?.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const waba = String(entry?.id ?? "");
        for (const ch of entry?.changes ?? []) {
          if (ch?.field === "calls") { logCallEvents(ctx, ch.value); continue; }
          if (ch?.field !== "messages") continue;
          const v = ch.value ?? {};
          const pn = String(v.metadata?.phone_number_id ?? "");
          if (!pn) continue;
          if (!servesNumber(ctx.cfg, pn)) { ctx.log("webhook_number_not_served", { configured: ctx.cfg.phoneNumberIds.length }); continue; }
          const own = normDigits(String(v.metadata?.display_phone_number ?? ""));
          const names = new Map<string, string>();
          for (const c of v.contacts ?? []) if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
          const byWa = new Map<string, Incoming[]>();
          const now = ctx.now();
          for (const m of (v.messages ?? []) as RawMsg[]) {
            if (!m?.id || !m.from) continue;
            const type = m.type ?? "unknown";
            if (IGNORED_TYPES.has(type)) continue;
            const from = normDigits(m.from);
            if (from === pn || (own && from === own)) continue; // echo of our own number
            const list = byWa.get(from) ?? [];
            list.push(mediaIncoming(ctx, m, { id: m.id, type, text: extractText(m), ts: tsMs(m.timestamp, now), name: names.get(from) }));
            byWa.set(from, list);
          }
          // Started together so the store coalesces them into ONE put (group commit); every one is awaited before answering.
          const jobs: Promise<unknown>[] = [];
          for (const [wa, list] of byWa) jobs.push(applyInbound(ctx, { pn, waba, wa }, list));
          for (const st of (v.statuses ?? []) as StatusEv[]) jobs.push(applyStatus(ctx, { pn, waba }, st));
          const settled = await Promise.allSettled(jobs);
          const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failed) throw failed.reason;
        }
      }
    }
  } catch (e) {
    if (isStoreBusy(e)) {
      // Conflicts only: nothing was lost. Answer retryable; Meta redelivers the same payload and wamid dedupe makes it idempotent.
      ctx.log("webhook_busy", { err: e instanceof Error ? e.message.slice(0, 60) : "unknown" });
      return new Response("busy, retry", { status: 503, headers: { "Retry-After": "2" } });
    }
    ctx.log("webhook_error", { err: e instanceof Error ? e.message.slice(0, 60) : "unknown" });
    return new Response("retry", { status: 500 });
  }
  maybeRetryInBackground(ctx);
  return Response.json({ ok: true });
}
