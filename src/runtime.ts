import { loadConfig, type Env as ConfigEnv } from "../lib/config";
import type { SpeakResult } from "../lib/voice-reply";
import { encodeInIsolate } from "./voice-wasm";
import type { Ctx, VolatileState } from "../lib/ctx";
import { newVolatileState } from "../lib/ctx";
import { consoleLog } from "../lib/log";
import { mergeEnv } from "../lib/secrets";
import { makeStore } from "../lib/make-store";
import { DurableRowBackend, stateStub } from "./do-backend";
import type { Env } from "./env";
import { currentSecrets } from "./setup";

interface Shared {
  env: Env;
  seq: number;
  cfg: Ctx["cfg"];
  state: VolatileState;
}

let shared: Shared | undefined;

/**
 * Per-isolate config and volatile counters, reused while the isolate lives (the env object is stable for a deployment version).
 * The store and the `schedule` hook are per request: ExecutionContext.waitUntil belongs to one request, and so does every promise. Volatile state is a
 * best-effort optimisation only (see lib/ctx.ts); correctness never depends on it.
 */
export function getCtx(env: Env, exec: Pick<ExecutionContext, "waitUntil">): Ctx {
  // Config = real bindings first, then credentials self-provisioned through /api/setup (src/setup.ts; loaded before routing).
  const sec = currentSecrets(env);
  if (!shared || shared.env !== env || shared.seq !== sec.seq) {
    shared = {
      env,
      seq: sec.seq,
      cfg: loadConfig(mergeEnv(env, sec.values) as ConfigEnv),
      state: shared && shared.env === env ? shared.state : newVolatileState(),
    };
  }
  const s = shared;
  return {
    cfg: s.cfg,
    // A NEW store (and so a new group-commit queue) per request: promises must never be shared between requests. A request
    // that awaits another request's flush has nothing of its own pending, and the runtime cancels it as "hung" (HTTP 500,
    // error 1101); found by the live test. Updates issued concurrently inside ONE request still group-commit.
    store: makeStore({ backend: new DurableRowBackend(() => stateStub(env.STATE)), now: () => Date.now(), state: s.state }),
    now: () => Date.now(),
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rand: Math.random,
    schedule: (task) => {
      exec.waitUntil(
        task().catch((e) => consoleLog("deferred_error", { err: e instanceof Error ? e.message.slice(0, 60) : "unknown" })),
      );
    },
    log: consoleLog,
    // Workers AI binding ([ai] in wrangler.toml). Only lib/media.ts calls it, only for inbound voice notes and images.
    // Optional voice-note replies: text-to-speech and the Ogg Opus encoder run in a Durable Object (30 s CPU per invocation), not in
    // this request (10 ms CPU on Workers Free); only the finished Ogg file (tens of KB) comes back.
    speakVoice: (a) => env.CALLS.get(env.CALLS.idFromName("voice-note-encoder")).speakVoice(a) as Promise<SpeakResult>,
    encodeVoiceInline: encodeInIsolate,
    ai: env.AI ? { run: (model, input) => env.AI!.run(model as Parameters<Ai["run"]>[0], input as never) as Promise<unknown> } : undefined,
    state: s.state,
  };
}
