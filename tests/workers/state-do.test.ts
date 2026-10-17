import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableRowBackend } from "../../src/do-backend";
import { MAX_ROW_CHARS } from "../../src/state-do";
import { RowStore } from "../../lib/row-store";
import type { Env } from "../../src/env";

const ns = (env as unknown as Env).STATE;
const fresh = (name: string) => ns.get(ns.idFromName(`test-${name}-${Date.now()}-${Math.random()}`));
const NOW = 1_000_000;
const put = (key: string, json: string, ver: number | null, expMs?: number) =>
  ({ guards: [{ key, ver }], writes: [{ key, json, ...(expMs ? { expMs } : {}) }], now: NOW });

describe("BridgeState Durable Object: per-row compare-and-swap", () => {
  it("create-only, version guard, stale version loses, second create loses", async () => {
    const s = fresh("cas");
    expect(await s.read(["a"], [], NOW)).toEqual([]);
    expect(await s.commit(put("a", '{"n":1}', null))).toEqual({ ok: true });
    expect(await s.commit(put("a", '{"n":99}', null))).toEqual({ ok: false });
    const [r1] = await s.read(["a"], [], NOW);
    expect(r1!.json).toBe('{"n":1}');
    expect(await s.commit(put("a", '{"n":2}', 99999))).toEqual({ ok: false });
    expect(await s.commit(put("a", '{"n":2}', r1!.ver))).toEqual({ ok: true });
    expect(await s.commit(put("a", '{"n":3}', r1!.ver))).toEqual({ ok: false }); // old version after a write
    expect((await s.read(["a"], [], NOW))[0]!.json).toBe('{"n":2}');
  });

  it("a multi-key commit is all-or-nothing, and unrelated keys never conflict", async () => {
    const s = fresh("multi");
    await s.commit(put("a", "1", null));
    await s.commit(put("b", "1", null));
    const [a] = await s.read(["a"], [], NOW);
    const bad = await s.commit({ guards: [{ key: "a", ver: a!.ver }, { key: "b", ver: 424242 }], writes: [{ key: "a", json: "2" }, { key: "c", json: "1" }], now: NOW });
    expect(bad).toEqual({ ok: false });
    expect((await s.read(["a", "c"], [], NOW)).map((r) => r.key + "=" + r.json).sort()).toEqual(["a=1"]);
    // b changes; a commit that only touches a is unaffected
    const [b] = await s.read(["b"], [], NOW);
    await s.commit(put("b", "2", b!.ver));
    expect(await s.commit({ guards: [{ key: "a", ver: a!.ver }], writes: [{ key: "a", json: "3" }], now: NOW })).toEqual({ ok: true });
  });

  it("20 concurrent writers of the same key with the same version: exactly one wins; writers of different keys all win", async () => {
    const s = fresh("race");
    await s.commit(put("hot", "0", null));
    const [h] = await s.read(["hot"], [], NOW);
    const same = await Promise.all(Array.from({ length: 20 }, (_, i) => s.commit(put("hot", String(i), h!.ver))));
    expect(same.filter((r) => r.ok)).toHaveLength(1);
    const diff = await Promise.all(Array.from({ length: 20 }, (_, i) => s.commit(put(`conv/${i}`, "1", null))));
    expect(diff.every((r) => r.ok)).toBe(true);
    expect(await s.read([], ["conv/"], NOW)).toHaveLength(20);
  });

  it("versions never repeat: delete + recreate is not the old row (no ABA)", async () => {
    const s = fresh("aba");
    await s.commit(put("k", "1", null));
    const [v1] = await s.read(["k"], [], NOW);
    expect(await s.commit({ guards: [{ key: "k", ver: v1!.ver }], writes: [{ key: "k", json: null }], now: NOW })).toEqual({ ok: true });
    expect(await s.read(["k"], [], NOW)).toEqual([]);
    await s.commit(put("k", "2", null));
    const [v2] = await s.read(["k"], [], NOW);
    expect(v2!.ver).toBeGreaterThan(v1!.ver);
    expect(await s.commit(put("k", "3", v1!.ver))).toEqual({ ok: false });
  });

  it("prefix reads are a range (not LIKE), expired rows are invisible and purgeable, rejections are added atomically", async () => {
    const s = fresh("range");
    await s.commit({ guards: [], writes: [{ key: "conv/a", json: "1" }, { key: "conv/b", json: "1" }, { key: "convX/z", json: "1" }, { key: "rl/h", json: "1", expMs: NOW + 1000 }], now: NOW });
    expect((await s.read([], ["conv/"], NOW)).map((r) => r.key).sort()).toEqual(["conv/a", "conv/b"]);
    expect((await s.read(["rl/h"], [], NOW)).map((r) => r.key)).toEqual(["rl/h"]);
    expect(await s.read(["rl/h"], [], NOW + 1001)).toEqual([]);
    expect(await s.purgeExpired(NOW + 1001)).toBe(1);
    await s.commit({ guards: [], writes: [], rej: { n: 3, last: 7 }, now: NOW });
    await s.commit({ guards: [], writes: [], rej: { n: 2, last: 5 }, now: NOW });
    const [rj] = await s.read(["metrics/rejections"], [], NOW);
    expect(JSON.parse(rj!.json)).toEqual({ count: 5, last: 7 });
  });

  it("stale() lists rows not written since the cutoff, oldest first", async () => {
    const s = fresh("stale");
    await s.commit({ guards: [], writes: [{ key: "conv/old", json: "1" }], now: 100 });
    await s.commit({ guards: [], writes: [{ key: "conv/mid", json: "1" }], now: 200 });
    await s.commit({ guards: [], writes: [{ key: "conv/new", json: "1" }], now: 300 });
    expect(await s.stale("conv/", 250, 10)).toEqual(["conv/old", "conv/mid"]);
    expect(await s.stale("conv/", 250, 1)).toEqual(["conv/old"]);
  });

  it("touch() moves a row out of stale() without changing its value or version", async () => {
    const s = fresh("touch");
    await s.commit({ guards: [], writes: [{ key: "conv/a", json: "1" }, { key: "conv/b", json: "1" }], now: 100 });
    const [before] = await s.read(["conv/a"], [], NOW);
    await s.touch(["conv/a"], 500);
    expect(await s.stale("conv/", 300, 10)).toEqual(["conv/b"]);
    const [after] = await s.read(["conv/a"], [], NOW);
    expect(after).toEqual(before);
    await s.touch([], 1); // empty list is a no-op
  });

  it("refuses an absurdly large row and keeps the old one", async () => {
    const s = fresh("big");
    await s.commit(put("k", '"ok"', null));
    const [v] = await s.read(["k"], [], NOW);
    expect(await s.commit(put("k", "x".repeat(MAX_ROW_CHARS + 1), v!.ver))).toEqual({ ok: false, reason: "too_large" });
    await expect(new RowStore(new DurableRowBackend(() => s), { now: () => NOW }).commit(
      await new RowStore(new DurableRowBackend(() => s), { now: () => NOW }).snapshot({ keys: ["k"] }),
      [{ key: "k", value: "x".repeat(MAX_ROW_CHARS + 1), expected: String(v!.ver) }],
    )).rejects.toThrow(/state_row_too_large/);
    expect((await s.read(["k"], [], NOW))[0]!.json).toBe('"ok"');
  });

  it("state survives eviction of the object (durable, not in memory)", async () => {
    const s = fresh("evict");
    await s.commit(put("k", '"persisted"', null));
    await evictDurableObject(s);
    expect((await s.read(["k"], [], NOW))[0]!.json).toBe('"persisted"');
    await s.commit(put("k2", "1", null)); // the version counter also survived
    const [a, b] = await s.read(["k", "k2"], [], NOW);
    expect(b!.ver).toBeGreaterThan(a!.ver);
  });
});

describe("RowStore over the Durable Object", () => {
  it("a lost guard is {ok:false} (data), a win is {ok:true}", async () => {
    const stub = fresh("adapter");
    const store = new RowStore(new DurableRowBackend(() => stub), { now: () => NOW });
    const s0 = await store.snapshot({ keys: ["c/1"] });
    expect(await store.commit(s0, [{ key: "c/1", value: { a: 1 }, expected: null }])).toEqual({ ok: true });
    expect(await store.commit(s0, [{ key: "c/1", value: { a: 2 }, expected: null }])).toEqual({ ok: false });
    expect((await store.get<{ a: number }>("c/1"))!.value).toEqual({ a: 1 });
    expect(await store.keys("c/")).toEqual(["c/1"]);
  });
});
