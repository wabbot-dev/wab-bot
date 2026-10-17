import { DurableObject } from "cloudflare:workers";
import { CallRunner, DISARM_GRACE_MS, type SocketLike } from "../lib/call-runner";
import { disarmCalling } from "../lib/calls-arm";
import { callKey, finishCall, type CallLog } from "../lib/calls";
import { hangupCall, openCallSocket } from "../lib/xai-voice";
import { stateStub } from "./do-backend";
import type { Env } from "./env";
import { getCtx } from "./runtime";
import { ensureSecrets } from "./setup";

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
