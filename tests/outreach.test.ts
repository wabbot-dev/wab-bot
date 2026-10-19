// Bot-started conversations (start_conversation), opt-out (STOP/START), staff inbox reply and staff sign-in. Fake values only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminGet, adminPost, adminStartConversation, staffLogin, staffSession } from "../lib/admin";
import { convId } from "../lib/conv";
import { getControls, getHistory, sendReply, startConversation } from "../lib/tools";
import { optKeyword } from "../lib/webhook";
import { STAFF_COOKIE } from "../lib/staff";
import { activate, ADMIN_TOKEN, adminReq, cid, claimAndRead, getConv, inboundPayload, makeHarness, PN, post, T0, WA, WA2, WABA } from "./helpers";

const HOUR = 3600_000;
const tmpl = { WA_TEMPLATE_ALLOWLIST: "hello_world" };

async function inbound(h: ReturnType<typeof makeHarness>, wamid: string, text: string, from = WA) {
  const r = await post(h, inboundPayload({ wamid, text, from, tsMs: h.clock.now() }));
  assert.equal(r.status, 200);
}
/** a conversation that wrote in and was answered (state replied) */
async function replied(h: ReturnType<typeof makeHarness>, wa = WA) {
  await inbound(h, "wamid.in-" + wa + "-" + h.clock.now(), "hi", wa);
  const r = await adminPost(h.ctx, adminReq("POST", { action: "resolve", conversation_id: cid(wa) }));
  assert.equal(((await r.json()) as any).state, "replied");
}

test("start_conversation: idempotency key required, and conversation_id XOR to", async () => {
  const h = makeHarness(tmpl); await activate(h);
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x" })).error, "idempotency_key_required");
  assert.equal((await startConversation(h.ctx, { idempotency_key: "k", text: "x" })).error, "give_conversation_id_or_to");
  assert.equal(h.net.graph.length, 0);
});

test("start_conversation: every guard refuses with NO Meta call", async () => {
  const h = makeHarness({ ...tmpl, LAUNCH_MODE: "test", TEST_RECIPIENTS: WA, WA_WABA_ID: WABA, OUTREACH_ALLOWLIST: "15550000009" });
  await activate(h);
  // non-allowlisted template
  assert.equal((await startConversation(h.ctx, { to: WA2, template_name: "promo", idempotency_key: "k1" })).error, "template_not_allowlisted");
  // number that never wrote in
  assert.equal((await startConversation(h.ctx, { to: WA2, template_name: "hello_world", idempotency_key: "k2" })).error, "blocked_no_prior_inbound");
  // outreach-allowlisted but not a test recipient
  assert.equal((await startConversation(h.ctx, { to: "15550000009", template_name: "hello_world", idempotency_key: "k3" })).error, "blocked_test_mode_recipient_not_allowlisted");
  // active conversation -> send_reply
  await inbound(h, "wamid.a1", "hello");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "k4" })).error, "conversation_active_use_send_reply");
  // takeover
  await adminPost(h.ctx, adminReq("POST", { action: "takeover", conversation_id: cid() }));
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "k5" })).error, "blocked_human_takeover");
  // escalated
  await adminPost(h.ctx, adminReq("POST", { action: "resolve", conversation_id: cid() }));
  // opted out (customer STOP)
  await inbound(h, "wamid.a2", " stop ");
  await adminPost(h.ctx, adminReq("POST", { action: "resolve", conversation_id: cid() }));
  assert.equal((await getConv(h)).optOut?.via, "customer");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "k6" })).error, "blocked_opted_out");
  // auto-reply paused
  await inbound(h, "wamid.a3", "START");
  await adminPost(h.ctx, adminReq("POST", { action: "resolve", conversation_id: cid() }));
  assert.equal((await getConv(h)).optOut, undefined);
  await adminPost(h.ctx, adminReq("POST", { action: "set_auto_reply", value: "paused" }));
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "k7" })).error, "blocked_auto_reply_paused");
  assert.equal(h.net.graph.length, 0, "no guard may reach Meta");
});

test("start_conversation: inside the window text is sent once; replay with the same key never sends twice", async () => {
  const h = makeHarness(); await activate(h);
  await replied(h);
  const r1 = await startConversation(h.ctx, { conversation_id: cid(), text: "Your reminder", idempotency_key: "rem-1" });
  assert.equal(r1.ok, true); assert.equal(r1.status, "sent");
  const r2 = await startConversation(h.ctx, { conversation_id: cid(), text: "Your reminder", idempotency_key: "rem-1" });
  assert.equal(r2.idempotent_replay, true);
  assert.equal(h.net.graph.length, 1);
  assert.equal(h.net.graph[0]!.body.to, WA);
  const c = await getConv(h);
  assert.equal(Object.values(c.outs)[0]!.origin, "outreach");
  assert.equal(c.state, "replied", "a bot-started message does not change the conversation state");
});

test("start_conversation: outside the window only an allowlisted template; a failed key needs a new key", async () => {
  const h = makeHarness(tmpl); await activate(h);
  await replied(h);
  h.clock.advance(25 * HOUR);
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "late", idempotency_key: "a" })).error, "blocked_24h_window_closed_use_allowlisted_template");
  h.net.graphStatus = 400;
  const f = await startConversation(h.ctx, { conversation_id: cid(), template_name: "hello_world", idempotency_key: "b" });
  assert.equal(f.error, "send_rejected_http_400");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), template_name: "hello_world", idempotency_key: "b" })).error, "previous_attempt_failed_definitively_use_new_idempotency_key");
  h.net.graphStatus = 200;
  const ok = await startConversation(h.ctx, { conversation_id: cid(), template_name: "hello_world", idempotency_key: "c" });
  assert.equal(ok.status, "sent");
  assert.equal(h.net.graph.at(-1)!.body.type, "template");
});

test("start_conversation: an uncertain send holds the conversation for review", async () => {
  const h = makeHarness(); await activate(h);
  await replied(h);
  h.net.graphStatus = 503;
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "u" })).error, "send_uncertain_held_for_review");
  assert.equal((await getConv(h)).state, "held_for_review");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "u2" })).error, "blocked_held_for_review");
});

test("start_conversation: `to` on the owner's outreach allowlist creates the conversation (template only), needs WA_WABA_ID", async () => {
  const no = makeHarness({ ...tmpl, OUTREACH_ALLOWLIST: WA2 }); await activate(no);
  assert.equal((await startConversation(no.ctx, { to: WA2, template_name: "hello_world", idempotency_key: "x" })).error, "not_configured_waba_id_or_phone_number_id");
  const h = makeHarness({ ...tmpl, OUTREACH_ALLOWLIST: WA2, WA_WABA_ID: WABA }); await activate(h);
  assert.equal((await startConversation(h.ctx, { to: WA2, text: "hi", idempotency_key: "t" })).error, "blocked_24h_window_closed_use_allowlisted_template");
  const r = await startConversation(h.ctx, { to: "+" + WA2, template_name: "hello_world", idempotency_key: "t2" });
  assert.equal(r.status, "sent");
  assert.equal(r.conversation_id, convId(PN, WABA, WA2));
  assert.equal((await getConv(h, WA2)).state, "replied");
});

test("start_conversation: shares the hourly global rate slot with send_reply", async () => {
  const h = makeHarness({ RATE_GLOBAL_PER_HOUR: "1" }); await activate(h);
  await replied(h); await replied(h, WA2);
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "a", idempotency_key: "1" })).status, "sent");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(WA2), text: "b", idempotency_key: "2" })).error, "rate_limited_global");
});

test("admin route start-conversation uses the same guards (owner token only)", async () => {
  const h = makeHarness(tmpl); await activate(h);
  const req = (body: unknown, token = ADMIN_TOKEN) => new Request("https://x.test/api/admin/start-conversation", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await adminStartConversation(h.ctx, req({}, "wrong-wrong-wrong-wrong"))).status, 401);
  const r: any = await (await adminStartConversation(h.ctx, req({ to: WA2, template_name: "hello_world", idempotency_key: "z" }))).json();
  assert.equal(r.error, "not_configured_waba_id_or_phone_number_id");
});

test("opt-out keywords: whole message only, case-insensitive, text/button/interactive", () => {
  for (const t of ["STOP", "stop", " Stop! ", "unsubscribe", "ARRÊT", "arret", "إيقاف"]) assert.equal(optKeyword("text", t), "stop", t);
  assert.equal(optKeyword("button", "Stop"), "stop");
  assert.equal(optKeyword("text", "start"), "start");
  assert.equal(optKeyword("text", "please stop calling"), null);
  assert.equal(optKeyword("image", "STOP"), null);
});

test("opt-out: STOP is stored, still wakes the agent, send_reply to the customer stays allowed; flags shown everywhere", async () => {
  const h = makeHarness(); await activate(h);
  await inbound(h, "wamid.s1", "STOP");
  const c = await getConv(h);
  assert.equal(c.state, "pending"); assert.equal(c.messages[0]!.text, "STOP"); assert.ok(c.optOut);
  const lease = await claimAndRead(h);
  const hist: any = await getHistory(h.ctx, cid(), lease);
  assert.equal(hist.opted_out, true);
  assert.equal(((await getControls(h.ctx, cid())) as any).conversation.opted_out, true);
  assert.equal((await sendReply(h.ctx, { conversation_id: cid(), lease, text: "You are unsubscribed." })).status, "sent");
  const ov: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.equal(ov.conversations[0].opted_out, true);
  const one: any = await (await adminGet(h.ctx, adminReq("GET", undefined, ADMIN_TOKEN, `?conversation=${cid()}`))).json();
  assert.equal(one.opted_out, true); assert.equal(one.lease, undefined);
});

test("staff reply: sends, takes the conversation over, respects the window and test mode", async () => {
  const h = makeHarness({ LAUNCH_MODE: "test", TEST_RECIPIENTS: WA }); await activate(h);
  await inbound(h, "wamid.r1", "need a person");
  await inbound(h, "wamid.r2", "hello", WA2);
  const r: any = await (await adminPost(h.ctx, adminReq("POST", { action: "reply", conversation_id: cid(), text: "Hi, this is Sam", idempotency_key: "s1" }))).json();
  assert.equal(r.status, "sent"); assert.equal(r.state, "human_takeover");
  const c = await getConv(h);
  assert.equal(c.state, "human_takeover"); assert.equal(c.unhandled, 0);
  assert.equal(Object.values(c.outs)[0]!.origin, "staff");
  const t: any = await (await adminPost(h.ctx, adminReq("POST", { action: "reply", conversation_id: cid(WA2), text: "x" }))).json();
  assert.equal(t.error, "blocked_test_mode_recipient_not_allowlisted");
  h.clock.advance(25 * HOUR);
  const w: any = await (await adminPost(h.ctx, adminReq("POST", { action: "reply", conversation_id: cid(), text: "late" }))).json();
  assert.equal(w.error, "blocked_24h_window_closed_use_allowlisted_template");
  assert.equal(h.net.graph.length, 1);
});

test("staff opt_out / opt_in actions", async () => {
  const h = makeHarness(); await activate(h);
  await replied(h);
  await adminPost(h.ctx, adminReq("POST", { action: "opt_out", conversation_id: cid() }));
  assert.equal((await getConv(h)).optOut?.via, "staff");
  assert.equal((await startConversation(h.ctx, { conversation_id: cid(), text: "x", idempotency_key: "o" })).error, "blocked_opted_out");
  await adminPost(h.ctx, adminReq("POST", { action: "opt_in", conversation_id: cid() }));
  assert.equal((await getConv(h)).optOut, undefined);
});

test("staff sign-in: one-time invite -> HttpOnly session cookie; never the admin token; CSRF header for changes", async () => {
  const h = makeHarness(); await activate(h);
  await inbound(h, "wamid.c1", "hi");
  const inv: any = await (await adminPost(h.ctx, adminReq("POST", { action: "staff_invite" }))).json();
  assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!JSON.stringify(inv).includes(ADMIN_TOKEN));
  const login = (code: string) => staffLogin(h.ctx, new Request("https://x.test/api/staff/login", { method: "POST", body: JSON.stringify({ code }) }));
  assert.equal((await login("AAAA-BBBB-CCCC")).status, 401);
  const ok = await login(inv.code.toLowerCase());
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie")!;
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
  assert.ok(!sc.includes(ADMIN_TOKEN));
  assert.equal((await login(inv.code)).status, 401, "single use");
  const cookie = sc.split(";")[0]!;
  assert.ok(cookie.startsWith(STAFF_COOKIE + "="));
  const get = await adminGet(h.ctx, new Request("https://x.test/api/admin", { headers: { cookie } }));
  assert.equal(get.status, 200);
  assert.equal(staffSession(h.ctx, new Request("https://x.test/api/staff/session", { headers: { cookie } })).status, 200);
  const postNoHdr = await adminPost(h.ctx, new Request("https://x.test/api/admin", { method: "POST", headers: { cookie }, body: JSON.stringify({ action: "takeover", conversation_id: cid() }) }));
  assert.equal(postNoHdr.status, 401, "cookie-only POST without X-Staff-Request is refused");
  const postHdr = await adminPost(h.ctx, new Request("https://x.test/api/admin", { method: "POST", headers: { cookie, "X-Staff-Request": "1" }, body: JSON.stringify({ action: "takeover", conversation_id: cid() }) }));
  assert.equal(postHdr.status, 200);
  const mint = await adminPost(h.ctx, new Request("https://x.test/api/admin", { method: "POST", headers: { cookie, "X-Staff-Request": "1" }, body: JSON.stringify({ action: "staff_invite" }) }));
  assert.equal(mint.status, 401, "a staff session cannot mint invites");
  // expired session
  h.clock.advance(13 * HOUR);
  assert.equal((await adminGet(h.ctx, new Request("https://x.test/api/admin", { headers: { cookie } }))).status, 401);
  // expired invite
  const inv2: any = await (await adminPost(h.ctx, adminReq("POST", { action: "staff_invite", ttl_minutes: 5 }))).json();
  h.clock.advance(6 * 60_000);
  assert.equal((await login(inv2.code)).status, 401);
  void T0;
});
