// Read receipts + typing indicator on claim, retry with backoff after a rate-limited send, the shorter default reply delay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimConversation, sendReply } from "../lib/tools";
import { activate, cid, getConv, inboundPayload, makeHarness, post, WA, WA2 } from "./helpers";

const ON = { READ_RECEIPTS: "1", TYPING_INDICATOR: "1" };
const typingCalls = (h: ReturnType<typeof makeHarness>) => h.net.graph.filter((c) => c.body?.status === "read");

test("claim marks the customer's latest message read and shows typing, only when the bot may answer", async () => {
  const h = makeHarness(ON);
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.R1" }));
  await post(h, inboundPayload({ wamid: "wamid.R2", tsMs: h.clock.now() + 1 }));
  await h.flush();
  const c: any = await claimConversation(h.ctx, cid());
  assert.equal(c.ok, true);
  await h.flush();
  const t = typingCalls(h);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0]!.body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.R2", typing_indicator: { type: "text" } });
  // test mode, recipient not allowlisted: nothing (no blue ticks or typing from a bot that will not answer)
  const tm = makeHarness({ ...ON, LAUNCH_MODE: "test", TEST_RECIPIENTS: WA2 });
  await activate(tm);
  await post(tm, inboundPayload({ wamid: "wamid.R3" }));
  await tm.flush();
  await claimConversation(tm.ctx, cid());
  await tm.flush();
  assert.equal(typingCalls(tm).length, 0);
  // read receipts only
  const ro = makeHarness({ READ_RECEIPTS: "1", TYPING_INDICATOR: "0" });
  await activate(ro);
  await post(ro, inboundPayload({ wamid: "wamid.R4" }));
  await ro.flush();
  await claimConversation(ro.ctx, cid());
  await ro.flush();
  assert.deepEqual(typingCalls(ro)[0]!.body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.R4" });
  // both off (suite default): nothing
  const off = makeHarness();
  await activate(off);
  await post(off, inboundPayload({ wamid: "wamid.R5" }));
  await off.flush();
  await claimConversation(off.ctx, cid());
  await off.flush();
  assert.equal(typingCalls(off).length, 0);
});

async function claimed(h: ReturnType<typeof makeHarness>) {
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.S1" }));
  await h.flush();
  const c: any = await claimConversation(h.ctx, cid());
  const { getHistory } = await import("../lib/tools");
  await getHistory(h.ctx, cid(), c.lease);
  return c.lease as string;
}

test("rate-limited send (429 or Meta 130429/131056) is retried with backoff and then succeeds; nothing is held", async () => {
  const h = makeHarness({ SEND_RETRY_BASE_MS: "100" });
  const lease = await claimed(h);
  const slept: number[] = [];
  h.ctx.sleep = async (ms) => { slept.push(ms); };
  h.net.graphScript = [{ status: 429 }, { status: 400, code: 130429 }];
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Hello" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(slept, [100, 300], "growing pause");
  assert.equal(h.net.graph.filter((c) => /\/messages$/.test(c.url)).length, 3);
  assert.equal((await getConv(h)).state, "claimed", "not held for review");
});

test("still rate-limited after the retries: failed with send_rate_limited (definitely not sent), never held for review", async () => {
  const h = makeHarness({ SEND_RETRIES: "1" });
  const lease = await claimed(h);
  h.net.graphScript = [{ status: 400, code: 131056 }, { status: 400, code: 131056 }];
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Hello" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "send_rate_limited");
  assert.equal(r.retryable, true);
  assert.equal(r.meta_error_code, 131056);
  const c = await getConv(h);
  assert.notEqual(c.state, "held_for_review");
  assert.equal(Object.values(c.outs)[0]!.error, "send_rate_limited");
  // an ordinary 400 is not retried
  const h2 = makeHarness();
  const l2 = await claimed(h2);
  h2.net.graphScript = [{ status: 400, code: 100 }];
  const r2: any = await sendReply(h2.ctx, { conversation_id: cid(), lease: l2, text: "Hello" });
  assert.equal(r2.error, "send_rejected_http_400");
  assert.equal(h2.net.graph.filter((c) => /\/messages$/.test(c.url)).length, 1);
});

test("default reply delay is 3 s after the first message of a burst", async () => {
  const h = makeHarness({ WAKE_DEBOUNCE_MS: undefined });
  await post(h, inboundPayload({ wamid: "wamid.W1" }));
  assert.equal((await getConv(h)).wake.dueAt, h.clock.now() + 3000);
  assert.ok(WA);
});
