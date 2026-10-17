import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, cid, claimAndRead, getConv, inboundPayload, makeHarness, post, T0 } from "./helpers";
import { MAX_CAS_ATTEMPTS } from "../lib/store";
import { FakeDoc } from "../lib/fake-doc";
import { claimConversation, finishConversation, getHistory, releaseConversation, sendReply } from "../lib/tools";
import { handleWebhookPost } from "../lib/webhook";
import { signedRequest } from "./helpers";

test("send_reply rejects and returns an inbound that arrived after history was read", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.R1", text: "first" }));
  const lease = await claimAndRead(h);
  await post(h, inboundPayload({ wamid: "wamid.R2", text: "actually, make it Friday", tsMs: T0 }));
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Monday works", idempotency_key: "r1" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unseen_inbound_messages");
  assert.ok(r.hint);
  assert.equal(r.unseen_messages.length, 1);
  assert.equal(r.unseen_messages[0].untrusted, true);
  assert.match(r.unseen_messages[0].text, /actually, make it Friday/);
  assert.equal(h.net.graph.length, 0, "nothing sent");
  // re-read, then the SAME key can be used again (a blocked send leaves no record)
  await getHistory(h.ctx, cid(), lease);
  const ok: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Friday works", idempotency_key: "r1" });
  assert.equal(ok.ok, true);
  assert.equal(h.net.graph.length, 1);
});

test("send without get_history is allowed for messages present at claim", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.C1" }));
  await post(h, inboundPayload({ wamid: "wamid.C2", tsMs: T0 }));
  const c: any = await claimConversation(h.ctx, cid());
  const ok: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: "hello" });
  assert.equal(ok.ok, true);
  assert.equal(h.net.graph.length, 1);
});

test("release after inbound during claim re-wakes", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.RL1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  await post(h, inboundPayload({ wamid: "wamid.RL2", tsMs: T0 }));
  assert.equal(h.queue.length, 0);
  const r: any = await releaseConversation(h.ctx, cid(), lease);
  assert.deepEqual(r, { ok: true, state: "pending", rewoken: true });
  await h.flush();
  assert.equal(h.net.wakes.length, 2);
  assert.equal((await getConv(h)).state, "pending");
});

test("release or finish with nothing new does not re-wake", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.NW1" }));
  await h.flush();
  const l1 = await claimAndRead(h);
  const r: any = await releaseConversation(h.ctx, cid(), l1);
  assert.deepEqual(r, { ok: true, state: "pending", rewoken: false });
  assert.equal(h.queue.length, 0);
  await h.flush();
  assert.equal(h.net.wakes.length, 1);
  const l2 = await claimAndRead(h);
  assert.deepEqual(await finishConversation(h.ctx, cid(), l2), { ok: true, state: "replied" });
  assert.equal(h.queue.length, 0);
  await h.flush();
  assert.equal(h.net.wakes.length, 1);
});

test("finish with unseen inbound re-wakes, debounced after the newest inbound", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.FD1" }));
  await h.flush();
  const lease = await claimAndRead(h);
  h.clock.advance(60000);
  await post(h, inboundPayload({ wamid: "wamid.FD2", tsMs: h.clock.now() }));
  h.clock.advance(3000); // newest inbound was 3 s ago, debounce 8 s -> due in 5 s
  const t = h.clock.now();
  assert.deepEqual(await finishConversation(h.ctx, cid(), lease), { ok: true, state: "pending" });
  const c = await getConv(h);
  assert.equal(c.wake.status, "scheduled");
  assert.equal(c.wake.dueAt, t + 5000, "min(now+debounce, max(now, lastInbound+debounce))");
  await h.flush();
  assert.equal(h.net.wakes.length, 2);
  assert.equal(h.net.wakes[1]!.body.wake_at, new Date(t + 5000).toISOString());
  // newest inbound long ago -> due immediately
  const l2 = await claimAndRead(h);
  h.clock.advance(60000);
  await post(h, inboundPayload({ wamid: "wamid.FD3", tsMs: h.clock.now() - 40000 }));
  h.clock.advance(1);
  const t2 = h.clock.now();
  await finishConversation(h.ctx, cid(), l2);
  assert.equal((await getConv(h)).wake.dueAt, Math.min(t2 + 8000, Math.max(t2, (await getConv(h)).lastInboundAt! + 8000)));
});

test("CAS retries on a store 'conflicting operation' error", async () => {
  const doc = new FakeDoc();
  let fail = 0;
  doc.beforeWrite = () => {
    if (fail > 0) {
      fail--;
      throw new Error("state write rejected: conflicting operation");
    }
  };
  const h = makeHarness({}, { doc });
  fail = 3;
  const res = await post(h, inboundPayload({ wamid: "wamid.CAS1" }));
  assert.equal(res.status, 200);
  assert.equal(doc.ops.write, 4, "3 conflicts + 1 success");
  assert.equal((await getConv(h)).messages.length, 1);
  // exhaustion -> retryable 503 (never 500) so Meta redelivers; bounded: a persistent conflict burns at most MAX_CAS_ATTEMPTS puts
  fail = 100;
  doc.resetOps();
  const bad = await handleWebhookPost(h.ctx, signedRequest(inboundPayload({ wamid: "wamid.CAS2" })));
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("retry-after"), "2");
  assert.equal(await bad.text(), "busy, retry");
  assert.ok(doc.ops.write <= MAX_CAS_ATTEMPTS && doc.ops.write >= 5, `puts ${doc.ops.write}`);
  fail = 0;
  const redelivered = await handleWebhookPost(h.ctx, signedRequest(inboundPayload({ wamid: "wamid.CAS2" })));
  assert.equal(redelivered.status, 200);
  assert.equal((await getConv(h)).messages.length, 2);
});
