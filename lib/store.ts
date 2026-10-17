/**
 * State-store interface. The production implementation (lib/row-store.ts) keeps ONE ROW PER KEY (one per conversation)
 * in a Durable Object's SQLite database, so the interface works on scoped snapshots:
 *
 *  - snapshot(scope)       one read of exactly the keys / key prefixes named in `scope`; those keys can then be read
 *                          for free from it (reading a key outside the scope throws: it is a programming error)
 *  - commit(base, writes)  one conditional write. Every key in the scope and every written key is guarded by the
 *                          per-key version the caller saw, so a concurrent writer of any of those keys makes the commit
 *                          lose (nothing is applied); writers of other keys never conflict with it.
 *
 * Callers should use update()/updateMulti() below: read, apply a pure function, commit, retry on conflict.
 */
export interface Versioned<T> {
  value: T;
  /** opaque per-key version (changes on every write of that key, never reused) */
  version: string;
}

/** What a snapshot must contain. */
export interface Scope {
  /** exact keys (they are version-guarded by commit) */
  keys?: string[];
  /** every non-expiring key under these prefixes (listings; not version-guarded) */
  prefixes?: string[];
}

/** Immutable view of the requested keys at one point in time. */
export interface Snapshot {
  get<T>(key: string): Versioned<T> | null;
  /** non-expiring keys under a loaded prefix (expiring counters are not listed) */
  keys(prefix: string): string[];
  /** true when every key in `keys` was loaded explicitly (so the snapshot can seed an update on them) */
  covers(keys: string[]): boolean;
}

export interface Write {
  key: string;
  value: unknown;
  /** per-key version the writer saw; null = create-only */
  expected: string | null;
  /** expire the key after this many seconds (counters) */
  ttlSec?: number;
}

export type CasResult = { ok: true } | { ok: false };

export interface Store {
  snapshot(scope: Scope): Promise<Snapshot>;
  /**
   * Atomically apply all writes, or none. {ok:false} when a guarded key's version no longer matches `base` /
   * `expected`. Costs exactly one write call (never retries by itself).
   */
  commit(base: Snapshot, writes: Write[]): Promise<CasResult>;
  get<T>(key: string): Promise<Versioned<T> | null>;
  getMany<T>(keys: string[]): Promise<(Versioned<T> | null)[]>;
  keys(prefix: string): Promise<string[]>;
  /** Keys under `prefix` not written since `before` (epoch ms), oldest first (retention pass). */
  stale(prefix: string, before: number, limit: number): Promise<string[]>;
  /** Delete expired counter rows (retention pass). */
  purgeExpired(now: number): Promise<number>;
  /** mark rows as examined (touched = now) WITHOUT changing their value or version; used by the retention pass */
  touch(keys: string[], now: number): Promise<void>;
}

/** Key of the batched signature-rejection counter (merged into other writes by the store, see row-store.ts). */
export const REJECTIONS_KEY = "metrics/rejections";

/** Read every non-expiring key under `prefix` in ONE read. */
export async function readAll<T>(store: Store, prefix: string, alsoKeys: string[] = []): Promise<{ snap: Snapshot; items: Versioned<T>[] }> {
  const snap = await store.snapshot({ prefixes: [prefix], keys: alsoKeys });
  const items: Versioned<T>[] = [];
  for (const k of snap.keys(prefix)) {
    const v = snap.get<T>(k);
    if (v) items.push(v);
  }
  return { snap, items };
}

export class StoreConflictError extends Error {
  constructor(msg = "store conflict") {
    super(msg);
    this.name = "StoreConflictError";
  }
}

const CONFLICT_RE = /already exists|precondition|conditional request|conflicting operation|\b412\b|\b409\b/i;

export function isConflict(err: unknown): boolean {
  if (err instanceof StoreConflictError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return CONFLICT_RE.test(msg);
}

export interface UpdateDeps {
  store: Store;
  sleep(ms: number): Promise<void>;
  rand(): number;
  /** optional clock for the retry time budget (defaults to Date.now) */
  now?(): number;
  /** optional: counters only (no content). Emits `cas` {attempts, ok, ops} once per put (and once per exhausted update) so puts/conflicts can be counted from the logs. */
  log?: (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => void;
}

export interface Draft<T, R> {
  /** New value to write, or undefined for "no change" (nothing is written). */
  next: T | undefined;
  result: R;
}

export interface MultiDraft<R> {
  /** one entry per key, in order; undefined = leave that key alone. All-undefined writes nothing. */
  next: unknown[];
  result: R;
}

/**
 * Thrown when an update could not be committed within its retry budget because other writers kept winning.
 * It is RETRYABLE and nothing was applied: the webhook answers 503 + Retry-After (Meta redelivers, wamid dedupe makes
 * the redelivery idempotent) and MCP tools answer {ok:false, error:"store_busy", retryable:true}.
 */
export class StoreBusyError extends Error {
  readonly retryable = true;
  constructor(msg = "cas exhausted") {
    super(msg);
    this.name = "StoreBusyError";
  }
}

export const isStoreBusy = (e: unknown): boolean => e instanceof StoreBusyError || (e instanceof Error && e.name === "StoreBusyError");

/**
 * Retry policy for a lost compare-and-swap: re-read the fresh rows, re-apply the pure function (so the change is
 * merged onto whatever the winner wrote; message ids are deduped by the function itself), wait a FULL-JITTER
 * exponential backoff and try again, until the time budget is spent (CAS_BUDGET_MS) or MAX_CAS_ATTEMPTS puts were made
 * (a safety cap: every failed attempt that reached the network may be a billed put()).
 */
export const CAS_BUDGET_MS = 8000;
export const MAX_CAS_ATTEMPTS = 25;
export const CAS_BACKOFF_BASE_MS = 25;
export const CAS_BACKOFF_CAP_MS = 800;
/** full jitter: uniform in [5, min(cap, base * 2^(attempt-1))] */
export const casBackoffMs = (attempt: number, rand: number): number =>
  5 + rand * (Math.min(CAS_BACKOFF_CAP_MS, CAS_BACKOFF_BASE_MS * 2 ** (attempt - 1)) - 5);

export interface MultiOptions {
  /** per-key expiry for written keys */
  ttl?: Record<string, number>;
  /**
   * A snapshot the caller already read moments ago (saves one GET). Used for the first attempt only (and only when
   * the update is not batched with others); safe because commit() still conflict-checks it, and a "no write"
   * outcome on it is re-checked against a fresh read.
   */
  seed?: Snapshot;
}

interface Op {
  deps: UpdateDeps;
  keys: string[];
  fn: (cur: (any | null)[]) => MultiDraft<any>;
  opts: MultiOptions;
  deadline: number;
  attempts: number;
  resolve(v: { result: any; wrote: boolean; values: (any | null)[] }): void;
  reject(e: unknown): void;
}

interface Queue {
  pending: Op[];
  running: boolean;
}

/** One queue per store instance = per warm serverless instance. Never relied on for correctness (the CAS is). */
const queues = new WeakMap<Store, Queue>();

/** Errors worth retrying on the READ side (a GET is idempotent); a corrupt row or missing config is not. */
const retryableRead = (e: unknown): boolean => !/state_row_|store_not_configured/.test(e instanceof Error ? e.message : String(e));

/**
 * updateMulti: read the keys from one snapshot, apply `fn` to deep copies, commit all changes with ONE put.
 *
 * Group commit: updates issued concurrently on the same instance are coalesced. One flusher at a time reads ONE fresh
 * snapshot, applies every queued function in order on top of each other's results (each sees the previous one's
 * writes), and commits the merged result with ONE conditional put. A conflict re-reads, re-applies ALL of them (plus
 * any that arrived meanwhile) and backs off with jitter, within each update's own time budget. fn must be pure
 * (it may run several times); fn returning all-undefined writes nothing. Without contention an update is still
 * exactly 1 GET + 1 put.
 */
export function updateMulti<R>(
  deps: UpdateDeps,
  keys: string[],
  fn: (cur: (any | null)[]) => MultiDraft<R>,
  opts: MultiOptions = {},
): Promise<{ result: R; wrote: boolean; values: (any | null)[] }> {
  return new Promise((resolve, reject) => {
    let q = queues.get(deps.store);
    if (!q) queues.set(deps.store, (q = { pending: [], running: false }));
    const now = (deps.now ?? Date.now)();
    q.pending.push({ deps, keys, fn, opts, deadline: now + CAS_BUDGET_MS, attempts: 0, resolve, reject });
    if (!q.running) {
      q.running = true;
      void drain(q);
    }
  });
}

async function drain(q: Queue) {
  try {
    await Promise.resolve(); // updates started in the same tick share one batch
    while (q.pending.length) await flush(q, q.pending.splice(0));
  } finally {
    q.running = false;
  }
}

async function flush(q: Queue, batch: Op[]) {
  const first = batch[0]!;
  const { deps } = first;
  const nowOf = () => (deps.now ?? Date.now)();
  let seed = batch.length === 1 && first.opts.seed?.covers(first.keys) ? first.opts.seed : undefined;
  let readFails = 0;
  while (batch.length) {
    if (batch.some((o) => o.attempts > 0)) batch.push(...q.pending.splice(0)); // retry: absorb late arrivals into this put
    const useSeed = seed !== undefined && batch.length === 1;
    let snap: Snapshot;
    try {
      snap = useSeed ? seed! : await deps.store.snapshot({ keys: [...new Set(batch.flatMap((o) => o.keys))] });
    } catch (e) {
      readFails++;
      if (!retryableRead(e) || nowOf() >= Math.min(...batch.map((o) => o.deadline)) || readFails >= MAX_CAS_ATTEMPTS) {
        for (const o of batch) o.reject(e);
        return;
      }
      await deps.sleep(casBackoffMs(readFails, deps.rand()));
      continue;
    }
    seed = undefined;

    // apply every op in order on an overlay of earlier ops' results
    const overlay = new Map<string, unknown>();
    const merged = new Map<string, Write>();
    const done: { op: Op; result: unknown; values: unknown[]; wrote: boolean }[] = [];
    let staleSeedNoWrite = false;
    for (const op of [...batch]) {
      let base: (Versioned<unknown> | null)[];
      try {
        base = op.keys.map((k) => snap.get<unknown>(k)); // may throw: a corrupt row is a hard error for this op only
      } catch (e) {
        op.reject(e);
        batch.splice(batch.indexOf(op), 1);
        continue;
      }
      const curs = op.keys.map((k, i) => (overlay.has(k) ? overlay.get(k) : base[i] ? base[i]!.value : null));
      let out: MultiDraft<any>;
      try {
        out = op.fn(curs.map((c) => (c === null || c === undefined ? null : structuredClone(c))));
      } catch (e) {
        op.reject(e);
        batch.splice(batch.indexOf(op), 1);
        continue;
      }
      const wrote = out.next.some((n) => n !== undefined);
      if (!wrote && useSeed) { staleSeedNoWrite = true; break; } // decided on a possibly stale seed: confirm against a fresh read
      out.next.forEach((n, i) => {
        if (n === undefined) return;
        const k = op.keys[i]!;
        overlay.set(k, n);
        const ttlSec = op.opts.ttl?.[k];
        const prev = merged.get(k);
        merged.set(k, { key: k, value: n, expected: base[i]?.version ?? null, ...(ttlSec ? { ttlSec } : prev?.ttlSec ? { ttlSec: prev.ttlSec } : {}) });
      });
      done.push({ op, result: out.result, wrote, values: out.next.map((n, i) => (n === undefined ? curs[i] ?? null : n)) });
    }
    if (staleSeedNoWrite) continue;
    for (const o of done) o.op.attempts++;
    if (merged.size === 0) {
      for (const d of done) d.op.resolve({ result: d.result, wrote: false, values: d.values });
      return;
    }
    let res: CasResult | undefined;
    try {
      res = await deps.store.commit(snap, [...merged.values()]);
    } catch (e) {
      if (!isConflict(e)) {
        for (const d of done) d.op.reject(e);
        return;
      }
    }
    if (res && res.ok) {
      deps.log?.("cas", { attempts: Math.max(...done.map((d) => d.op.attempts)), ok: true, ops: done.length });
      for (const d of done) d.op.resolve({ result: d.result, wrote: d.wrote, values: d.values });
      return;
    }
    // lost the race: drop the ops whose budget is spent, back off, re-read and re-apply the rest
    const now = nowOf();
    for (const o of [...batch]) {
      if (now >= o.deadline || o.attempts >= MAX_CAS_ATTEMPTS) {
        deps.log?.("cas", { attempts: o.attempts, ok: false, ops: 1 });
        o.reject(new StoreBusyError(`cas exhausted for ${o.keys[0]!.split("/")[0]}`));
        batch.splice(batch.indexOf(o), 1);
      }
    }
    if (!batch.length) return;
    const att = Math.max(...batch.map((o) => o.attempts));
    const remaining = Math.min(...batch.map((o) => o.deadline)) - now;
    await deps.sleep(Math.max(1, Math.min(casBackoffMs(att, deps.rand()), remaining)));
  }
}

/** Single-key update (see updateMulti). */
export async function update<T, R>(
  deps: UpdateDeps,
  key: string,
  fn: (cur: T | null) => Draft<T, R>,
  opts?: { ttlSec?: number; seed?: Snapshot },
): Promise<{ result: R; wrote: boolean; value: T | null }> {
  const r = await updateMulti<R>(
    deps,
    [key],
    ([cur]) => {
      const d = fn(cur as T | null);
      return { next: [d.next], result: d.result };
    },
    { ...(opts?.ttlSec ? { ttl: { [key]: opts.ttlSec } } : {}), ...(opts?.seed ? { seed: opts.seed } : {}) },
  );
  return { result: r.result, wrote: r.wrote, value: r.values[0] as T | null };
}
