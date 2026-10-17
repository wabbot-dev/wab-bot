// Store op-budget tests (in-memory DocBackend counting reads and conditional writes, fake clock, mocked network).
// On Cloudflare each read()/write() is one Durable Object request (free plan: 100,000 requests/day).
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/measure-ops";
import { adminGet } from "../lib/admin";
import { compactConv, IDLE_DROP_MS, IDLE_TRIM_MS } from "../lib/conv";
import { getControls, getHistory, listPending, claimConversation, sendReply } from "../lib/tools";
import { handleWebhookPost } from "../lib/webhook";
import { MAX_REARMS, retryFailedWakes } from "../lib/wake";
import { REJECTIONS_KEY } from "../lib/store";
import {
  WA, WA2, activate, adminReq, cid, claimAndRead, getConv, inboundPayload, makeHarness, post, signedRequest, statusPayload,
} from "./helpers";

const ops = async (h: ReturnType<typeof makeHarness>, f: () => Promise<unknown>) => {
  h.doc.resetOps();
  await f();
  return { writes: h.doc.ops.write, reads: h.doc.ops.read };
};

test("OPS typical exchange (inbound + wake + list + claim + history + send + 3 statuses + finish) = 5 conditional writes", async () => {
  const m = await measure();
  assert.equal(m.exchange.writes, 5, JSON.stringify(m.steps));
  assert.ok(m.exchange.reads <= 10, JSON.stringify(m.steps));
  const s = m.steps;
  assert.equal(s["inbound webhook"]!.writes, 1);
  assert.equal(s["debounced wake + retry pass"]!.writes, 0, "a successful wake writes nothing");
  assert.equal(s["claim_conversation"]!.writes, 1);
  assert.equal(s["send_reply #1"]!.writes, 2, "one reserve (before the Graph call) + one outcome");
  assert.equal(s["finish_conversation"]!.writes, 1);
  for (const k of ["list_pending", "get_history", "status sent #1", "status delivered #1", "status read #1", "admin overview", "get_controls"]) {
    assert.equal(s[k]!.writes, 0, k);
  }
});

test("OPS each additional reply in the same chat costs exactly 2 more puts", async () => {
  const one = await measure({ replies: 1 });
  const two = await measure({ replies: 2 });
  const three = await measure({ replies: 3 });
  assert.equal(two.exchange.writes - one.exchange.writes, 2);
  assert.equal(three.exchange.writes - two.exchange.writes, 2);
});

test("OPS a full exchange: every request makes at most one conditional write (send_reply two)", async () => {
  const m = await measure({ replies: 2 });
  for (const [k, v] of Object.entries(m.steps)) {
    if (!k.startsWith("send_reply")) assert.ok(v.writes <= 1, k);
  }
  assert.ok(m.steps["send_reply #1"]!.writes <= 2);
});

test("OPS burst of 3 messages: 1 put per webhook, one wake, wake success writes nothing, claim records it", async () => {
  const h = makeHarness();
  await activate(h);
  let puts = 0;
  for (const [i, id] of ["wamid.B1", "wamid.B2", "wamid.B3"].entries()) {
    puts += (await ops(h, () => post(h, inboundPayload({ wamid: id })))).writes;
    h.clock.advance(2000);
    assert.equal(i < 3, true);
  }
  assert.equal(puts, 3);
  const w = await ops(h, () => h.flush());
  assert.equal(w.writes, 0);
  assert.equal(h.net.wakes.length, 1);
  assert.equal(h.net.wakes[0]!.body.pending_messages, 3);
  const c = await ops(h, () => claimConversation(h.ctx, cid()));
  assert.equal(c.writes, 1);
  const cv = await getConv(h);
  assert.equal(cv.wake.status, "sent");
  assert.equal(cv.wake.log.at(-1)!.ok, true);
});

test("OPS duplicate delivery (Meta redelivery) writes nothing", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.DUP" }));
  const o = await ops(h, () => post(h, inboundPayload({ wamid: "wamid.DUP" })));
  assert.equal(o.writes, 0);
  assert.equal(o.reads, 1);
});

test("OPS status webhooks: confirmed sends cost 0 puts (even after a cold start); failed and uncertain are persisted", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.I1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "ok" });
  // same instance: no read at all
  for (const st of ["sent", "delivered", "read"]) {
    const o = await ops(h, () => post(h, statusPayload({ wamid: "wamid.OUT1", status: st, rk: r.reply_key })));
    assert.deepEqual([o.writes, o.reads], [0, 0], st);
  }
  // cold instance: 1 read, still no write
  h.ctx.state.confirmed.clear();
  for (const st of ["sent", "delivered", "read"]) {
    const o = await ops(h, () => post(h, statusPayload({ wamid: "wamid.OUT1", status: st, rk: r.reply_key })));
    assert.deepEqual([o.writes, o.reads], [0, 1], st);
  }
  const f = await ops(h, () => post(h, statusPayload({ wamid: "wamid.OUT1", status: "failed", rk: r.reply_key })));
  assert.equal(f.writes, 1);
  assert.equal(Object.values((await getConv(h)).outs)[0]!.status, "failed");
  // uncertain send: the receipt IS persisted (reconcile)
  const h2 = makeHarness();
  await activate(h2);
  await post(h2, inboundPayload({ wamid: "wamid.U1" }));
  await h2.flush();
  const l2 = await claimAndRead(h2);
  h2.net.graphThrows = true;
  const u: any = await sendReply(h2.ctx, { conversation_id: cid(), lease: l2, text: "maybe" });
  assert.equal(u.error, "send_uncertain_held_for_review");
  const rk = Object.keys((await getConv(h2)).outs)[0]!;
  const rec = await ops(h2, () => post(h2, statusPayload({ wamid: "wamid.LATE", status: "delivered", rk })));
  assert.equal(rec.writes, 1);
});

test("OPS read paths (admin, list_pending, get_controls, get_history without new inbound) = 1 read, 0 writes", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.R1" }));
  await post(h, inboundPayload({ wamid: "wamid.R2", from: WA2 }));
  const lease = await claimAndRead(h);
  for (const f of [
    () => adminGet(h.ctx, adminReq("GET")),
    () => adminGet(h.ctx, adminReq("GET", undefined, undefined, `?conversation=${cid()}`)),
    () => listPending(h.ctx),
    () => getControls(h.ctx, cid()),
    () => getHistory(h.ctx, cid(), lease),
  ]) {
    const o = await ops(h, f);
    assert.deepEqual([o.writes, o.reads], [0, 1]);
  }
});

test("OPS signature rejections never touch the store; the count is flushed with the next essential write", async () => {
  const h = makeHarness();
  await activate(h);
  const body = JSON.stringify(inboundPayload({ wamid: "wamid.X0" }));
  const o = await ops(h, async () => {
    for (let i = 0; i < 50; i++) await handleWebhookPost(h.ctx, signedRequest(null, "wrong-secret-wrong-secret", body));
  });
  assert.deepEqual([o.writes, o.reads], [0, 0]);
  const ov0: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.equal(ov0.rejections.count, 50, "visible before it is persisted");
  const w = await ops(h, () => post(h, inboundPayload({ wamid: "wamid.X1" })));
  assert.equal(w.writes, 1, "the flush rides on the inbound write");
  assert.equal((await h.store.get<{ count: number }>(REJECTIONS_KEY))!.value.count, 50);
  const ov: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.equal(ov.rejections.count, 50, "not double counted");
  assert.equal(h.ctx.state.rejPending, 0);
});

test("OPS failed wake costs 1 put (backoff); a retry pass with nothing due costs 0 puts", async () => {
  const h = makeHarness();
  await activate(h);
  h.net.wakeStatus = 503;
  const w = await ops(h, async () => { await post(h, inboundPayload({ wamid: "wamid.F" })); await h.flush(); });
  assert.equal(w.writes, 2, "inbound + failure bookkeeping");
  const r = await ops(h, () => retryFailedWakes(h.ctx));
  assert.deepEqual([r.writes, r.reads], [0, 1]);
});

test("OPS retry pass re-arms ALL due conversations with ONE put", async () => {
  const h = makeHarness();
  h.net.wakeStatus = 500;
  for (const [i, wa] of ["15550000011", "15550000012", "15550000013"].entries()) await post(h, inboundPayload({ wamid: `wamid.M${i}`, from: wa }));
  await h.flush();
  h.clock.advance(3 * 60 * 1000);
  h.net.wakeStatus = 200;
  const o = await ops(h, async () => assert.equal(await retryFailedWakes(h.ctx), 3));
  assert.equal(o.writes, 1, "one arm put; successful wakes write nothing");
  assert.equal(h.net.wakes.length, 6);
});

test("WAKE a successful but never-claimed wake is re-fired by the retry pass after STALE_WAKE_MS, at most MAX_REARMS times", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.L1" }));
  await h.flush();
  assert.equal(h.net.wakes.length, 1);
  h.clock.advance(60 * 1000);
  assert.equal(await retryFailedWakes(h.ctx), 0, "not stale yet");
  for (let i = 1; i <= MAX_REARMS; i++) {
    h.clock.advance(5 * 60 * 1000 + 1000);
    assert.equal(await retryFailedWakes(h.ctx), 1, `re-arm ${i}`);
  }
  h.clock.advance(5 * 60 * 1000 + 1000);
  assert.equal(await retryFailedWakes(h.ctx), 0, "capped: a stuck chat cannot drain the op budget");
  assert.equal(h.net.wakes.length, 1 + MAX_REARMS);
});

test("WAKE a lost runner (instance died while sleeping) never fires twice and is repaired by the retry pass", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.D1" }));
  h.queue.length = 0; // the instance that armed the wake died: nobody fires it
  h.clock.advance(6 * 60 * 1000);
  assert.equal(await retryFailedWakes(h.ctx), 1);
  assert.equal(h.net.wakes.length, 1);
});

test("CAS concurrent webhooks for two patients on one store both land: no lost update, one wake each", async () => {
  const h = makeHarness();
  await activate(h);
  await Promise.all([
    post(h, inboundPayload({ wamid: "wamid.C1", from: WA })),
    post(h, inboundPayload({ wamid: "wamid.C2", from: WA2 })),
  ]);
  assert.equal((await listPending(h.ctx)).length, 2);
  await h.flush();
  assert.equal(h.net.wakes.length, 2);
  await Promise.all([post(h, inboundPayload({ wamid: "wamid.C3" })), post(h, inboundPayload({ wamid: "wamid.C3" }))]);
  assert.equal((await getConv(h)).messages.filter((m) => m.id === "wamid.C3").length, 1);
});

test("CAS two concurrent send_reply calls with the same idempotency key reach Meta once", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.S1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  const args = { conversation_id: cid(), lease, text: "hello", idempotency_key: "same" };
  const [a, b]: any[] = await Promise.all([sendReply(h.ctx, args), sendReply(h.ctx, args)]);
  assert.equal(h.net.graph.length, 1);
  assert.equal([a, b].filter((x) => x.ok === true && !x.idempotent_replay).length, 1);
});

test("CAS the reply slot, the per-conversation rate slot and the hourly counter are taken in ONE put", async () => {
  const h = makeHarness({ RATE_GLOBAL_PER_HOUR: "2" });
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.G1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  const o = await ops(h, () => sendReply(h.ctx, { conversation_id: cid(), lease, text: "one" }));
  assert.equal(o.writes, 2);
  const hours = (await h.store.snapshot({ prefixes: ["rl/"] })).keys("rl/");
  assert.deepEqual(hours, [], "counters are expiring entries and are not listed");
  await sendReply(h.ctx, { conversation_id: cid(), lease, text: "two" });
  const third: any = await ops(h, async () => assert.equal(((await sendReply(h.ctx, { conversation_id: cid(), lease, text: "three" })) as any).error, "rate_limited_global"));
  assert.equal(third.writes, 0, "a refused send writes nothing (no slot to refund)");
  assert.equal(h.net.graph.length, 2);
});

test("BOUNDS a conversation row keeps <= maxMessages per conversation and a bounded dedupe ring (older ids still deduped inside the ring)", async () => {
  const h = makeHarness({ MAX_MESSAGES: "50" });
  await post(h, inboundPayload({ wamid: "wamid.M0" }));
  for (let i = 1; i < 70; i++) { h.clock.advance(1000); await post(h, inboundPayload({ wamid: `wamid.M${i}` })); }
  const c = await getConv(h);
  assert.equal(c.messages.length, 50);
  assert.ok(c.seenIds.length <= 200);
  assert.ok(c.seenIds.every((x) => /^[0-9a-f]{12}$/.test(x)), "ids are stored as short hashes");
  const o = await ops(h, () => post(h, inboundPayload({ wamid: "wamid.M1" }))); // trimmed from history, still deduped
  assert.equal(o.writes, 0);
});

test("BOUNDS idle replied conversations are trimmed after 14 days and dropped after 180; active ones never", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  const base: any = {
    id: "c_x", state: "replied", updatedAt: now - IDLE_TRIM_MS - 1000, lastInboundAt: now - IDLE_TRIM_MS - 1000,
    messages: Array.from({ length: 40 }, (_, i) => ({ id: String(i) })), seenIds: ["a"], sends: [1], outs: { k: {} }, wake: { status: "sent", attempts: 0, log: [{}] },
  };
  const t: any = compactConv(base, now);
  assert.equal(t.messages.length, 10);
  assert.deepEqual([t.seenIds.length, Object.keys(t.outs).length, t.wake.log.length], [0, 0, 0]);
  assert.equal(base.messages.length, 40, "returns a copy");
  assert.equal(compactConv({ ...base, updatedAt: now - IDLE_DROP_MS - 1, lastInboundAt: 0 }, now), null);
  assert.equal(compactConv({ ...base, state: "pending" }, now), undefined);
  assert.equal(compactConv({ ...base, state: "held_for_review", updatedAt: now - IDLE_TRIM_MS * 2, lastInboundAt: now - IDLE_TRIM_MS * 2 }, now), undefined, "held conversations are never trimmed before 180 idle days");
  assert.equal(compactConv({ ...base, state: "held_for_review", updatedAt: 0, lastInboundAt: 0 }, now), null, "any state is dropped after 180 idle days (retention)");
  assert.equal(compactConv({ ...base, updatedAt: now, lastInboundAt: now, deleted: true }, now), null, "admin delete_conversation erases on the next commit");
  assert.equal(compactConv({ ...base, updatedAt: now, lastInboundAt: now }, now), undefined);
});

test("SAFETY an uncertain send keeps its hold across replays and never re-sends ", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.H1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  h.net.graphStatus = 500;
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "x", idempotency_key: "k1" });
  assert.equal(r.error, "send_uncertain_held_for_review");
  h.net.graphStatus = 200;
  const again: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "x", idempotency_key: "k1" });
  assert.equal(again.ok, false);
  assert.equal(h.net.graph.length, 1);
  assert.equal((await getConv(h)).state, "held_for_review");
});

test("RETENTION the daily pass trims idle replied conversations, drops 180-day-old ones, leaves fresh ones alone and purges expired counters", async () => {
  const { retentionPass } = await import("../lib/retention");
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.RT1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  await sendReply(h.ctx, { conversation_id: cid(), lease, text: "hi" });
  await (await import("../lib/tools")).finishConversation(h.ctx, cid(), lease);
  await post(h, inboundPayload({ wamid: "wamid.RT2", from: WA2 }));
  await h.flush();
  assert.equal(h.doc.keysOf("conv/").length, 2);
  // nothing is stale yet
  assert.deepEqual((await retentionPass(h.ctx)).changed, 0);
  h.clock.advance(IDLE_TRIM_MS + 86_400_000);
  h.doc.resetOps();
  const r = await retentionPass(h.ctx);
  assert.equal(r.examined, 2);
  assert.equal(r.changed, 1, "only the replied conversation was trimmed (the pending one is kept)");
  assert.ok(h.doc.ops.write <= 2, "one conditional write for the changed conversation + one touch for the unchanged one");
  h.clock.advance(IDLE_DROP_MS);
  const r2 = await retentionPass(h.ctx);
  assert.equal(r2.changed, 2);
  assert.equal(h.doc.keysOf("conv/").length, 0, "everything idle > 180 days is gone");
});

test("SCALE an inbound webhook reads and writes ONE conversation no matter how many conversations are stored", async () => {
  const h = makeHarness();
  for (let i = 0; i < 300; i++) {
    h.doc.setRaw(`conv/c_filler${i}`, JSON.stringify({ id: `c_filler${i}`, state: "replied", updatedAt: h.clock.t, messages: Array.from({ length: 20 }, (_, j) => ({ id: `m${j}`, text: "x".repeat(200) })), seenIds: [], outs: {}, wake: { log: [] } }));
  }
  assert.equal(h.doc.size, 300);
  h.doc.resetOps();
  assert.equal((await post(h, inboundPayload({ wamid: "wamid.SC1" }))).status, 200);
  assert.equal(h.doc.rowsWritten, 1, "one conversation row written");
  assert.ok(h.doc.rowsRead <= 2, `rows read ${h.doc.rowsRead}`);
});

test("RETENTION rows that need no change are marked examined, so more than one batch of idle pending conversations never starves the rest", async () => {
  const { retentionPass, RETENTION_BATCH } = await import("../lib/retention");
  const h = makeHarness();
  const n = RETENTION_BATCH + 50;
  for (let i = 0; i < n; i++) {
    h.doc.setRaw(`conv/c_p${i}`, JSON.stringify({ id: `c_p${i}`, state: "pending", updatedAt: h.clock.t, messages: [], seenIds: [], outs: {}, wake: { log: [] } }));
  }
  // one genuinely droppable conversation that sorts after the batch (written later than the others)
  h.clock.advance(IDLE_TRIM_MS + 86_400_000);
  const r1 = await retentionPass(h.ctx);
  assert.deepEqual([r1.examined, r1.changed], [RETENTION_BATCH, 0]);
  const r2 = await retentionPass(h.ctx);
  assert.deepEqual([r2.examined, r2.changed], [50, 0], "the second pass moves on to the rest");
  const r3 = await retentionPass(h.ctx);
  assert.equal(r3.examined, 0, "all were examined; nothing is re-read until another trim period has passed");
  assert.equal(h.doc.keysOf("conv/").length, n, "nothing was changed or deleted");
  h.clock.advance(IDLE_DROP_MS);
  const r4 = await retentionPass(h.ctx);
  const r5 = await retentionPass(h.ctx);
  assert.equal(r4.changed + r5.changed, n);
  assert.equal(h.doc.keysOf("conv/").length, 0);
});
