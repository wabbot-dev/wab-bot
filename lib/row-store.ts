import {
  StoreConflictError,
  type CasResult, type Scope, type Snapshot, type Store, type Versioned, type Write,
} from "./store";

/**
 * Store with ONE ROW PER KEY (one per conversation) in a SQLite-backed Cloudflare Durable Object (src/state-do.ts):
 *   kv(key PRIMARY KEY, ver, json, exp, touched)
 *
 * Why rows: a request reads and rewrites only the conversation(s) it touches, so per-request CPU and write contention
 * stay flat as the number of stored conversations grows (the previous single-document design re-parsed and re-wrote the
 * whole state on every write).
 *
 * Concurrency: every row has a version taken from a global counter (never reused, so a deleted-and-recreated key is not
 * mistaken for the old one). commit() sends version guards for every key the caller read explicitly and every key it
 * writes; the Durable Object checks them all and applies the writes in ONE synchronous transaction (it runs one request
 * at a time), so the compare-and-swap is exact. A lost race -> {ok:false} -> update() re-reads and re-applies its pure
 * function. Writers of unrelated conversations never conflict.
 */

export interface RowData {
  key: string;
  ver: number;
  json: string;
  /** expiry epoch ms (counters) or null */
  exp: number | null;
}

export interface CommitReq {
  /** key -> version the caller saw (null = the key must not exist) */
  guards: { key: string; ver: number | null }[];
  /** json null = delete the key */
  writes: { key: string; json: string | null; expMs?: number }[];
  /** pending signature rejections to add to the metrics row inside the same transaction */
  rej?: { n: number; last: number };
  now: number;
}

export interface RowBackend {
  /** One read: the named keys plus every non-expired row under the prefixes. Expired rows are never returned. */
  read(keys: string[], prefixes: string[], now: number): Promise<RowData[]>;
  /** One conditional write. A lost guard is returned as data ({ok:false}), never thrown. */
  commit(req: CommitReq): Promise<{ ok: true } | { ok: false; reason?: "too_large" }>;
  /** Keys under `prefix` not written since `before` (epoch ms), oldest first, at most `limit`. Used by the retention pass. */
  stale(prefix: string, before: number, limit: number): Promise<string[]>;
  /** Delete expired counter rows. Returns how many. */
  purgeExpired(now: number): Promise<number>;
  touch(keys: string[], now: number): Promise<void>;
}

export interface RejectionPiggyback {
  /** pending in-memory signature rejections (count, last timestamp) or null */
  peek(): { n: number; last: number } | null;
  /** called after a successful commit that included the first `n` */
  ack(n: number): void;
}

export interface RowStoreOptions {
  now(): number;
  /**
   * Per-value retention hook run on every written entry under "conv/": return a replacement (trimmed) value, null to
   * drop the entry, or undefined for no change.
   */
  compact?: (key: string, value: unknown, now: number) => unknown | null | undefined;
  rejections?: RejectionPiggyback;
}

class RowSnapshot implements Snapshot {
  private parsed = new Map<string, unknown>();
  constructor(
    readonly rows: Map<string, RowData>,
    readonly explicit: string[],
    readonly prefixes: string[],
    readonly at: number,
  ) {}
  private known(key: string): boolean {
    return this.explicit.includes(key) || this.prefixes.some((p) => key.startsWith(p));
  }
  get<T>(key: string): Versioned<T> | null {
    if (!this.known(key)) throw new Error(`snapshot_key_not_loaded:${key.split("/")[0]}`); // programming error
    const r = this.rows.get(key);
    if (!r || (r.exp !== null && r.exp <= this.at)) return null;
    let v = this.parsed.get(key);
    if (v === undefined) {
      try {
        v = JSON.parse(r.json);
      } catch {
        throw new Error("state_row_corrupt"); // never silently overwrite a corrupt row
      }
      this.parsed.set(key, v);
    }
    return { value: v as T, version: String(r.ver) };
  }
  keys(prefix: string): string[] {
    if (!this.prefixes.some((p) => prefix.startsWith(p))) throw new Error(`snapshot_prefix_not_loaded:${prefix}`);
    const out: string[] = [];
    for (const r of this.rows.values()) if (r.key.startsWith(prefix) && r.exp === null) out.push(r.key);
    return out;
  }
  covers(keys: string[]): boolean {
    return keys.every((k) => this.explicit.includes(k));
  }
}

export class RowStore implements Store {
  constructor(
    private backend: RowBackend,
    private o: RowStoreOptions,
  ) {}

  async snapshot(scope: Scope): Promise<Snapshot> {
    const keys = [...new Set(scope.keys ?? [])];
    const prefixes = [...new Set(scope.prefixes ?? [])];
    const now = this.o.now();
    const rows = new Map<string, RowData>();
    if (keys.length || prefixes.length) for (const r of await this.backend.read(keys, prefixes, now)) rows.set(r.key, r);
    return new RowSnapshot(rows, keys, prefixes, now);
  }

  async get<T>(key: string) {
    return (await this.snapshot({ keys: [key] })).get<T>(key);
  }

  async getMany<T>(keys: string[]) {
    const s = await this.snapshot({ keys });
    return keys.map((k) => s.get<T>(k));
  }

  async keys(prefix: string) {
    return (await this.snapshot({ prefixes: [prefix] })).keys(prefix);
  }

  stale(prefix: string, before: number, limit: number) {
    return this.backend.stale(prefix, before, limit);
  }

  purgeExpired(now: number) {
    return this.backend.purgeExpired(now);
  }

  touch(keys: string[], now: number) {
    return keys.length ? this.backend.touch(keys, now) : Promise.resolve();
  }

  async commit(base: Snapshot, writes: Write[]): Promise<CasResult> {
    if (!(base instanceof RowSnapshot)) throw new Error("foreign snapshot");
    const now = this.o.now();
    const guards = new Map<string, number | null>();
    for (const k of base.explicit) {
      const r = base.rows.get(k);
      guards.set(k, r && (r.exp === null || r.exp > base.at) ? r.ver : null);
    }
    for (const w of writes) guards.set(w.key, w.expected === null ? null : Number(w.expected));
    const out: CommitReq["writes"] = [];
    for (const w of writes) {
      let value = w.value;
      if (value === null) { out.push({ key: w.key, json: null }); continue; } // an explicit null deletes the row (erase of a call log)
      if (this.o.compact && w.key.startsWith("conv/")) {
        const r = this.o.compact(w.key, value, now);
        if (r === null) {
          out.push({ key: w.key, json: null });
          continue;
        }
        if (r !== undefined) value = r;
      }
      out.push({ key: w.key, json: JSON.stringify(value), ...(w.ttlSec ? { expMs: now + w.ttlSec * 1000 } : {}) });
    }
    // Signature rejections are counted in memory and ride along with the next essential write (never a call of their own).
    const pr = this.o.rejections?.peek() ?? null;
    const req: CommitReq = {
      guards: [...guards].map(([key, ver]) => ({ key, ver })),
      writes: out,
      now,
      ...(pr && pr.n > 0 ? { rej: { n: pr.n, last: pr.last } } : {}),
    };
    let res: { ok: boolean; reason?: string };
    try {
      res = await this.backend.commit(req);
    } catch (err) {
      if (err instanceof StoreConflictError) return { ok: false };
      throw err;
    }
    if (!res.ok) {
      if (res.reason === "too_large") throw new Error("state_row_too_large");
      return { ok: false };
    }
    if (req.rej) this.o.rejections!.ack(req.rej.n);
    return { ok: true };
  }
}
