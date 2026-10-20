import type { Config } from "./config";
import type { Logger } from "./log";
import type { AiRunner } from "./media";
import type { Store, UpdateDeps } from "./store";

/** Everything the bridge logic needs from the outside world. Injected so tests can fake time and network. */
export interface Ctx extends UpdateDeps {
  cfg: Config;
  store: Store;
  now(): number;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  rand(): number;
  /** Run background work after the response (ExecutionContext.waitUntil on Cloudflare). */
  schedule(task: () => Promise<void>, label?: "wake" | "maintenance"): void;
  log: Logger;
  /** Workers AI binding (wrangler.toml [ai]); absent = media understanding is unavailable and falls back to markers */
  ai?: AiRunner;
  /** per-instance volatile state (never relied on for correctness) */
  state: VolatileState;
}

export interface VolatileState {
  /** signature rejections not yet persisted (they ride along with the next essential write) */
  rejPending: number;
  rejLast: number;
  lastRetryPass: number;
  /** reply keys whose send this instance saw succeed: their sent/delivered/read statuses need no store read */
  confirmed: Set<string>;
}

export const newVolatileState = (): VolatileState => ({ rejPending: 0, rejLast: 0, lastRetryPass: 0, confirmed: new Set() });

export async function fetchTimeout(ctx: Ctx, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await ctx.fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
