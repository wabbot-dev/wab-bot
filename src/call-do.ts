import { DurableObject } from "cloudflare:workers";
import { CallRunner, DISARM_GRACE_MS, type SocketLike } from "../lib/call-runner";
import { disarmCalling } from "../lib/calls-arm";
import { callKey, finishCall, type CallLog } from "../lib/calls";
import { hangupCall, openCallSocket } from "../lib/xai-voice";
import { stateStub } from "./do-backend";
import type { Env } from "./env";
import { getCtx } from "./runtime";
import { ensureSecrets } from "./setup";
import { encodeInIsolate } from "./voice-wasm";
import { speak, type SpeakArgs, type SpeakResult } from "../lib/voice-reply";
import { speakXai } from "../lib/tts-xai";

/**
 * One Durable Object per voice call (named by xAI's call id). It owns the realtime socket for the length of the call: a Worker request
 * cannot, because it ends when the response is sent. Idle (and free) unless calling is armed. See lib/call-runner.ts for the session logic.
 */
export class CallSession extends DurableObject<Env> {
  private runner?: CallRunner;

  private ctx0() {
    return getCtx(this.env, this.ctx);
  }

  async start(a: { callId: string; logId: string }): Promise<{ ok: boolean; dup?: boolean }> {
    if (await this.ctx.storage.get("call")) return { ok: true, dup: true };
    await this.ctx.storage.put("call", { ...a, at: Date.now() });
    await ensureSecrets(this.env);
    const cfg = this.ctx0().cfg;
    await this.ctx.storage.setAlarm(Date.now() + cfg.callMaxSeconds * 1000 + 5000); // second net if the in-memory timer is lost
    const key = cfg.xaiApiKey ?? "";
    const env = this.env;
    this.runner = new CallRunner(
      {
        getCtx: () => this.ctx0(),
        afterFinish: async ({ shouldDisarm }) => {
          // not at once: the hang-up needs a moment to reach Meta, and switching Meta calling off / deleting the xAI number in the same
          // second can cut the hang-up short
          if (shouldDisarm) await new Promise((r) => setTimeout(r, DISARM_GRACE_MS));
          if (shouldDisarm) await disarmCalling(this.ctx0(), "last_call_ended", { setDeadman: (at) => stateStub(env.STATE).setDeadman(at) });
        },
        openSocket: async (id) => (await openCallSocket((...x) => fetch(...x), key, id)) as unknown as SocketLike,
        hangup: (id) => hangupCall((...x) => fetch(...x), key, id),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      a,
    );
    await this.runner.start();
    return { ok: true };
  }

  /**
   * Text-to-speech + Ogg Opus encoding for optional voice replies (docs/VOICE-REPLIES.md). It runs here, in a Durable Object named
   * "voice-note-encoder" that holds no call and no storage, because decoding the model's audio and encoding it needs more CPU than a
   * Workers Free request allows (10 ms) while a Durable Object invocation gets 30 s. Text in, Ogg Opus bytes out; nothing is stored or logged.
   */
  async speakVoice(a: SpeakArgs): Promise<SpeakResult> {
    if (a.xai) {
      // xAI text-to-speech (VOICE_REPLY_PROVIDER=xai): the key is read HERE from this deployment's own config, never passed in the call
      await ensureSecrets(this.env);
      const key = this.ctx0().cfg.xaiApiKey ?? "";
      const x = a.xai;
      return speakXai((...f) => fetch(...f), encodeInIsolate, {
        text: String(a.text).slice(0, 1500), apiKey: key, voice: String(x.voice).slice(0, 80), language: String(x.language).slice(0, 10),
        maxChars: Math.min(1500, Math.max(20, Math.floor(x.maxChars))), maxSeconds: Math.min(120, Math.max(1, Math.floor(a.maxSeconds))),
        timeoutMs: Math.min(20000, Math.max(1000, Math.floor(a.timeoutMs))), replace: x.replace,
      });
    }
    if (!this.env.AI) return { ok: false, code: "voice_unavailable", count: {} };
    const ai = this.env.AI;
    const runner = { run: (model: string, input: Record<string, unknown>) => ai.run(model as Parameters<Ai["run"]>[0], input as never) as Promise<unknown> };
    return speak(runner, encodeInIsolate, {
      text: String(a.text).slice(0, 1500),
      lang: String(a.lang),
      model: String(a.model),
      maxSeconds: Math.min(120, Math.max(1, Math.floor(a.maxSeconds))),
      timeoutMs: Math.min(20000, Math.max(1000, Math.floor(a.timeoutMs))),
    });
  }

  /** max-duration backstop. With no live runner (the object was evicted mid-call) it hangs up and closes the log itself. */
  async alarm(): Promise<void> {
    if (this.runner) { await this.runner.end("max_duration", "limit"); return; }
    const call = await this.ctx.storage.get<{ callId: string; logId: string; at: number }>("call");
    if (!call) return;
    await ensureSecrets(this.env);
    const ctx = this.ctx0();
    // the call already ended and was logged (this object slept after it): nothing to hang up and nothing to log. Without this check the
    // alarm hung up an already-closed call and logged a bogus "interrupted" 95 s after a normal call (seen live).
    const logged = (await ctx.store.get<CallLog>(callKey(call.logId)))?.value;
    if (!logged || logged.endedAt !== undefined) return;
    if (ctx.cfg.xaiApiKey) await hangupCall(ctx.fetch, ctx.cfg.xaiApiKey, call.callId).catch(() => undefined);
    await finishCall(ctx, call.logId, { endReason: "interrupted", endedBy: "system", durationS: (Date.now() - call.at) / 1000, errors: 1 });
  }
}
