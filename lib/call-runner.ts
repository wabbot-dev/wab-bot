import { buildGreeting, forceMessage, sipSessionUpdate } from "./call-persona";
import { finishCall, type CallHost, type CallOutcome, type CallTranscript, type TranscriptLine } from "./calls";
import type { Ctx } from "./ctx";

/**
 * One voice call's session logic (runs inside a CallSession Durable Object, src/call-do.ts). It joins xAI's realtime socket for the call,
 * sends the session settings and the greeting, watches events (it never sees or keeps caller audio; with CALL_TRANSCRIPTS on it keeps the
 * text of each turn in memory, capped, and writes it with the final log), ends the call when the model calls `end_call` or the maximum
 * duration is reached, and writes the final log in one atomic commit. All I/O is injected, so tests
 * drive it with a fake socket and fake timers.
 */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", fn: (ev: { data?: unknown }) => void): void;
}

export interface RunnerDeps {
  /** a fresh context per use (the store and schedule hook are per request on Workers) */
  getCtx(): Ctx;
  afterFinish?: CallHost["afterFinish"];
  openSocket(callId: string): Promise<SocketLike>;
  hangup(callId: string): Promise<{ ok: boolean; status: number; alreadyClosed: boolean }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  /** real wait (the Durable Object passes setTimeout). Without it the runner does not wait for xAI to confirm a hang-up (tests, simple hosts). */
  sleep?(ms: number): Promise<void>;
}

export const GREETING_FALLBACK_MS = 3000;
/**
 * After our hang-up request xAI should close the realtime socket by itself (it does when the SIP leg ends, as seen when the caller hangs up).
 * If it has not closed after this long we ask again, up to HANGUP_MAX_TRIES requests in total. Live test 3: the request answered 200 but the
 * caller's WhatsApp call stayed open, so a 200 alone is not proof that the SIP leg is gone.
 */
export const HANGUP_CONFIRM_MS = 3000;
export const HANGUP_MAX_TRIES = 3;
/** pause between the model's end_call and our hangup when no assistant audio is known to be playing */
export const AI_GOODBYE_MS = 2500;
/**
 * xAI sends the whole spoken reply (all audio deltas) BEFORE the function call event, faster than real time, so the caller can still be
 * hearing the goodbye when end_call arrives. When xAI reports playback in progress (`output_audio_buffer.started`, SIP only) we wait for
 * `output_audio_buffer.stopped` plus this tail, and at most AI_GOODBYE_MAX_MS.
 */
export const AI_PLAYBACK_TAIL_MS = 700;
export const AI_GOODBYE_MAX_MS = 8000;
/** how long the Durable Object waits after hanging up before the auto-disarm switches Meta calling off and deletes the xAI number */
export const DISARM_GRACE_MS = 4000;
/** transcript caps (a Durable Object row stays small): turns, characters per turn, characters in total */
export const TX_MAX_LINES = 200;
export const TX_MAX_LINE_CHARS = 1000;
export const TX_MAX_TOTAL_CHARS = 60_000;

export class CallRunner {
  private ws?: SocketLike;
  private startedAt = 0;
  private ended = false;
  private greeted = false;
  private timers: unknown[] = [];
  private turns = { caller: 0, ai: 0 };
  private errors = 0;
  private lines: TranscriptLine[] = [];
  private lineOf = new Map<string, number>();
  private txChars = 0;
  private txTruncated = false;
  private speechSegments = 0;
  private seenCaller = new Set<string>();
  private audioPlaying = false;
  private endRequestedAtS?: number;
  private evTypes = new Map<string, number>();
  private xaiClosedAtS?: number;

  constructor(private d: RunnerDeps, private a: { callId: string; logId: string }) {}

  get isEnded() { return this.ended; }

  async start(): Promise<void> {
    const ctx = this.d.getCtx();
    const cfg = ctx.cfg;
    this.startedAt = ctx.now();
    const ws = (this.ws = await this.d.openSocket(this.a.callId));
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => { this.xaiClosedAtS ??= this.secs(); void this.end("xai_closed", "caller_or_network"); });
    ws.addEventListener("error", () => { this.errors++; });
    ws.send(JSON.stringify(sipSessionUpdate(cfg)));
    this.timers.push(this.d.setTimer(() => this.greet(), GREETING_FALLBACK_MS));
    this.timers.push(this.d.setTimer(() => { void this.end("max_duration", "limit"); }, cfg.callMaxSeconds * 1000));
  }

  private greet() {
    if (this.greeted || this.ended || !this.ws) return;
    this.greeted = true;
    try { this.ws.send(JSON.stringify(forceMessage(buildGreeting(this.d.getCtx().cfg)))); } catch { this.errors++; }
  }

  /** keep one turn's text (capped). A repeated item id (xAI can send "completed" twice for one caller turn) replaces the earlier text. */
  private addLine(who: TranscriptLine["who"], itemId: unknown, raw: unknown): void {
    if (!this.d.getCtx().cfg.callTranscripts || typeof raw !== "string") return;
    const text = raw.trim().slice(0, TX_MAX_LINE_CHARS);
    if (!text) return;
    const id = typeof itemId === "string" ? who + ":" + itemId : "";
    const at = id ? this.lineOf.get(id) : undefined;
    if (at !== undefined) {
      this.txChars += text.length - this.lines[at].text.length;
      this.lines[at].text = text;
      return;
    }
    if (this.lines.length >= TX_MAX_LINES || this.txChars + text.length > TX_MAX_TOTAL_CHARS) { this.txTruncated = true; return; }
    if (id) this.lineOf.set(id, this.lines.length);
    this.lines.push({ who, atS: Math.max(0, Math.round((this.d.getCtx().now() - this.startedAt) / 100) / 10), text });
    this.txChars += text.length;
  }

  private transcript(): CallTranscript | undefined {
    return this.lines.length ? { lines: this.lines, ...(this.txTruncated ? { truncated: true } : {}) } : undefined;
  }

  onMessage(data: unknown): void {
    if (typeof data !== "string" || this.ended) return;
    // the high-rate audio events carry no information we use: skip parsing them (CPU matters on the Free plan)
    if (data.slice(0, 120).includes("output_audio.delta")) return;
    let ev: { type?: string; name?: string; call_id?: unknown; item_id?: unknown; transcript?: unknown };
    try { ev = JSON.parse(data); } catch { this.errors++; return; }
    // protocol event names only (never content): logged once at the end so a failed hang-up can be diagnosed from the Worker logs
    if (typeof ev.type === "string" && /^[a-z0-9_.]{1,60}$/.test(ev.type) && (this.evTypes.size < 40 || this.evTypes.has(ev.type))) this.evTypes.set(ev.type, (this.evTypes.get(ev.type) ?? 0) + 1);
    switch (ev.type) {
      case "session.updated": this.greet(); break;
      case "conversation.item.input_audio_transcription.completed":
        // one caller turn per xAI item id (the same item can be completed twice); without an id every event counts
        if (typeof ev.item_id !== "string") this.turns.caller++;
        else if (!this.seenCaller.has(ev.item_id) && this.seenCaller.size < 1000) { this.seenCaller.add(ev.item_id); this.turns.caller++; }
        this.addLine("caller", ev.item_id, ev.transcript);
        break;
      case "response.output_audio_transcript.done": this.addLine("ai", ev.item_id, ev.transcript); break;
      case "input_audio_buffer.speech_started": this.speechSegments++; break;
      case "response.done": this.turns.ai++; break;
      case "error": this.errors++; break;
      case "output_audio_buffer.started": this.audioPlaying = true; break;
      case "output_audio_buffer.stopped":
        this.audioPlaying = false;
        // the goodbye has been played out: hang up right after a short tail (the fallback timer set by end_call stays as the backstop)
        if (this.endRequestedAtS !== undefined) this.timers.push(this.d.setTimer(() => { void this.end("ai_end_call", "ai"); }, AI_PLAYBACK_TAIL_MS));
        break;
      case "response.function_call_arguments.done":
        if (ev.name === "end_call" && this.endRequestedAtS === undefined) {
          this.endRequestedAtS = this.secs();
          // answer the tool call so the session stays well-formed (xAI docs: function_call_output); no response.create: nothing more to say
          if (typeof ev.call_id === "string" && this.ws) {
            try { this.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify({ ok: true }) } })); } catch { this.errors++; }
          }
          this.timers.push(this.d.setTimer(() => { void this.end("ai_end_call", "ai"); }, this.audioPlaying ? AI_GOODBYE_MAX_MS : AI_GOODBYE_MS));
        }
        break;
      default: break;
    }
  }

  private secs(): number {
    return this.startedAt ? Math.round((this.d.getCtx().now() - this.startedAt) / 100) / 10 : 0;
  }

  /** idempotent: hang up at xAI (404 = already closed), close the socket, write the final log once */
  async end(reason: string, endedBy: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const t of this.timers) this.d.clearTimer(t);
    const ctx = this.d.getCtx();
    const dur = this.startedAt ? (ctx.now() - this.startedAt) / 1000 : 0;
    const hangupAtS = this.secs();
    // hang up at xAI; then wait for xAI to close the socket (proof the SIP leg ended) and ask again if it does not. Our own socket stays open meanwhile.
    const statuses: (number | string)[] = [];
    for (let i = 0; i < HANGUP_MAX_TRIES; i++) {
      if (this.xaiClosedAtS !== undefined && i > 0) break;
      let alreadyClosed = false;
      try { const h = await this.d.hangup(this.a.callId); statuses.push(h.status); alreadyClosed = h.alreadyClosed; } catch { statuses.push("threw"); }
      if (alreadyClosed || !this.d.sleep || this.xaiClosedAtS !== undefined) break;
      await this.d.sleep(HANGUP_CONFIRM_MS).catch(() => undefined);
      if (this.xaiClosedAtS !== undefined) break;
    }
    try { this.ws?.close(1000, "bye"); } catch { /* already closed */ }
    // fields stay short: the log layer cuts strings at 80 characters, one line per event type keeps every count readable
    ctx.log("calls_end", { call: this.a.logId, why: reason.slice(0, 40), end_call_at_s: this.endRequestedAtS ?? null, hangup_at_s: hangupAtS, hangup_status: statuses.join(","), xai_closed_after_hangup_s: this.xaiClosedAtS === undefined ? null : Math.max(0, Math.round((this.xaiClosedAtS - hangupAtS) * 10) / 10), event_types: this.evTypes.size });
    for (const [type, n] of this.evTypes) ctx.log("calls_event", { call: this.a.logId, type, n });
    const outcome: CallOutcome = "completed";
    // with transcripts off no caller text events exist: count speech segments instead so the log still shows whether the caller spoke
    const turns = { caller: ctx.cfg.callTranscripts ? this.turns.caller : this.speechSegments, ai: this.turns.ai };
    await finishCall(ctx, this.a.logId, { endReason: reason, endedBy, durationS: dur, outcome, turns, errors: this.errors, transcript: this.transcript() }, this.d.afterFinish);
  }
}
