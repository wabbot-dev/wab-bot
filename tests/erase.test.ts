// Per-conversation erase: DELETE /api/admin/conversations/<id> and the equivalent POST /api/admin delete_conversation action.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminErase, adminGet, adminPost } from "../lib/admin";
import { claimConversation, sendReply } from "../lib/tools";
import {
  ADMIN_TOKEN, WA, WA2, activate, adminReq, cid, claimAndRead, inboundPayload, makeHarness, post,
} from "./helpers";

const SECRET_TEXT = "my private diagnosis text 98765";

const erase = (h: ReturnType<typeof makeHarness>, id: string, token = ADMIN_TOKEN) =>
  adminErase(h.ctx, new Request(`https://bridge.example.test/api/admin/conversations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }), id);

test("erase: auth is required, ids are validated, unknown conversations are 404", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.ER0", text: SECRET_TEXT, name: "Pat Private" }));
  await h.flush();
  const id = cid();
  const noAuth = await adminErase(h.ctx, new Request("https://bridge.example.test/api/admin/conversations/" + id, { method: "DELETE" }), id);
  assert.equal(noAuth.status, 401);
  assert.equal((await erase(h, id, "wrong-token-wrong-token")).status, 401);
  assert.equal((await erase(makeHarness({ ADMIN_TOKEN: "short" }), id, "short")).status, 401, "a short ADMIN_TOKEN refuses everything");
  assert.equal((await erase(h, "not-a-conversation-id")).status, 400);
  assert.equal((await erase(h, "c_" + "g".repeat(20))).status, 400);
  assert.equal((await erase(h, "c_" + "0".repeat(20))).status, 404);
  assert.ok(h.doc.keysOf("conv/").includes(`conv/${id}`), "a refused erase changed nothing");
});

test("erase: removes the customer's number, name and message text; other customers and controls are untouched", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.ER1", text: SECRET_TEXT, name: "Pat Private" }));
  await post(h, inboundPayload({ wamid: "wamid.ER2", text: "someone else", from: WA2, name: "Other Customer" }));
  await h.flush();
  assert.equal(h.doc.keysOf("conv/").length, 2);
  const r = await erase(h, cid());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, deleted: true });
  const keys = h.doc.keysOf("conv/");
  assert.deepEqual(keys, [`conv/${cid(WA2)}`]);
  // nothing of the erased customer remains in ANY stored row (rows are JSON)
  for (const k of h.doc.keysOf("")) {
    const raw = h.doc.rawOf(k) ?? "";
    for (const needle of [SECRET_TEXT, "Pat Private", WA]) assert.equal(raw.includes(needle), false, `${k} still contains ${needle}`);
  }
  // the other customer is intact and controls survive
  const ov: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.equal(ov.conversations.length, 1);
  assert.equal(ov.controls.auto_reply, "active");
  assert.equal((await adminGet(h.ctx, adminReq("GET", undefined, ADMIN_TOKEN, `?conversation=${cid()}`))).status, 404);
  // erasing again is a 404, not an error
  assert.equal((await erase(h, cid())).status, 404);
});

test("erase: the POST action and the DELETE endpoint behave the same", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.ER3", text: SECRET_TEXT }));
  await h.flush();
  const r = await adminPost(h.ctx, adminReq("POST", { action: "delete_conversation", conversation_id: cid() }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, deleted: true });
  assert.deepEqual(h.doc.keysOf("conv/"), []);
  assert.equal((await adminPost(h.ctx, adminReq("POST", { action: "delete_conversation", conversation_id: cid() }))).status, 404);
});

test("erase: a claimed conversation is erased and the agent's lease stops working", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.ER4", text: SECRET_TEXT }));
  await h.flush();
  const lease = await claimAndRead(h);
  assert.equal((await erase(h, cid())).status, 200);
  const sent: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "hello" });
  assert.deepEqual(sent, { ok: false, error: "not_found" });
  assert.equal(h.net.graph.length, 0, "nothing was sent to Meta for an erased conversation");
  const again: any = await claimConversation(h.ctx, cid());
  assert.equal(again.ok, false);
});

test("erase: a debounced wake that was already armed does not fire for an erased conversation", async () => {
  const h = makeHarness({ WAKE_DEBOUNCE_MS: "5000" });
  await post(h, inboundPayload({ wamid: "wamid.ER5", text: SECRET_TEXT }));
  assert.equal(h.queue.length, 1, "the inbound message armed one wake");
  assert.equal((await erase(h, cid())).status, 200);
  await h.flush();
  assert.equal(h.net.wakes.length, 0);
});

test("erase: a later message from the same customer starts a fresh conversation without the old text", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.ER6", text: SECRET_TEXT }));
  await h.flush();
  assert.equal((await erase(h, cid())).status, 200);
  await post(h, inboundPayload({ wamid: "wamid.ER7", text: "hello again" }));
  await h.flush();
  const raw = h.doc.rawOf(`conv/${cid()}`) ?? "";
  assert.ok(raw.includes("hello again"));
  assert.equal(raw.includes(SECRET_TEXT), false);
  // Known limit (documented in docs/PRIVACY.md): de-duplication ids are erased with the conversation, so Meta redelivering the
  // SAME message after an erase stores that one message again.
  await post(h, inboundPayload({ wamid: "wamid.ER6", text: SECRET_TEXT }));
  await h.flush();
  assert.ok((h.doc.rawOf(`conv/${cid()}`) ?? "").includes(SECRET_TEXT));
});

test("erase: the admin action is logged with ids only", async () => {
  const h = makeHarness();
  await post(h, inboundPayload({ wamid: "wamid.ER8", text: SECRET_TEXT, name: "Pat Private" }));
  await h.flush();
  await erase(h, cid());
  const line = JSON.stringify(h.logs);
  assert.ok(h.logs.some((l) => l.event === "admin" && l.fields?.action === "delete_conversation" && l.fields?.ok === true));
  for (const needle of [SECRET_TEXT, "Pat Private", WA]) assert.equal(line.includes(needle), false);
});
