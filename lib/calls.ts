import type { Config } from "./config";
import type { Ctx } from "./ctx";
import { sha256hex } from "./crypto";
import type { DisarmReport, Remote } from "./calls-remote";
import { verifyStandardWebhook } from "./std-webhook";
import { updateMulti } from "./store";
import { XAI_VOICE_USD_PER_MIN, hangupCall } from "./xai-voice";

/**
 * Voice calling, state and the public webhook. Flow (proven live on 2026-10-17, one test-number run): a WhatsApp user calls ->
 * Meta SIP -> sip.voice.x.ai -> xAI POSTs a signed `realtime.call.incoming` to /api/xai-sip -> this handler verifies, applies the
 * owner gate and the caller rules, and starts one CallSession Durable Object, which joins the call's realtime socket (src/call-do.ts,
 * lib/call-runner.ts). xAI bridges the audio; this Worker never touches it and stores no audio. A TEXT transcript is kept by default (CALL_TRANSCRIPTS, owner setting) in this Worker's own Durable Object for CALL_TRANSCRIPT_RETENTION_DAYS.
 *
 * Owner gate (docs/VOICE-CALLS.md): calling is OFF unless the owner sets CALLING_MODE as a Worker binding/var. Live mode additionally needs
 * CALLING_BV_DONE=1 (Business Verification attestation) and CALLING_GO_NUMBER (the one approved number). No MCP tool can change those.
 * Even then the number is only registered at xAI and enabled at Meta inside a short, owner-triggered arm window that closes by itself.
 */

export const ARM_KEY = "calls/arm";
export const INDEX_KEY = "calls/index";
export const usageKey = (now: number) => `calls/usage/${new Date(now).toISOString().slice(0, 7)}`;
export const callKey = (id: string) => `call/${id}`;
export const txKey = (id: string) => `calltx/${id}`;
export const CALL_ID_RE = /^cl_[0-9a-f]{20}$/;
export const MAX_INDEX = 100;
export const CALL_LOG_TTL_SEC = 90 * 86400;
const USAGE_TTL_SEC = 400 * 86400;

export type Json = Record<string, unknown>;

export interface ArmRow {
  state: "arming" | "armed" | "disarmed";
  mode: "test" | "live";
  pnid: string;
  number?: string;
  armedAt: number;
  expiresAt: number;
  maxCalls: number;
  callsStarted: number;
  callsFinished: number;
  xaiPhoneId?: string;
  /** xAI's webhook signing secret (returned once at registration); removed on disarm; read only by the webhook route */
  whSecret?: string;
  prior?: { srtp?: string; codecs: string[] };
  disarmedAt?: number;
  disarmReason?: string;
  disarm?: DisarmReport;
  /** a disarm half failed: the dead-man alarm and the daily cron retry it */
  needsRetry?: boolean;
  retries?: number;
}

export type CallOutcome = "in_progress" | "completed" | "rejected_not_armed" | "rejected_caller" | "rejected_budget" | "failed_to_start";

export interface CallLog {
  id: string;
  startedAt: number;
  endedAt?: number;
  durationS?: number;
  mode: "test" | "live";
  /** last two digits only */
  callerHint: string;
  outcome: CallOutcome;
  endReason?: string;
  /** who hung up when known: "ai" (end_call tool), "limit" (max duration), "caller_or_network", "owner" */
  endedBy?: string;
  turns?: { caller: number; ai: number };
  errors?: number;
  /** present when a transcript row was stored for this call (the text itself is in `calltx/<id>`) */
  transcript?: { lines: number; expiresAt: number; truncated?: boolean };
}

/** one spoken turn: who, seconds since the call started, text (capped by the runner) */
export interface TranscriptLine { who: "caller" | "ai"; atS: number; text: string }
/** the transcript row `calltx/<id>`: separate from the log row so listings stay small; it expires on its own (CALL_TRANSCRIPT_RETENTION_DAYS) */
export interface CallTranscript { lines: TranscriptLine[]; truncated?: boolean }

export interface CallIndex { ids: string[] }
export interface CallUsage { seconds: number; calls: number; rejected: number }

export interface CallHost {
  /** start the Durable Object session for this call; resolves once the session has been started, not when the call ends */
  start(a: { callId: string; logId: string }): Promise<void>;
  /** called after a call's final commit says the arm window is used up (the production host disarms here) */
  afterFinish?(a: { shouldDisarm: boolean }): Promise<void>;
}

export function callingGate(cfg: Config): { ok: boolean; reason?: string } {
  if (cfg.callingMode === "off") return { ok: false, reason: "calling_off" };
  if (!cfg.xaiApiKey && cfg.callSipTarget.kind === "xai") return { ok: false, reason: "xai_key_missing" };
  if (!cfg.waAccessToken || !cfg.callingPhoneNumberId) return { ok: false, reason: "whatsapp_not_configured" };
  if (cfg.callingMode === "test" && cfg.callAllowedCallers.length === 0) return { ok: false, reason: "test_mode_needs_CALL_ALLOWED_CALLERS" };
  if (cfg.callingMode === "live" && (!cfg.callingBvDone || !cfg.callingGoNumber)) return { ok: false, reason: "live_mode_needs_CALLING_BV_DONE_and_CALLING_GO_NUMBER" };
  return { ok: true };
}

export function remoteOf(ctx: Ctx): Remote | null {
  const { waAccessToken, xaiApiKey, graphVersion } = ctx.cfg;
  if (!waAccessToken || (!xaiApiKey && ctx.cfg.callSipTarget.kind === "xai")) return null;
  return { fetch: ctx.fetch, sleep: ctx.sleep, graphVersion, accessToken: waAccessToken, xaiKey: xaiApiKey ?? "" };
}

/** the row the dead-man alarm and disarm write: no secret, optional retry marker */
export function tombstone(arm: ArmRow, report: DisarmReport, now: number, reason: string): ArmRow {
  const failed = report.meta === "failed" || report.xai === "failed";
  const next: ArmRow = {
    ...arm,
    state: "disarmed",
    disarmedAt: now,
    disarmReason: reason,
    disarm: report,
    needsRetry: failed,
    retries: failed ? (arm.retries ?? 0) + 1 : 0,
  };
  delete next.whSecret;
  if (report.xai !== "failed") delete next.xaiPhoneId;
  return next;
}

const text = (s: string, status: number) => new Response(s, { status });
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
const fromDigits = (data: { sip_headers?: { name?: unknown; value?: unknown }[] }): string => {
  const h = (data.sip_headers ?? []).find((x) => String(x.name).toLowerCase() === "from");
  return (String(h?.value ?? "").match(/\d{7,15}/) ?? [""])[0];
};

/**
 * POST /api/xai-sip. 404 while the owner gate is closed. 401 unless the Standard Webhooks signature verifies against the secret xAI returned
 * when the number was registered (only exists while armed). A verified call is accepted only inside the arm window, for an allowed
 * caller and within the monthly budget; everything else is hung up. Always answers 200 quickly once verified; the work runs after the response.
 */
export async function handleSipWebhook(ctx: Ctx, req: Request, host: CallHost): Promise<Response> {
  const cfg = ctx.cfg;
  if (!callingGate(cfg).ok) return notFound();
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { Allow: "POST", "Content-Type": "application/json" } });
  const raw = await req.text();
  if (raw.length > 65536) return text("too large", 413);
  const arm = (await ctx.store.get<ArmRow>(ARM_KEY))?.value ?? null;
  if (!arm || arm.state !== "armed" || !arm.whSecret || !verifyStandardWebhook(arm.whSecret, raw, req.headers, ctx.now())) {
    ctx.log("calls_webhook_rejected", { why: "signature_or_not_armed" });
    return text("bad signature", 401);
  }
  let body: { type?: unknown; data?: { call_id?: unknown; sip_headers?: { name?: unknown; value?: unknown }[] } };
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (body.type !== "realtime.call.incoming") return text("ok", 200);
  const callId = body.data?.call_id;
  if (typeof callId !== "string" || !/^[A-Za-z0-9_.:-]{6,200}$/.test(callId)) return text("bad call id", 400);
  const from = fromDigits(body.data ?? {});
  const logId = "cl_" + sha256hex(callId).slice(0, 20);
  const now = ctx.now();

  const r = await updateMulti<{ dup: boolean; outcome: CallOutcome }>(
    ctx,
    [callKey(logId), INDEX_KEY, usageKey(now), ARM_KEY],
    ([log, idx, usage, armCur]) => {
      if (log) return { next: [undefined, undefined, undefined, undefined], result: { dup: true, outcome: (log as CallLog).outcome } };
      const a = armCur as ArmRow | null;
      const u: CallUsage = (usage as CallUsage | null) ?? { seconds: 0, calls: 0, rejected: 0 };
      let outcome: CallOutcome = "in_progress";
      if (!a || a.state !== "armed" || now > a.expiresAt || a.callsStarted >= a.maxCalls) outcome = "rejected_not_armed";
      else if (cfg.callAllowedCallers.length > 0 && !cfg.callAllowedCallers.includes(from)) outcome = "rejected_caller";
      else if (u.seconds >= cfg.callBudgetSeconds) outcome = "rejected_budget";
      const rec: CallLog = { id: logId, startedAt: now, mode: cfg.callingMode === "live" ? "live" : "test", callerHint: from ? "…" + from.slice(-2) : "…", outcome };
      if (outcome !== "in_progress") { rec.endedAt = now; rec.durationS = 0; rec.endReason = outcome; u.rejected++; }
      const ids = [logId, ...(((idx as CallIndex | null)?.ids) ?? [])].slice(0, MAX_INDEX);
      let nextArm: ArmRow | undefined;
      if (outcome === "in_progress" && a) nextArm = { ...a, callsStarted: a.callsStarted + 1 };
      return { next: [rec, { ids } satisfies CallIndex, u, nextArm], result: { dup: false, outcome } };
    },
    { ttl: { [callKey(logId)]: CALL_LOG_TTL_SEC, [usageKey(now)]: USAGE_TTL_SEC } },
  );
  const { dup, outcome } = r.result;
  if (dup) return text("ok", 200);
  ctx.log("calls_incoming", { call: logId, outcome });
  if (outcome === "in_progress") {
    ctx.schedule(async () => {
      try {
        await host.start({ callId, logId });
      } catch {
        ctx.log("calls_start_failed", { call: logId });
        await finishCall(ctx, logId, { endReason: "start_failed", endedBy: "system", outcome: "failed_to_start", durationS: 0 }, host.afterFinish).catch(() => undefined);
        if (cfg.xaiApiKey) await hangupCall(ctx.fetch, cfg.xaiApiKey, callId).catch(() => undefined);
      }
    });
  } else if (cfg.xaiApiKey) {
    const key = cfg.xaiApiKey;
    ctx.schedule(async () => { await hangupCall(ctx.fetch, key, callId).catch(() => undefined); });
  }
  return text("ok", 200);
}

export interface FinishPatch {
  endReason: string;
  endedBy: string;
  durationS: number;
  outcome?: CallOutcome;
  turns?: { caller: number; ai: number };
  errors?: number;
  transcript?: CallTranscript;
}

/**
 * Final commit of a call, ONE atomic write: the log row, the transcript row (when CALL_TRANSCRIPTS is on and there is text), the month's usage, and the arm row's finished counter. Idempotent (a log that
 * has already ended is left alone). Calls `after` with shouldDisarm = true when the arm window's last allowed call has ended.
 */
export async function finishCall(ctx: Ctx, logId: string, p: FinishPatch, after?: CallHost["afterFinish"]): Promise<{ shouldDisarm: boolean }> {
  const now = ctx.now();
  const keepTx = ctx.cfg.callTranscripts && !!p.transcript && p.transcript.lines.length > 0;
  const txTtl = ctx.cfg.callTranscriptDays * 86400;
  const r = await updateMulti<{ shouldDisarm: boolean }>(
    ctx,
    [callKey(logId), usageKey(now), ARM_KEY, txKey(logId)],
    ([log, usage, armCur]) => {
      const l = log as CallLog | null;
      if (!l || l.endedAt !== undefined) return { next: [undefined, undefined, undefined, undefined], result: { shouldDisarm: false } };
      const u: CallUsage = (usage as CallUsage | null) ?? { seconds: 0, calls: 0, rejected: 0 };
      const dur = Math.max(0, Math.min(86400, Math.round(p.durationS)));
      u.seconds += dur;
      u.calls += 1;
      const tx = keepTx ? p.transcript : undefined;
      const done: CallLog = {
        ...l, endedAt: now, durationS: dur, outcome: p.outcome ?? "completed", endReason: p.endReason, endedBy: p.endedBy,
        ...(p.turns ? { turns: p.turns } : {}), ...(p.errors ? { errors: p.errors } : {}),
        ...(tx ? { transcript: { lines: tx.lines.length, expiresAt: now + txTtl * 1000, ...(tx.truncated ? { truncated: true } : {}) } } : {}),
      };
      const a = armCur as ArmRow | null;
      let nextArm: ArmRow | undefined;
      let shouldDisarm = false;
      if (a && a.state === "armed") {
        nextArm = { ...a, callsFinished: a.callsFinished + 1 };
        shouldDisarm = nextArm.callsFinished >= nextArm.maxCalls;
      }
      return { next: [done, u, nextArm, tx], result: { shouldDisarm } };
    },
    { ttl: { [callKey(logId)]: CALL_LOG_TTL_SEC, [usageKey(now)]: USAGE_TTL_SEC, [txKey(logId)]: txTtl } },
  );
  ctx.log("calls_finished", { call: logId, secs: Math.round(p.durationS), why: p.endReason });
  if (after) await after(r.result).catch(() => undefined);
  return r.result;
}

/**
 * Erase ONE call: its log row, its transcript row and its place in the index, in one commit. Refuses a call that is still in progress
 * (its final write would recreate nothing, but the live session would keep collecting text). The month's usage counters stay: they are
 * billing numbers with no caller data. Not touched: platform point-in-time-recovery copies of the Durable Object.
 */
export async function eraseCall(ctx: Ctx, logId: string): Promise<{ ok: boolean; error?: string; erased_transcript?: boolean }> {
  const r = await updateMulti<{ ok: boolean; error?: string; erased_transcript?: boolean }>(
    ctx,
    [callKey(logId), txKey(logId), INDEX_KEY],
    ([log, tx, idx]) => {
      const l = log as CallLog | null;
      if (!l) return { next: [undefined, undefined, undefined], result: { ok: false, error: "not_found" } };
      if (l.outcome === "in_progress" && l.endedAt === undefined) return { next: [undefined, undefined, undefined], result: { ok: false, error: "call_in_progress" } };
      const ids = (((idx as CallIndex | null)?.ids) ?? []).filter((x) => x !== logId);
      return { next: [null, tx ? null : undefined, { ids } satisfies CallIndex], result: { ok: true, erased_transcript: !!tx } };
    },
  );
  ctx.log("calls_erased", { call: logId, ok: r.result.ok });
  return r.result;
}

export const estimateUsd = (seconds: number): number => Math.round((seconds / 60) * XAI_VOICE_USD_PER_MIN * 100) / 100;
