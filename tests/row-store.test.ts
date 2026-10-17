// Store contract + RowBackend adapter behaviour (against the in-memory FakeDoc, which mimics the Durable Object's per-row compare-and-swap).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RowStore } from "../lib/row-store";
import { FakeDoc } from "../lib/fake-doc";
import { makeStore } from "../lib/make-store";
import { newVolatileState } from "../lib/ctx";
import { MAX_CAS_ATTEMPTS, StoreConflictError, update, updateMulti, type Store } from "../lib/store";

const mk = (blob = new FakeDoc(), now = () => 1_000_000) => {
  const state = newVolatileState();
  const store = makeStore({ backend: blob, now, state });
  return { blob, store, state, deps: { store, sleep: async () => {}, rand: () => 0 } };
};
const w = (store: Store, key: string, value: unknown, expected: string | null, ttlSec?: number) =>
  store.snapshot({ keys: [key] }).then((s) => store.commit(s, [{ key, value, expected, ttlSec }]));

test("contract: create-only, version check, stale writer loses, multi-key commit is all-or-nothing", async () => {
  const { store } = mk();
  assert.equal(await store.get("conv/a"), null);
  assert.deepEqual(await store.keys("conv/"), []);
  assert.equal((await w(store, "conv/a", { n: 1 }, null)).ok, true);
  assert.equal((await w(store, "conv/a", { n: 99 }, null)).ok, false, "create-only fails when it exists");
  const g = (await store.get<{ n: number }>("conv/a"))!;
  assert.equal(g.value.n, 1);
  assert.equal((await w(store, "conv/a", { n: 2 }, "999")).ok, false, "stale version loses");
  assert.equal((await w(store, "conv/a", { n: 2 }, g.version)).ok, true);
  assert.equal((await w(store, "conv/a", { n: 3 }, g.version)).ok, false, "old version loses after a write");
  const snap = await store.snapshot({ keys: ["conv/a"] });
  const bad = await store.commit(snap, [
    { key: "conv/b", value: { n: 10 }, expected: null },
    { key: "conv/a", value: { n: 4 }, expected: "stale" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(await store.get("conv/b"), null, "nothing from the failed multi-commit was written");
  assert.deepEqual((await store.getMany<{ n: number }>(["conv/b", "conv/a"])).map((x) => x?.value.n ?? null), [null, 2]);
});

test("contract: a commit is guarded per key: another key changing does NOT conflict, a key it read DOES (even if unwritten)", async () => {
  const { store } = mk();
  await w(store, "conv/a", { n: 1 }, null);
  await w(store, "ctl/c", { v: 1 }, null);
  const old = await store.snapshot({ keys: ["conv/a", "ctl/c"] });
  await w(store, "conv/b", { n: 1 }, null); // an unrelated key
  const ok = await store.commit(old, [{ key: "conv/a", value: { n: 2 }, expected: old.get("conv/a")!.version }]);
  assert.equal(ok.ok, true, "unrelated writers never conflict");
  const old2 = await store.snapshot({ keys: ["conv/a", "ctl/c"] });
  const ctl = (await store.get("ctl/c"))!;
  await w(store, "ctl/c", { v: 2 }, ctl.version); // a key the decision was based on
  const lost = await store.commit(old2, [{ key: "conv/a", value: { n: 3 }, expected: old2.get("conv/a")!.version }]);
  assert.equal(lost.ok, false, "the read-but-unwritten key changed: the writer must re-read (update() does this)");
});

test("contract: versions are never reused: delete + recreate is not mistaken for the old row (no ABA)", async () => {
  const { store } = mk();
  await w(store, "conv/c_x", { id: "c_x", state: "pending", updatedAt: 1_000_000, messages: [], seenIds: [], outs: {}, wake: { log: [] } }, null);
  const v1 = (await store.get<any>("conv/c_x"))!;
  await w(store, "conv/c_x", { ...v1.value, deleted: true }, v1.version); // compaction drops it
  assert.equal(await store.get("conv/c_x"), null);
  await w(store, "conv/c_x", { id: "c_x", state: "pending", updatedAt: 1_000_000, messages: [], seenIds: [], outs: {}, wake: { log: [] } }, null);
  const v2 = (await store.get<any>("conv/c_x"))!;
  assert.notEqual(v2.version, v1.version);
  assert.equal((await w(store, "conv/c_x", { x: 1 }, v1.version)).ok, false);
});

test("scoped snapshots: reading a key that was not loaded is a programming error, not a silent null", async () => {
  const { store } = mk();
  await w(store, "conv/a", { n: 1 }, null);
  const s = await store.snapshot({ keys: ["conv/a"] });
  assert.throws(() => s.get("conv/zzz"), /snapshot_key_not_loaded/);
  assert.throws(() => s.keys("conv/"), /snapshot_prefix_not_loaded/);
  const p = await store.snapshot({ prefixes: ["conv/"] });
  assert.equal(p.get("conv/missing"), null, "a key under a loaded prefix that does not exist is null");
  assert.deepEqual(p.keys("conv/"), ["conv/a"]);
  assert.equal(s.covers(["conv/a"]), true);
  assert.equal(s.covers(["conv/a", "conv/b"]), false);
});

test("contract: ttl keys expire, are not listed, can be created again; an expired row is not a guard", async () => {
  let t = 1_000_000;
  const { store, blob } = mk(new FakeDoc(), () => t);
  await w(store, "conv/a", { n: 1 }, null);
  await w(store, "rl/h", { c: 1 }, null, 7200);
  assert.deepEqual(await store.keys(""), ["conv/a"]);
  assert.equal((await store.get<{ c: number }>("rl/h"))!.value.c, 1);
  t += 7200 * 1000 + 1;
  assert.equal(await store.get("rl/h"), null);
  assert.equal((await w(store, "rl/h", { c: 5 }, null, 7200)).ok, true, "expired key can be created again");
  t += 7200 * 1000 + 1;
  assert.equal(await store.purgeExpired(t), 1);
  assert.equal(blob.keysOf("rl/").length, 0);
});

test("contract: concurrent update() calls on different and same keys lose nothing (up to MAX_CAS_ATTEMPTS simultaneous writers)", async () => {
  const { store, deps } = mk();
  await Promise.all([
    ...Array.from({ length: 3 }, () => update<{ c: number }, null>(deps, "ctr/x", (cur) => ({ next: { c: (cur?.c ?? 0) + 1 }, result: null }))),
    ...Array.from({ length: 2 }, (_, i) => update<{ i: number }, null>(deps, `conv/${i}`, () => ({ next: { i }, result: null }))),
  ]);
  assert.equal((await store.get<{ c: number }>("ctr/x"))!.value.c, 3);
  assert.equal((await store.keys("conv/")).length, 2);
});

test("updateMulti: two keys, one commit; no-change writes nothing; seed is conflict-checked and must cover the keys", async () => {
  const { store, blob, deps } = mk();
  const r = await updateMulti(deps, ["a/1", "b/1"], () => ({ next: [{ x: 1 }, { y: 2 }], result: 1 }));
  assert.equal(r.wrote, true);
  assert.equal(blob.ops.write, 1);
  blob.resetOps();
  const n = await updateMulti(deps, ["a/1", "b/1"], () => ({ next: [undefined, undefined], result: 1 }));
  assert.equal(n.wrote, false);
  assert.deepEqual([blob.ops.write, blob.ops.read], [0, 1]);
  const seed = await store.snapshot({ keys: ["a/1"] });
  await update(deps, "a/1", () => ({ next: { x: 2 }, result: null })); // invalidates the seed
  blob.resetOps();
  const s = await updateMulti<number>(deps, ["a/1"], ([cur]) => ({ next: [{ x: (cur as any).x + 10 }], result: (cur as any).x }), { seed });
  assert.equal(s.result, 2, "re-applied on the fresh value after the stale seed lost");
  assert.equal((await store.get<{ x: number }>("a/1"))!.value.x, 12);
  assert.equal(blob.ops.write, 2, "stale seed cost one wasted commit, then one good commit");
  // a seed that does not cover all keys is ignored (fresh read), never trusted
  const partial = await store.snapshot({ keys: ["a/1"] });
  blob.resetOps();
  await updateMulti(deps, ["a/1", "b/1"], () => ({ next: [undefined, undefined], result: 0 }), { seed: partial });
  assert.equal(blob.ops.read, 1);
});

test("updateMulti: retries are bounded (MAX_CAS_ATTEMPTS commits) and the error surfaces", async () => {
  const { blob, deps } = mk();
  blob.beforeWrite = () => { throw new StoreConflictError(); };
  await assert.rejects(() => update(deps, "a/1", () => ({ next: { x: 1 }, result: null })), /cas exhausted/);
  assert.equal(blob.ops.write, MAX_CAS_ATTEMPTS);
});

test("adapter: a transport error is never treated as an empty store; a corrupt row is never overwritten", async () => {
  const blob = new FakeDoc();
  const { store } = mk(blob);
  await w(store, "k/1", { a: 1 }, null);
  const boom = new Error("network down");
  const failing = new RowStore({ read: async () => { throw boom; }, commit: blob.commit.bind(blob), stale: blob.stale.bind(blob), purgeExpired: blob.purgeExpired.bind(blob), touch: blob.touch.bind(blob) }, { now: () => 0 });
  await assert.rejects(() => failing.snapshot({ keys: ["k/1"] }), /network down/);
  blob.setRaw("k/1", "{not json");
  await assert.rejects(() => store.get("k/1"), /state_row_corrupt/);
  assert.deepEqual(await new RowStore(new FakeDoc(), { now: () => 0 }).keys(""), []);
});

test("rows: one row per conversation, a write touches only its own rows", async () => {
  const blob = new FakeDoc();
  const { store } = mk(blob);
  await w(store, "conv/a", { n: 1 }, null);
  await w(store, "conv/b", { n: 1 }, null);
  await w(store, "ctl/controls", { autoReply: "active" }, null);
  assert.equal(blob.size, 3);
  blob.resetOps();
  const a = (await store.get<any>("conv/a"))!;
  await w(store, "conv/a", { n: 2 }, a.version);
  assert.equal(blob.rowsWritten, 1, "rewriting one conversation writes one row (does not grow with the number of conversations)");
});

test("a deleted conversation is dropped on the same commit", async () => {
  const blob = new FakeDoc();
  const { store } = mk(blob);
  await w(store, "conv/c_x", { id: "c_x", state: "pending", updatedAt: 1_000_000, messages: [], seenIds: [], outs: {}, wake: { log: [] } }, null);
  const v = (await store.get<any>("conv/c_x"))!;
  await w(store, "conv/c_x", { ...v.value, deleted: true }, v.version);
  assert.equal(await store.get("conv/c_x"), null);
  assert.equal(blob.size, 0);
});

test("stale(): lists rows not written since the cutoff, oldest first", async () => {
  let t = 1_000_000;
  const blob = new FakeDoc();
  const { store } = mk(blob, () => t);
  await w(store, "conv/old", { n: 1 }, null);
  t += 10_000;
  await w(store, "conv/new", { n: 1 }, null);
  assert.deepEqual(await store.stale("conv/", 1_005_000, 10), ["conv/old"]);
  assert.deepEqual(await store.stale("conv/", 1_020_000, 10), ["conv/old", "conv/new"]);
});
