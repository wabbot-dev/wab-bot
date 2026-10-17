// Burst / contention behaviour of the row store: group commit, jittered backoff within a time budget,
// re-read-and-merge on conflict, retryable (never 500) exhaustion, idempotent redelivery, and the writes-per-exchange budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/measure-ops";
import { FakeDoc } from "../lib/fake-doc";
import { createMcpRoute } from "../lib/mcp";
import {
  CAS_BACKOFF_CAP_MS, CAS_BUDGET_MS, casBackoffMs, isStoreBusy, MAX_CAS_ATTEMPTS, StoreBusyError, StoreConflictError, update, updateMulti,
} from "../lib/store";
import { claimConversation } from "../lib/tools";
import { handleWebhookPost } from "../lib/webhook";
import type { Conv } from "../lib/types";
import {
  MCP_TOKEN, WA, WA2, activate, cid, getConv, inboundPayload, makeHarness, post, signedRequest, type Harness,
} from "./helpers";

/** deterministic PRNG (mulberry32) so jitter is varied but the tests are reproducible */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

/** a harness whose store has simulated latency and whose sleeps are (short) real waits that also advance the fake clock */
function contended(doc: FakeDoc, seed: number): Harness {
  const h = makeHarness({}, { doc });
  const rnd = prng(seed);
  h.ctx.rand = rnd;
  h.ctx.sleep = async (ms) => { h.clock.advance(ms); await new Promise((r) => setTimeout(r, ms / 40)); };
  return h;
}
const latency = (rnd: () => number) => async () => { for (let i = Math.floor(rnd() * 4); i >= 0; i--) await tick(); };

const wa = (i: number) => `1555010${String(i).padStart(4, "0")}`;
const idsOf = (c: Conv) => c.messages.filter((m) => m.dir === "in").map((m) => m.id);

test("backoff: full jitter, bounded by the cap, grows with the attempt number", () => {
  for (let a = 1; a <= 30; a++) {
    assert.ok(casBackoffMs(a, 0) >= 5);
    assert.ok(casBackoffMs(a, 0.999999) <= CAS_BACKOFF_CAP_MS);
  }
  assert.ok(casBackoffMs(1, 0.999) < casBackoffMs(4, 0.999));
  assert.equal(CAS_BUDGET_MS, 8000);
  assert.ok(MAX_CAS_ATTEMPTS > 5);
});

test("group commit: concurrent updates on one instance share ONE put and apply on top of each other (counter, no lost update)", async () => {
  const h = makeHarness();
  h.doc.resetOps();
  const bump = () => update<{ c: number }, number>(h.ctx, "ctr/x", (cur) => ({ next: { c: (cur?.c ?? 0) + 1 }, result: (cur?.c ?? 0) + 1 }));
  const rs = await Promise.all(Array.from({ length: 20 }, bump));
  assert.deepEqual(rs.map((r) => r.result).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1), "each saw its predecessor's result");
  assert.equal((await h.store.get<{ c: number }>("ctr/x"))!.value.c, 20);
  assert.equal(h.doc.ops.write, 1, "20 updates, 1 put");
  assert.equal(h.doc.ops.read, 1 + 1, "1 read for the batch (+1 for the assertion read)");
});

test("group commit: one failing function does not sink the batch; no-write updates ride along for free", async () => {
  const h = makeHarness();
  h.doc.resetOps();
  const ok = update<{ n: number }, string>(h.ctx, "a/1", () => ({ next: { n: 1 }, result: "wrote" }));
  const boom = update<{ n: number }, string>(h.ctx, "a/2", () => { throw new Error("fn exploded"); });
  const noop = update<{ n: number }, string>(h.ctx, "a/3", () => ({ next: undefined, result: "noop" }));
  const res = await Promise.allSettled([ok, boom, noop]);
  assert.equal(res[0]!.status, "fulfilled");
  assert.equal(res[1]!.status, "rejected");
  assert.equal(res[2]!.status === "fulfilled" && (res[2] as PromiseFulfilledResult<any>).value.wrote, false);
  assert.equal(h.doc.ops.write, 1);
  assert.equal((await h.store.get<{ n: number }>("a/1"))!.value.n, 1);
});

test("one instance, 60 concurrent signed webhooks across 20 conversations: all 200, nothing lost or duplicated, a handful of puts", async () => {
  const doc = new FakeDoc();
  doc.latency = latency(prng(7));
  const h = contended(doc, 11);
  doc.resetOps();
  const want = new Map<string, string[]>();
  const reqs = Array.from({ length: 60 }, (_, k) => {
    const w = wa(1 + (k % 20));
    const id = `wamid.G${k}`;
    (want.get(w) ?? want.set(w, []).get(w)!).push(id);
    return post(h, inboundPayload({ wamid: id, from: w }));
  });
  const res = await Promise.all(reqs);
  assert.deepEqual([...new Set(res.map((r) => r.status))], [200]);
  assert.ok(doc.ops.write <= 3, `group commit should need very few puts, got ${doc.ops.write}`);
  for (const [w, ids] of want) assert.deepEqual(idsOf(await getConv(h, w)).sort(), [...ids].sort(), w);
});

test("one conversation, concurrent deliveries incl. the SAME wamid sent 5x at once: each id stored exactly once, seq contiguous", async () => {
  const doc = new FakeDoc();
  doc.latency = latency(prng(3));
  const h = contended(doc, 5);
  const jobs: Promise<Response>[] = [];
  for (let k = 0; k < 12; k++) jobs.push(post(h, inboundPayload({ wamid: `wamid.S${k}` })));
  for (let d = 0; d < 5; d++) jobs.push(post(h, inboundPayload({ wamid: "wamid.SAME" })));
  assert.deepEqual([...new Set((await Promise.all(jobs)).map((r) => r.status))], [200]);
  const c = await getConv(h);
  const ids = idsOf(c);
  assert.equal(ids.length, 13);
  assert.equal(new Set(ids).size, 13);
  assert.equal(c.inSeq, 13);
});

test("MULTI-instance contention: 8 instances x 15 concurrent webhooks on one document -> zero 5xx, every id exactly once", async () => {
  const doc = new FakeDoc();
  const lat = prng(99);
  doc.latency = latency(lat);
  const insts = Array.from({ length: 8 }, (_, i) => contended(doc, 100 + i));
  const want = new Map<string, string[]>();
  const reqs: Promise<Response>[] = [];
  insts.forEach((h, i) => {
    for (let k = 0; k < 15; k++) {
      const w = wa(1 + ((i * 15 + k) % 20));
      const id = `wamid.M${i}.${k}`;
      (want.get(w) ?? want.set(w, []).get(w)!).push(id);
      reqs.push(post(h, inboundPayload({ wamid: id, from: w })));
    }
  });
  // plus duplicate deliveries of the same ids through other instances
  for (let d = 0; d < 10; d++) reqs.push(post(insts[(d + 3) % 8]!, inboundPayload({ wamid: `wamid.M${d % 8}.${d}`, from: wa(1 + (((d % 8) * 15 + d) % 20)) })));
  const statuses = (await Promise.all(reqs)).map((r) => r.status);
  assert.equal(statuses.filter((s) => s >= 500).length, 0, JSON.stringify(statuses.filter((s) => s !== 200)));
  for (const [w, ids] of want) {
    const got = idsOf(await getConv(insts[0]!, w));
    assert.deepEqual([...got].sort(), [...ids].sort(), `${w}: lost or duplicated`);
  }
  assert.ok(doc.ops.write < 120 + 40, `puts ${doc.ops.write}`);
});

test("conflict storm: 3 lost races, then success re-applies on FRESH state (rival writes kept, ours merged)", async () => {
  const doc = new FakeDoc();
  const h = makeHarness({}, { doc });
  const rival = makeHarness({}, { doc });
  await post(h, inboundPayload({ wamid: "wamid.R0" }));
  // a rival instance commits a new message between our read and our put, three times in a row
  const realGet = doc.read.bind(doc);
  let wins = 0;
  doc.read = async (...a: Parameters<FakeDoc["read"]>) => {
    const r = await realGet(...a);
    if (wins < 3) {
      wins++;
      const n = wins;
      doc.read = realGet; // let the rival's own read through untouched
      await post(rival, inboundPayload({ wamid: `wamid.RIV${n}` }));
      doc.read = guarded;
    }
    return r;
  };
  const guarded = doc.read;
  const res = await post(h, inboundPayload({ wamid: "wamid.OURS" }));
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(await getConv(h)).sort(), ["wamid.OURS", "wamid.R0", "wamid.RIV1", "wamid.RIV2", "wamid.RIV3"]);
  assert.equal(wins, 3);
});

test("exhaustion: persistent conflicts -> retryable 503 + Retry-After inside the ~8 s budget, nothing stored, redelivery is idempotent", async () => {
  const doc = new FakeDoc();
  const h = makeHarness({}, { doc });
  h.ctx.rand = prng(1);
  await post(h, inboundPayload({ wamid: "wamid.E0" }));
  doc.resetOps();
  doc.beforeWrite = () => { throw new StoreConflictError(); };
  const t0 = h.clock.now();
  const body = { wamid: "wamid.E1" };
  const bad = await handleWebhookPost(h.ctx, signedRequest(inboundPayload(body)));
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("retry-after"), "2");
  const spent = h.clock.now() - t0;
  assert.ok(spent <= CAS_BUDGET_MS + CAS_BACKOFF_CAP_MS, `spent ${spent} ms of fake time`);
  assert.ok(doc.ops.write <= MAX_CAS_ATTEMPTS);
  assert.ok(h.logs.some((l) => l.event === "webhook_busy"));
  assert.ok(!h.logs.some((l) => l.event === "webhook_error"));
  doc.beforeWrite = undefined;
  assert.deepEqual(idsOf(await getConv(h)), ["wamid.E0"], "failed attempt stored nothing");
  // Meta redelivers the same payload (possibly several times): exactly one copy ends up stored
  for (let i = 0; i < 3; i++) assert.equal((await handleWebhookPost(h.ctx, signedRequest(inboundPayload(body)))).status, 200);
  assert.deepEqual(idsOf(await getConv(h)), ["wamid.E0", "wamid.E1"]);
  assert.equal((await getConv(h)).inSeq, 2);
});

test("exhaustion with a multi-sender payload: redelivery after a partial earlier success dedupes per message", async () => {
  const h = makeHarness();
  const two = (id1: string, id2: string) => {
    const p = inboundPayload({ wamid: id1, from: WA });
    const v = (p.entry[0]!.changes[0] as any).value;
    v.messages.push({ id: id2, from: WA2, type: "text", timestamp: String(Math.floor(h.clock.now() / 1000)), text: { body: "second sender" } });
    v.contacts.push({ profile: { name: "Other" }, wa_id: WA2 });
    return p;
  };
  await post(h, inboundPayload({ wamid: "wamid.P1", from: WA })); // as if the first half had committed before a failure
  assert.equal((await post(h, two("wamid.P1", "wamid.P2"))).status, 200); // the redelivered full payload
  assert.deepEqual(idsOf(await getConv(h, WA)), ["wamid.P1"]);
  assert.deepEqual(idsOf(await getConv(h, WA2)), ["wamid.P2"]);
});

test("transient read errors are retried within the budget; a corrupt row is not", async () => {
  const doc = new FakeDoc();
  const h = makeHarness({}, { doc });
  const realGet = doc.read.bind(doc);
  let fail = 2;
  doc.read = async (...a: Parameters<FakeDoc["read"]>) => { if (fail-- > 0) throw new Error("fetch failed"); return realGet(...a); };
  assert.equal((await post(h, inboundPayload({ wamid: "wamid.RD1" }))).status, 200);
  const convKey = doc.keysOf("conv/")[0]!;
  doc.setRaw(convKey, "{not json");
  const res = await post(h, inboundPayload({ wamid: "wamid.RD2" }));
  assert.equal(res.status, 500, "a corrupt row stays a hard error (and is never overwritten)");
  assert.equal(doc.rawOf(convKey), "{not json", "the corrupt row was not overwritten");
});

test("concurrent claims of one conversation (same instance): exactly one lease, the others get not_claimable", async () => {
  const doc = new FakeDoc();
  doc.latency = latency(prng(21));
  const h = contended(doc, 8);
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.CL1" }));
  const rs: any[] = await Promise.all(Array.from({ length: 6 }, () => claimConversation(h.ctx, cid())));
  assert.equal(rs.filter((r) => r.ok && r.lease).length, 1);
  assert.equal(rs.filter((r) => !r.ok && /not_claimable:claimed/.test(r.error)).length, 5);
});

test("claims racing across 4 instances: exactly one lease overall, every result is a lease or a named error (never empty)", async () => {
  const doc = new FakeDoc();
  doc.latency = latency(prng(33));
  const insts = Array.from({ length: 4 }, (_, i) => contended(doc, 40 + i));
  await activate(insts[0]!);
  await post(insts[0]!, inboundPayload({ wamid: "wamid.CL2" }));
  const rs: any[] = await Promise.all(insts.flatMap((h) => [claimConversation(h.ctx, cid()), claimConversation(h.ctx, cid())]));
  assert.equal(rs.filter((r) => r.ok && r.lease).length, 1);
  for (const r of rs) assert.ok(r.lease || typeof r.error === "string", JSON.stringify(r));
});

test("MCP: a store that stays busy yields a structured retryable JSON result, not an opaque tool error (the 'empty claim' case)", async () => {
  const doc = new FakeDoc();
  const h = makeHarness({}, { doc });
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.MB1" }));
  const route = createMcpRoute(() => h.ctx);
  doc.beforeWrite = () => { throw new StoreConflictError(); };
  const res = await route(new Request("https://x.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claim_conversation", arguments: { conversation_id: cid() } } }),
  }));
  const txt = await res.text();
  const line = txt.split("\n").find((l) => l.startsWith("data:"));
  const rpc = JSON.parse(line ? line.slice(5) : txt);
  assert.notEqual(rpc.result.isError, true);
  const out = JSON.parse(rpc.result.content[0].text);
  assert.deepEqual([out.ok, out.error, out.retryable], [false, "store_busy", true]);
  doc.beforeWrite = undefined;
  assert.equal(((await claimConversation(h.ctx, cid())) as any).ok, true, "nothing was applied by the busy attempt; a plain retry claims");
});

test("StoreBusyError is recognised across realms by name", () => {
  assert.ok(isStoreBusy(new StoreBusyError()));
  const e = new Error("x"); e.name = "StoreBusyError";
  assert.ok(isStoreBusy(e));
  assert.ok(!isStoreBusy(new Error("cas exhausted")));
});

// ---------------------------------------------------------------- writes per exchange (design budget: <= 5)
export const MAX_WRITES_PER_EXCHANGE = 5;
const assertWritesPerExchange = (n: number) => assert.ok(n <= MAX_WRITES_PER_EXCHANGE, `writes per exchange ${n} > ${MAX_WRITES_PER_EXCHANGE}`);

test("BUDGET: a full exchange (inbound, wake, claim, history, send, 3 statuses, finish) makes <= 5 writes, and still does with replies", async () => {
  const m = await measure();
  assertWritesPerExchange(m.exchange.writes);
  assert.equal(m.exchange.writes, 5);
});

test("BUDGET: the guard really fails above 5 (a sixth write per exchange is caught)", async () => {
  assert.throws(() => assertWritesPerExchange(6), /writes per exchange 6 > 5/);
  // and a regression that adds a put to the inbound path is visible to measure()
  const m = await measure();
  assert.throws(() => assertWritesPerExchange(m.exchange.writes + 1));
});

test("BUDGET: retries do not inflate the SUCCESSFUL write count: one conflict costs one extra (failed) put, one committed write", async () => {
  const doc = new FakeDoc();
  const h = makeHarness({}, { doc });
  let lose = 1;
  doc.beforeWrite = () => { if (lose-- > 0) throw new StoreConflictError(); };
  doc.resetOps();
  assert.equal((await post(h, inboundPayload({ wamid: "wamid.BW1" }))).status, 200);
  assert.equal(doc.ops.write, 2);
  assert.equal(doc.keysOf("conv/").length, 1);
  assert.equal((await getConv(h)).messages.length, 1);
});
