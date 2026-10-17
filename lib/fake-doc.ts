import { StoreConflictError } from "./store";
import type { CommitReq, RowBackend, RowData } from "./row-store";

/**
 * In-memory RowBackend with the same compare-and-swap contract as the Durable Object (src/state-do.ts). Used by the
 * node logic tests and for local experiments (NOT durable). It counts operations so tests can assert the op budget
 * (reads / conditional writes per request); on Cloudflare these map to Durable Object requests and SQLite rows.
 * (The file keeps its old name `fake-doc` so the many test imports stay valid.)
 */
export class FakeDoc implements RowBackend {
  private rows = new Map<string, RowData & { touched: number }>();
  private seq = 0;
  ops = { read: 0, write: 0 };
  /** failure injection: called before each commit; may throw (StoreConflictError = a lost race) */
  beforeWrite?: () => void;
  /** simulated latency: awaited before every read/commit so concurrent callers really interleave (tests) */
  latency?: () => Promise<void>;
  /** ops log in order: "read", "write" */
  log: string[] = [];
  /** guards of every commit, for asserting what a request protected */
  writeConds: CommitReq["guards"][] = [];
  /** rows each commit wrote (sum), to assert per-request write volume */
  rowsWritten = 0;
  /** rows returned by reads (sum), to assert per-request read volume */
  rowsRead = 0;

  /** number of stored rows */
  get size() {
    return this.rows.size;
  }
  keysOf(prefix = "") {
    return [...this.rows.keys()].filter((k) => k.startsWith(prefix));
  }
  /** parsed value of a row (tests) */
  valueOf<T = any>(key: string): T | null {
    const r = this.rows.get(key);
    return r ? (JSON.parse(r.json) as T) : null;
  }
  /** raw stored text of a row (tests) */
  rawOf(key: string): string | null {
    return this.rows.get(key)?.json ?? null;
  }
  /** test hook: store arbitrary text as a row (e.g. corrupt JSON) */
  setRaw(key: string, json: string) {
    this.rows.set(key, { key, ver: ++this.seq, json, exp: null, touched: 0 });
  }
  resetOps() {
    this.ops = { read: 0, write: 0 };
    this.log = [];
    this.writeConds = [];
    this.rowsWritten = 0;
    this.rowsRead = 0;
  }

  async read(keys: string[], prefixes: string[], now: number): Promise<RowData[]> {
    this.ops.read++;
    await this.latency?.();
    this.log.push("read");
    const out = new Map<string, RowData>();
    const live = (r: RowData) => r.exp === null || r.exp > now;
    for (const k of keys) {
      const r = this.rows.get(k);
      if (r && live(r)) out.set(k, { key: r.key, ver: r.ver, json: r.json, exp: r.exp });
    }
    for (const r of this.rows.values()) {
      if (prefixes.some((p) => r.key.startsWith(p)) && live(r)) out.set(r.key, { key: r.key, ver: r.ver, json: r.json, exp: r.exp });
    }
    this.rowsRead += out.size;
    return [...out.values()];
  }

  async commit(req: CommitReq): Promise<{ ok: true } | { ok: false; reason?: "too_large" }> {
    this.ops.write++;
    await this.latency?.();
    this.log.push("write");
    this.writeConds.push(req.guards);
    this.beforeWrite?.();
    for (const g of req.guards) {
      const r = this.rows.get(g.key);
      const cur = r && (r.exp === null || r.exp > req.now) ? r.ver : null;
      if (cur !== g.ver) return { ok: false };
    }
    const ver = ++this.seq;
    for (const w of req.writes) {
      if (w.json === null) this.rows.delete(w.key);
      else {
        this.rows.set(w.key, { key: w.key, ver, json: w.json, exp: w.expMs ?? null, touched: req.now });
      }
      this.rowsWritten++;
    }
    if (req.rej) {
      const cur = this.rows.get("metrics/rejections");
      const prev = cur ? (JSON.parse(cur.json) as { count?: number; last?: number }) : {};
      this.rows.set("metrics/rejections", {
        key: "metrics/rejections", ver, exp: null, touched: req.now,
        json: JSON.stringify({ count: (prev.count ?? 0) + req.rej.n, last: Math.max(prev.last ?? 0, req.rej.last) }),
      });
      this.rowsWritten++;
    }
    return { ok: true };
  }

  async stale(prefix: string, before: number, limit: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((r) => r.key.startsWith(prefix) && r.touched < before)
      .sort((a, b) => a.touched - b.touched)
      .slice(0, limit)
      .map((r) => r.key);
  }

  async touch(keys: string[], now: number): Promise<void> {
    this.ops.write++;
    for (const k of keys) { const r = this.rows.get(k); if (r) { r.touched = now; this.rowsWritten++; } }
  }

  async purgeExpired(now: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.rows) if (r.exp !== null && r.exp <= now) { this.rows.delete(k); n++; }
    return n;
  }
}

export { StoreConflictError };
