import { DurableObject } from "cloudflare:workers";
import { disarmRemote, type Remote } from "../lib/calls-remote";
import { ARM_KEY, tombstone, type ArmRow } from "../lib/calls";
import { loadConfig, type Env as ConfigEnv } from "../lib/config";
import { mergeEnv } from "../lib/secrets";
import { fixedWindowHit, type RateResult } from "../lib/rate-limit";
import type { CommitReq, RowData } from "../lib/row-store";
import type { Env } from "./env";

/** A SQLite-in-DO row is capped at 2 MB; a conversation is a few KB, so anything near this is a bug, not data. */
export const MAX_ROW_CHARS = 1_000_000;
/** most rate-limit counters kept at once (they expire after their window; this only bounds a flood of distinct keys) */
export const MAX_RATE_KEYS = 200;
const SQL_PARAM_CHUNK = 50; // Durable Object SQLite allows at most 100 bound parameters per statement

export type CommitResult = { ok: true } | { ok: false; reason?: "too_large" };

/**
 * The bridge state: one SQLite row per key (one per conversation). SQLite-backed Durable Object (free-plan
 * compatible: declare it under `new_sqlite_classes` in wrangler.toml). A Durable Object runs one request at a time and
 * commit() checks every version guard and applies every write inside ONE synchronous transaction (no await), so two
 * writers can never both win and a failed guard applies nothing.
 *
 * Tables:
 *   kv(key PRIMARY KEY, ver, json, exp, touched)   ver comes from the global counter in meta (never reused)
 *   meta(id=1, seq)                                 the counter
 * Cost per commit: rows written = changed keys + 1 (the counter). Reads are primary-key lookups or one prefix range.
 */
export class BridgeState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, ver INTEGER NOT NULL, json TEXT NOT NULL, exp INTEGER, touched INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);" +
        // self-provisioned credentials (lib/secrets.ts): NOT in kv, so admin overview, retention and the row store never see them
        "CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK (id = 1), claimed_at INTEGER, seq INTEGER NOT NULL);" +
        // fixed-window counters for the admin MCP route (lib/rate-limit.ts): NOT in kv, so retention and the row store never see them
        "CREATE TABLE IF NOT EXISTS ratelimit (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL, expires INTEGER NOT NULL);",
    );
  }

  /** The named keys plus every non-expired row under the prefixes. */
  read(keys: string[], prefixes: string[], now: number): RowData[] {
    const sql = this.ctx.storage.sql;
    const out = new Map<string, RowData>();
    for (let i = 0; i < keys.length; i += SQL_PARAM_CHUNK) {
      const part = keys.slice(i, i + SQL_PARAM_CHUNK);
      const rows = sql
        .exec<RowData & Record<string, SqlStorageValue>>(`SELECT key, ver, json, exp FROM kv WHERE key IN (${part.map(() => "?").join(",")}) AND (exp IS NULL OR exp > ?)`, ...part, now)
        .toArray();
      for (const r of rows) out.set(r.key, r);
    }
    for (const p of prefixes) {
      const rows = sql
        .exec<RowData & Record<string, SqlStorageValue>>("SELECT key, ver, json, exp FROM kv WHERE key >= ? AND key < ? AND (exp IS NULL OR exp > ?)", p, p + "\u{10FFFF}", now)
        .toArray();
      for (const r of rows) out.set(r.key, r);
    }
    return [...out.values()];
  }

  /** Check every guard, then apply every write, atomically. */
  commit(req: CommitReq): CommitResult {
    for (const w of req.writes) if (w.json !== null && w.json.length > MAX_ROW_CHARS) return { ok: false, reason: "too_large" };
    return this.ctx.storage.transactionSync((): CommitResult => {
      const sql = this.ctx.storage.sql;
      for (const g of req.guards) {
        const r = sql.exec<{ ver: number; exp: number | null }>("SELECT ver, exp FROM kv WHERE key = ?", g.key).toArray()[0];
        const cur = r && (r.exp === null || r.exp > req.now) ? r.ver : null;
        if (cur !== g.ver) return { ok: false };
      }
      if (!req.writes.length && !req.rej) return { ok: true };
      const m = sql.exec<{ seq: number }>("SELECT seq FROM meta WHERE id = 1").toArray()[0];
      const ver = (m?.seq ?? 0) + 1;
      sql.exec("INSERT INTO meta (id, seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq", ver);
      const upsert = (key: string, json: string, exp: number | null) =>
        sql.exec(
          "INSERT INTO kv (key, ver, json, exp, touched) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ver = excluded.ver, json = excluded.json, exp = excluded.exp, touched = excluded.touched",
          key, ver, json, exp, req.now,
        );
      for (const w of req.writes) {
        if (w.json === null) sql.exec("DELETE FROM kv WHERE key = ?", w.key);
        else upsert(w.key, w.json, w.expMs ?? null);
      }
      if (req.rej) {
        const r = sql.exec<{ json: string }>("SELECT json FROM kv WHERE key = 'metrics/rejections'").toArray()[0];
        let prev: { count?: number; last?: number } = {};
        try { prev = r ? JSON.parse(r.json) : {}; } catch { prev = {}; }
        upsert("metrics/rejections", JSON.stringify({ count: (prev.count ?? 0) + req.rej.n, last: Math.max(prev.last ?? 0, req.rej.last) }), null);
      }
      return { ok: true };
    });
  }

  /** Keys under `prefix` not written since `before`, oldest first. */
  stale(prefix: string, before: number, limit: number): string[] {
    return this.ctx.storage.sql
      .exec<{ key: string }>("SELECT key FROM kv WHERE key >= ? AND key < ? AND touched < ? ORDER BY touched LIMIT ?", prefix, prefix + "\u{10FFFF}", before, limit)
      .toArray()
      .map((r) => r.key);
  }

  /** Mark rows as examined by the retention pass: touched = now; value and version are NOT changed. */
  touch(keys: string[], now: number): void {
    const sql = this.ctx.storage.sql;
    for (let i = 0; i < keys.length; i += SQL_PARAM_CHUNK) {
      const part = keys.slice(i, i + SQL_PARAM_CHUNK);
      sql.exec(`UPDATE kv SET touched = ? WHERE key IN (${part.map(() => "?").join(",")})`, now, ...part);
    }
  }

  /** Self-provisioned credentials plus the lock state. `seq` changes on every write, so callers can tell when to rebuild config. */
  getSecrets(): { seq: number; claimed: boolean; values: Record<string, string> } {
    const sql = this.ctx.storage.sql;
    const st = sql.exec<{ claimed_at: number | null; seq: number }>("SELECT claimed_at, seq FROM setup WHERE id = 1").toArray()[0];
    const values: Record<string, string> = {};
    for (const r of sql.exec<{ name: string; value: string }>("SELECT name, value FROM secrets").toArray()) values[r.name] = r.value;
    return { seq: st?.seq ?? 0, claimed: st?.claimed_at != null, values };
  }

  /**
   * First-time setup: store the values and lock setup FOREVER, atomically. Returns ok:false (and stores nothing) if setup was
   * already claimed, so two racing callers can never both win. There is no unlock call.
   */
  claimSetup(values: Record<string, string>, now: number): { ok: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const st = sql.exec<{ claimed_at: number | null }>("SELECT claimed_at FROM setup WHERE id = 1").toArray()[0];
      if (st?.claimed_at != null) return { ok: false };
      for (const [k, v] of Object.entries(values)) {
        sql.exec("INSERT INTO secrets (name, value, updated) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated = excluded.updated", k, v, now);
      }
      sql.exec("INSERT INTO setup (id, claimed_at, seq) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET claimed_at = excluded.claimed_at, seq = seq + 1", now);
      return { ok: true };
    });
  }

  /** Admin rotation (the caller has already proved the admin token): set values, or delete with null. */
  putSecrets(values: Record<string, string | null>, now: number): { seq: number } {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const [k, v] of Object.entries(values)) {
        if (v === null) sql.exec("DELETE FROM secrets WHERE name = ?", k);
        else sql.exec("INSERT INTO secrets (name, value, updated) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated = excluded.updated", k, v, now);
      }
      sql.exec("INSERT INTO setup (id, claimed_at, seq) VALUES (1, NULL, 1) ON CONFLICT(id) DO UPDATE SET seq = seq + 1");
      return { seq: sql.exec<{ seq: number }>("SELECT seq FROM setup WHERE id = 1").one().seq };
    });
  }

  /**
   * Fixed-window counter used to throttle the admin MCP route (lib/rate-limit.ts). Counts every call, allowed or not, so a
   * flood stays blocked until the window ends. Rows are tiny and expire; at most MAX_RATE_KEYS are kept (oldest dropped).
   */
  rateHit(key: string, now: number, windowMs: number, max: number): RateResult {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM ratelimit WHERE expires <= ?", now);
      const cur = sql.exec<{ start: number; count: number }>("SELECT start, count FROM ratelimit WHERE key = ?", key).toArray()[0];
      const { win, result } = fixedWindowHit(cur, now, windowMs, max);
      sql.exec("INSERT INTO ratelimit (key, start, count, expires) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET start = excluded.start, count = excluded.count, expires = excluded.expires", key, win.start, win.count, win.start + windowMs);
      const n = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ratelimit").one().n;
      if (n > MAX_RATE_KEYS) sql.exec("DELETE FROM ratelimit WHERE key IN (SELECT key FROM ratelimit ORDER BY start LIMIT ?)", n - MAX_RATE_KEYS);
      return result;
    });
  }

  /** Schedule (epoch ms) or clear (null) the calling dead-man alarm. See alarm(). */
  async setDeadman(at: number | null): Promise<void> {
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /**
   * Dead-man: when the arm window is over (or a disarm failed earlier) switch Meta calling and SIP off and delete the xAI number, even if no
   * request ever comes. Works from the stored row and the credentials only; failures are retried every 5 minutes, at most 12 times.
   */
  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ ver: number; json: string }>("SELECT ver, json FROM kv WHERE key = ?", ARM_KEY).toArray()[0];
    if (!row) return;
    const arm = JSON.parse(row.json) as ArmRow;
    if (arm.state === "disarmed" && !arm.needsRetry) return;
    const cfg = loadConfig(mergeEnv(this.env, this.getSecrets().values) as ConfigEnv);
    if (!cfg.waAccessToken || !cfg.xaiApiKey) return;
    const remote: Remote = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), graphVersion: cfg.graphVersion, accessToken: cfg.waAccessToken, xaiKey: cfg.xaiApiKey };
    const report = await disarmRemote(remote, { pnid: arm.pnid, xaiPhoneId: arm.xaiPhoneId, prior: arm.prior });
    const now = Date.now();
    const next = tombstone(arm, report, now, arm.state === "disarmed" ? "retry" : "deadman");
    this.commit({ guards: [{ key: ARM_KEY, ver: row.ver }], writes: [{ key: ARM_KEY, json: JSON.stringify(next) }], now });
    console.log(JSON.stringify({ event: "calls_deadman", meta: report.meta, xai: report.xai }));
    if (next.needsRetry && (next.retries ?? 0) < 12) await this.ctx.storage.setAlarm(now + 300_000);
  }

  purgeExpired(now: number): number {
    const c = this.ctx.storage.sql.exec("DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?", now);
    return c.rowsWritten;
  }
}
