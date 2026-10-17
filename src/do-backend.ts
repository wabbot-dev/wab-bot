import type { RateLimiter } from "../lib/rate-limit";
import type { CommitReq, RowBackend } from "../lib/row-store";
import type { BridgeState } from "./state-do";

/** The state lives in ONE Durable Object instance with this fixed name. */
export const STATE_OBJECT_NAME = "state-v1";

/** RowBackend over the BridgeState Durable Object (RPC). A lost guard comes back as data, never as an exception. */
export class DurableRowBackend implements RowBackend {
  /** the stub is created per call: Workers I/O objects must not outlive the request that made them */
  constructor(private stub: () => DurableObjectStub<BridgeState>) {}

  read(keys: string[], prefixes: string[], now: number) {
    return this.stub().read(keys, prefixes, now);
  }

  commit(req: CommitReq) {
    return this.stub().commit(req);
  }

  stale(prefix: string, before: number, limit: number) {
    return this.stub().stale(prefix, before, limit);
  }

  purgeExpired(now: number) {
    return this.stub().purgeExpired(now);
  }

  touch(keys: string[], now: number) {
    return this.stub().touch(keys, now);
  }
}

/** RateLimiter over the same Durable Object (counters live in their own table, see BridgeState.rateHit). */
export class DurableRateLimiter implements RateLimiter {
  constructor(private stub: () => DurableObjectStub<BridgeState>) {}

  hit(key: string, now: number, windowMs: number, max: number) {
    return this.stub().rateHit(key, now, windowMs, max);
  }
}

export const stateStub = (ns: DurableObjectNamespace<BridgeState>) => ns.get(ns.idFromName(STATE_OBJECT_NAME));
