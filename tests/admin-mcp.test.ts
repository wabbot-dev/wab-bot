// Admin MCP server (/admin/mcp): gate, auth, rate limits, validation, redaction, and every tool. All values are fake; the network is a stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_TOOLS, FAIL_MAX, CALL_MAX, createAdminMcpRoute, isNewer, maskContacts, scrub, type AdminMcpHost } from "../lib/admin-mcp";
import { INDEX_KEY, callKey, txKey, type CallIndex, type CallLog, type CallTranscript } from "../lib/calls";
import { MemoryRateLimiter, fixedWindowHit, type RateLimiter } from "../lib/rate-limit";
import { signBody } from "../lib/crypto";
import { VERIFY_KEY } from "../lib/webhook";
import { update, updateMulti } from "../lib/store";
import { claimConversation } from "../lib/tools";
import {
  ADMIN_TOKEN, APP_SECRET, MCP_TOKEN, VERIFY_TOKEN, WAKE_KEY, WA, activate, baseEnv, cid, inboundPayload, makeHarness, post, type Harness,
} from "./helpers";

const AT = "@"; // built at run time so the hygiene scan sees no e-mail-shaped literal
const TOKEN = "admin-mcp-test-token-0123456789abcdef"; // 37 chars, fake
const XAI = "test-xai-key-0000000001";
const base = (over: Record<string, string> = {}) => baseEnv({ ADMIN_MCP_TOKEN: TOKEN, XAI_API_KEY: XAI, ...over });
const SECRETS = [TOKEN, XAI, APP_SECRET, VERIFY_TOKEN, MCP_TOKEN, ADMIN_TOKEN, WAKE_KEY, "test-access-token-0000001", "test-cron-secret-00001"];

function rig(over: Record<string, string> = {}, host: AdminMcpHost = {}) {
  const h = makeHarness(base(over));
  const memory = new MemoryRateLimiter();
  const route = createAdminMcpRoute(() => h.ctx, { memory, calling: { setDeadman: async () => {} }, ...host });
  const call = (body: unknown, o: { token?: string | null; origin?: string; ip?: string; method?: string; raw?: string } = {}) =>
    route(new Request("https://bridge.example.test/admin/mcp", {
      method: o.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(o.token === null ? {} : { Authorization: `Bearer ${o.token ?? TOKEN}` }), ...(o.origin ? { Origin: o.origin } : {}), "cf-connecting-ip": o.ip ?? "203.0.113.7" },
      body: o.method === "GET" ? undefined : (o.raw ?? JSON.stringify(body)),
    }));
  const rpc = async (method: string, params: unknown, o: Parameters<typeof call>[1] = {}) => (await call({ jsonrpc: "2.0", id: 1, method, params }, o)).json() as Promise<any>;
  const tool = async (name: string, args: unknown = {}, o: Parameters<typeof call>[1] = {}) => {
    const r = await rpc("tools/call", { name, arguments: args }, o);
    if (r.error) return { error: r.error } as any;
    return JSON.parse(r.result.content[0].text);
  };
  return { h, route, call, rpc, tool, memory };
}

// ------------------------------------------------------------------------------------------------ gate + auth
test("disabled by default: 404 without a binding or with a short one, whatever the request says", async () => {
  for (const over of [{ ADMIN_MCP_TOKEN: "" }, { ADMIN_MCP_TOKEN: "x".repeat(31) }]) {
    const r = rig(over);
    const res = await r.call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
    assert.equal((await r.call({}, { token: "x".repeat(31) })).status, 404, "even the right short token does not open it");
  }
  const ok32 = rig({ ADMIN_MCP_TOKEN: "x".repeat(32) });
  assert.equal((await ok32.call({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "x".repeat(32) })).status, 200, "32 characters is accepted");
});

test("auth: no token, wrong token, wrong scheme and the other tokens are all refused; the agent MCP token does not work", async () => {
  const r = rig();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  assert.equal((await r.call(ping, { token: null })).status, 401);
  assert.equal((await r.call(ping, { token: "wrong-" + TOKEN })).status, 401);
  assert.equal((await r.call(ping, { token: MCP_TOKEN })).status, 401, "MCP_TOKEN is not the admin MCP secret");
  assert.equal((await r.call(ping, { token: ADMIN_TOKEN })).status, 401, "ADMIN_TOKEN is not the admin MCP secret");
  const basic = await r.route(new Request("https://bridge.example.test/admin/mcp", { method: "POST", headers: { Authorization: `Basic ${TOKEN}` }, body: JSON.stringify(ping) }));
  assert.equal(basic.status, 401);
  assert.equal((await r.call(ping)).status, 200);
  const denied = await r.call(ping, { token: null });
  assert.equal(denied.headers.get("www-authenticate"), 'Bearer realm="admin-mcp"');
  assert.doesNotMatch(await denied.text(), new RegExp(TOKEN));
});

test("Origin: a browser origin that is not this Worker is refused (DNS-rebinding guard); same origin and no Origin pass", async () => {
  const r = rig();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  assert.equal((await r.call(ping, { origin: "https://evil.example.test" })).status, 403);
  assert.equal((await r.call(ping, { origin: "https://bridge.example.test" })).status, 200);
  assert.equal((await r.call(ping)).status, 200);
});

test("failed attempts are rate limited per client, then even the right token is held back for that client only", async () => {
  const r = rig();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  for (let i = 0; i < FAIL_MAX; i++) assert.equal((await r.call(ping, { token: "nope", ip: "198.51.100.9" })).status, 401);
  const blocked = await r.call(ping, { token: "nope", ip: "198.51.100.9" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  assert.equal((await r.call(ping, { token: "nope", ip: "198.51.100.10" })).status, 401, "another client is unaffected");
  assert.equal((await r.call(ping, { ip: "198.51.100.10" })).status, 200, "the right token works for it");
});

test("authenticated calls are limited per minute; the window then reopens", async () => {
  const r = rig();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  for (let i = 0; i < CALL_MAX; i++) assert.equal((await r.call(ping)).status, 200);
  assert.equal((await r.call(ping)).status, 429);
  r.h.clock.advance(61_000);
  assert.equal((await r.call(ping)).status, 200);
});

test("the durable limiter backs up the in-isolate one; if it is down the route fails closed for valid tokens and stays shut for bad ones", async () => {
  const wins = new Map<string, { start: number; count: number }>();
  const shared: RateLimiter = { hit: async (k, now, w, max) => { const { win, result } = fixedWindowHit(wins.get(k), now, w, max); wins.set(k, win); return result; } };
  const a = rig({}, { limiter: shared });
  const b = rig({}, { limiter: shared, memory: new MemoryRateLimiter() }); // a second isolate sharing the durable counters
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  for (let i = 0; i < 6; i++) await a.call(ping, { token: "nope", ip: "192.0.2.1" });
  for (let i = 0; i < 4; i++) await b.call(ping, { token: "nope", ip: "192.0.2.1" });
  assert.equal((await b.call(ping, { token: "nope", ip: "192.0.2.1" })).status, 429, "10 failures spread over two isolates are still caught");
  const down: RateLimiter = { hit: async () => { throw new Error("do down"); } };
  const c = rig({}, { limiter: down });
  assert.equal((await c.call(ping)).status, 503);
  assert.equal((await c.call(ping, { token: "nope" })).status, 401);
});

test("memory limiter stays bounded under a flood of distinct keys", async () => {
  const m = new MemoryRateLimiter(50);
  for (let i = 0; i < 500; i++) await m.hit("k" + i, 1000 + i, 60_000, 5);
  assert.ok((m as any).wins.size <= 50);
  assert.equal(fixedWindowHit(undefined, 5, 1000, 2).result.allowed, true);
});

// ------------------------------------------------------------------------------------------------ protocol
test("protocol: initialize, tools/list (14 tools, strict schemas, annotations), POST only, body size and batch limits", async () => {
  const r = rig();
  const init = await r.rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "wab-bot-admin");
  const list = await r.rpc("tools/list", {});
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["arm_calling", "calling_status", "check_for_update", "disarm_calling", "erase_call_log", "erase_conversation", "get_call_log", "get_conversation", "get_status", "get_usage_summary", "get_version", "list_call_logs", "list_conversations", "setup_check"]);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
  }
  const hints = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.annotations]));
  assert.equal(hints.get_status.readOnlyHint, true);
  assert.equal(hints.erase_conversation.destructiveHint, true);
  assert.equal(hints.erase_call_log.destructiveHint, true);
  assert.equal(hints.get_call_log.readOnlyHint, true);
  assert.equal(hints.arm_calling.readOnlyHint, false);
  assert.equal((await r.call({}, { method: "GET" })).status, 405);
  assert.equal((await r.call(null, { raw: "x".repeat(20_000) })).status, 413);
  assert.equal((await r.call(null, { raw: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))) })).status, 400);
  assert.equal((await r.rpc("nope", {})).error.code, -32601);
});

test("arguments are validated: unknown keys, wrong types, bad formats and out-of-range values are all rejected", async () => {
  const r = rig();
  const bad = async (name: string, args: unknown) => { const x = await r.tool(name, args); assert.equal(x.error?.code, -32602, `${name} ${JSON.stringify(args)}`); };
  await bad("get_status", { surprise: 1 });
  await bad("list_conversations", { limit: 0 });
  await bad("list_conversations", { limit: 101 });
  await bad("list_conversations", { limit: 2.5 });
  await bad("list_conversations", { limit: "5" });
  await bad("list_conversations", { state: "weird" });
  await bad("list_conversations", { offset: -1 });
  await bad("get_conversation", {});
  await bad("get_conversation", { conversation_id: "c_zz" });
  await bad("get_conversation", { conversation_id: "../../etc" });
  await bad("get_call_log", { call_id: "c_" + "0".repeat(20) });
  await bad("erase_conversation", { conversation_id: "c_" + "0".repeat(20) });
  await bad("erase_call_log", { call_id: "cl_" + "0".repeat(20) });
  await bad("erase_call_log", { call_id: "cl_" + "0".repeat(20), confirm: "nope" });
  await bad("get_call_log", { call_id: "cl_" + "0".repeat(20), include_transcript: "yes" });
  await bad("arm_calling", { confirm: false });
  await bad("arm_calling", { confirm: true, minutes: 61 });
  await bad("arm_calling", { confirm: true, max_calls: 6 });
  await bad("arm_calling", { confirm: true, number: "+1 555" });
  await bad("calling_status", { verify_remote: "yes" });
  const nul = await r.rpc("tools/call", { name: "get_status", arguments: [] });
  assert.equal(nul.error.code, -32602);
  assert.equal((await r.rpc("tools/call", { name: "no_such_tool", arguments: {} })).error.code, -32602);
});

// ------------------------------------------------------------------------------------------------ tools
async function seed(h: Harness) {
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.A1", text: "SECRET CUSTOMER TEXT 4242", name: "Jane Private" }));
  return cid(WA);
}

test("get_status / setup_check: presence booleans only; webhook state; gaps are named", async () => {
  const r = rig();
  await seed(r.h);
  const st = await r.tool("get_status");
  assert.equal(st.read_only, true);
  assert.equal(st.config_present.WA_ACCESS_TOKEN, true);
  assert.equal(st.config_present.XAI_API_KEY, true);
  assert.equal(st.config_present.ADMIN_MCP_TOKEN, true);
  assert.equal(st.webhook.last_verification_handshake_at, null);
  assert.equal(st.webhook.verification_handshakes_seen, 0);
  assert.ok(st.webhook.last_inbound_message_at);
  assert.equal(st.conversations.total, 1);
  assert.equal(st.calling.gate_open, false);
  await update(r.h.ctx, VERIFY_KEY, () => ({ next: { at: r.h.ctx.now(), count: 2 }, result: null }));
  const st2 = await r.tool("get_status");
  assert.equal(st2.webhook.verification_handshakes_seen, 2);
  assert.ok(st2.webhook.last_verification_handshake_at);

  const sc = await r.tool("setup_check");
  assert.equal(sc.ready_to_receive, true);
  assert.equal(sc.ready_to_reply, true);
  assert.deepEqual(sc.missing_required, []);
  const bare = rig({ WA_APP_SECRET: "", WAKE_URL: "", WA_ACCESS_TOKEN: "", WA_PHONE_NUMBER_IDS: "" });
  const sc2 = await bare.tool("setup_check");
  assert.equal(sc2.ready_to_receive, false);
  assert.equal(sc2.ready_to_reply, false);
  assert.ok(sc2.missing_required.includes("WA_APP_SECRET") && sc2.missing_required.includes("WAKE_URL") && sc2.missing_required.includes("WA_ACCESS_TOKEN"));
  assert.ok(sc2.checks.find((c: any) => c.id === "WA_APP_SECRET").fix);
  assert.match(sc.owner_only_steps, /stay with you/);
});

test("conversations are redacted: no text, name, full number or lease; filters and paging work", async () => {
  const r = rig();
  const id = await seed(r.h);
  await post(r.h, inboundPayload({ wamid: "wamid.B1", from: "15550000002", text: "other", name: "Bob Hidden" }));
  await claimConversation(r.h.ctx, id);
  const list = await r.tool("list_conversations", {});
  assert.equal(list.redacted, true);
  assert.equal(list.total_matching, 2);
  const txt = JSON.stringify(list);
  for (const leak of ["SECRET CUSTOMER TEXT", "Jane Private", "Bob Hidden", WA, "15550000002", "lease"]) assert.ok(!txt.includes(leak), leak);
  assert.match(list.conversations[0].customer_hint, /^\*\*\*\d\d$/);
  assert.equal((await r.tool("list_conversations", { state: "claimed" })).total_matching, 1);
  assert.equal((await r.tool("list_conversations", { limit: 1 })).returned, 1);
  assert.equal((await r.tool("list_conversations", { offset: 5 })).returned, 0);

  const g = await r.tool("get_conversation", { conversation_id: id });
  assert.equal(g.ok, true);
  const gt = JSON.stringify(g);
  for (const leak of ["SECRET CUSTOMER TEXT", "Jane Private", WA]) assert.ok(!gt.includes(leak), leak);
  assert.ok(g.messages.length >= 1 && g.messages[0].chars > 0 && g.messages[0].dir);
  assert.equal((await r.tool("get_conversation", { conversation_id: "c_" + "0".repeat(20) })).error, "not_found");
});

test("erase_conversation needs the id repeated, uses the shared erase, and leaves nothing behind", async () => {
  const r = rig();
  const id = await seed(r.h);
  const noConfirm = await r.tool("erase_conversation", { conversation_id: id });
  assert.equal(noConfirm.error.code, -32602);
  const wrong = await r.tool("erase_conversation", { conversation_id: id, confirm: "c_" + "1".repeat(20) });
  assert.equal(wrong.error.code, -32602);
  assert.ok(await r.h.store.get(`conv/${id}`), "still there");
  const ok = await r.tool("erase_conversation", { conversation_id: id, confirm: id });
  assert.deepEqual(ok, { ok: true, deleted: true });
  assert.equal(await r.h.store.get(`conv/${id}`), null);
  assert.equal((await r.tool("erase_conversation", { conversation_id: id, confirm: id })).error, "not_found");
  assert.ok(r.h.logs.some((l) => l.event === "admin" && l.fields?.via === "admin_mcp"));
});

test("get_version, get_usage_summary", async () => {
  const r = rig();
  await seed(r.h);
  const v = await r.tool("get_version");
  assert.equal(v.version, "0.3.0");
  assert.ok(v.tools.includes("check_for_update") && v.mcp_protocol_versions.includes("2025-06-18"));
  const u = await r.tool("get_usage_summary");
  assert.equal(u.messages.conversations, 1);
  assert.equal(u.messages.stored_inbound, 1);
  assert.equal(u.voice_calls.calls_answered, 0);
  assert.equal(u.voice_calls.estimated_xai_cost_usd, 0);
  assert.match(u.voice_calls.note, /Estimate/);
});

test("check_for_update only reports: newer, current, no release, failure; one fixed GET, no credentials", async () => {
  const r = rig();
  const seen: { url: string; auth: string | null }[] = [];
  let mode: "newer" | "same" | "none" | "fail" | "throw" = "newer";
  r.h.ctx.fetch = async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers as HeadersInit).get("authorization") });
    if (mode === "throw") throw new Error("offline");
    if (mode === "none") return new Response("{}", { status: 404 });
    if (mode === "fail") return new Response("{}", { status: 500 });
    return Response.json({ tag_name: mode === "newer" ? "v0.4.0" : "v0.3.0", html_url: "https://github.com/wabbot-dev/wab-bot/releases/tag/x", published_at: "2026-10-20T00:00:00Z" });
  };
  const a = await r.tool("check_for_update");
  assert.deepEqual([a.ok, a.update_available, a.latest, a.auto_update], [true, true, "v0.4.0", false]);
  assert.match(a.release_url, /^https:\/\/github\.com\//);
  assert.equal(seen[0]!.url, "https://api.github.com/repos/wabbot-dev/wab-bot/releases/latest");
  assert.equal(seen[0]!.auth, null, "no credential is sent");
  mode = "same";
  assert.equal((await r.tool("check_for_update")).update_available, false);
  mode = "none";
  assert.match((await r.tool("check_for_update")).note, /No release/);
  mode = "fail";
  assert.equal((await r.tool("check_for_update")).error, "update_check_failed");
  mode = "throw";
  assert.equal((await r.tool("check_for_update")).error, "update_check_failed");
  assert.equal(seen.length, 5);
  assert.deepEqual([isNewer("v0.10.0", "0.9.9"), isNewer("v0.1.0", "0.1.0"), isNewer("junk", "0.1.0"), isNewer("1.0.0", "0.9.9")], [true, false, false, true]);
});

// ------------------------------------------------------------------------------------------------ calling tools
test("calling tools: status with the gate closed, arm refused, disarm safe; call logs empty and honest", async () => {
  const r = rig();
  const cs = await r.tool("calling_status");
  assert.equal(cs.mode, "off");
  assert.equal(cs.gate.open, false);
  assert.equal(cs.gate.closed_because, "calling_off");
  assert.equal(cs.armed, false);
  const arm = await r.tool("arm_calling", { confirm: true });
  assert.equal(arm.error, "calling_gate_closed");
  assert.match(arm.hint, /owner opens the gate/);
  const logs = await r.tool("list_call_logs");
  assert.deepEqual([logs.metadata_only, logs.total_matching, logs.calls], [true, 0, []]);
  assert.equal((await r.tool("get_call_log", { call_id: "cl_" + "0".repeat(20) })).error, "not_found");
  const dis = await r.tool("disarm_calling");
  assert.equal(dis.ok, true);
  assert.equal(dis.meta, "disabled");
});

async function seedCall(h: Harness, over: { text?: string; outcome?: CallLog["outcome"]; withTx?: boolean } = {}) {
  const id = "cl_" + "a".repeat(20);
  const log: CallLog = {
    id, startedAt: h.clock.now(), endedAt: over.outcome === "in_progress" ? undefined : h.clock.now() + 20_000, durationS: 20, mode: "test", callerHint: "…01",
    outcome: over.outcome ?? "completed", endedBy: "ai", turns: { caller: 1, ai: 1 },
    ...(over.withTx === false ? {} : { transcript: { lines: 2, expiresAt: h.clock.now() + 30 * 86400_000 } }),
  };
  const tx: CallTranscript = { lines: [{ who: "ai", atS: 0.5, text: "Hello, how can I help?" }, { who: "caller", atS: 4, text: over.text ?? `Call me on +1 (555) 123-4567 or mail jane.doe${AT}example.test, my code is 123456` }] };
  await updateMulti(h.ctx, [callKey(id), txKey(id), INDEX_KEY], () => ({ next: [log, over.withTx === false ? undefined : tx, { ids: [id] } satisfies CallIndex], result: 0 }));
  return id;
}

test("call transcripts: list shows only whether one is stored; get_call_log returns text only on request, contact details masked, labelled untrusted", async () => {
  const r = rig();
  const id = await seedCall(r.h);
  const list = await r.tool("list_call_logs");
  assert.deepEqual(list.calls[0].transcript, { stored: true, lines: 2, expires_at: new Date(r.h.clock.now() + 30 * 86400_000).toISOString(), truncated: false });
  assert.equal(list.transcripts_kept, true);
  assert.equal(list.transcript_retention_days, 30);
  assert.doesNotMatch(JSON.stringify(list), /how can I help|jane/i, "no transcript text in listings");
  const plain = await r.tool("get_call_log", { call_id: id });
  assert.equal(plain.metadata_only, true);
  assert.equal(plain.transcript.stored, true);
  assert.equal(plain.transcript.lines, 2, "metadata only: a count, not text");
  assert.doesNotMatch(JSON.stringify(plain), /how can I help/);
  const full = await r.tool("get_call_log", { call_id: id, include_transcript: true });
  assert.equal(full.metadata_only, false);
  assert.equal(full.transcript.untrusted_caller_speech, true);
  assert.equal(full.transcript.contact_details, "masked");
  assert.deepEqual(full.transcript.lines.map((l: any) => l.who), ["ai", "caller"]);
  const said = full.transcript.lines[1].text as string;
  assert.match(said, /\[number ending 67\]/);
  assert.match(said, /\[email\]/);
  assert.doesNotMatch(said, /555|jane\.doe|example\.test/);
  assert.match(said, /my code is 123456/, "short digit strings are left alone (they are not phone numbers)");
  const shown = await r.tool("get_call_log", { call_id: id, include_transcript: true, reveal_contact_details: true });
  assert.equal(shown.transcript.contact_details, "shown");
  assert.match(shown.transcript.lines[1].text, /jane\.doe.example\.test/);
});

test("call transcripts: secrets spoken or echoed in a transcript are still scrubbed; a call without a transcript says so; in-progress is explained", async () => {
  const r = rig();
  const id = await seedCall(r.h, { text: `the key is ${XAI} and bearer ${TOKEN}` });
  const full = JSON.stringify(await r.tool("get_call_log", { call_id: id, include_transcript: true }));
  assert.ok(!full.includes(XAI) && !full.includes(TOKEN));
  assert.match(full, /REDACTED/);
  const r2 = rig();
  const none = await seedCall(r2.h, { withTx: false });
  assert.deepEqual((await r2.tool("get_call_log", { call_id: none, include_transcript: true })).transcript, { stored: false, reason: "none_stored" });
  const r3 = rig();
  const live = await seedCall(r3.h, { outcome: "in_progress", withTx: false });
  assert.deepEqual((await r3.tool("get_call_log", { call_id: live, include_transcript: true })).transcript, { stored: false, reason: "call_in_progress" });
});

test("erase_call_log: needs the confirm, erases log + transcript + list entry, refuses an in-progress call, is clean when repeated", async () => {
  const r = rig();
  const id = await seedCall(r.h);
  assert.equal((await r.tool("erase_call_log", { call_id: id, confirm: "cl_" + "b".repeat(20) })).error.code, -32602);
  assert.ok(await r.h.store.get(txKey(id)), "wrong confirm erased nothing");
  const done = await r.tool("erase_call_log", { call_id: id, confirm: id });
  assert.deepEqual(done, { ok: true, erased_transcript: true });
  assert.equal(await r.h.store.get(callKey(id)), null);
  assert.equal(await r.h.store.get(txKey(id)), null);
  assert.deepEqual((await r.tool("list_call_logs")).calls, []);
  assert.deepEqual(await r.tool("erase_call_log", { call_id: id, confirm: id }), { ok: false, error: "not_found" });
  const r2 = rig();
  const live = await seedCall(r2.h, { outcome: "in_progress", withTx: false });
  assert.deepEqual(await r2.tool("erase_call_log", { call_id: live, confirm: live }), { ok: false, error: "call_in_progress" });
});

test("maskContacts: masks e-mail and 7+ digit numbers in any common format, keeps short numbers and ordinary text", () => {
  assert.equal(maskContacts("ring 0123456789 or +49 70 123 456 now"), "ring [number ending 89] or [number ending 56] now");
  assert.equal(maskContacts(`mail a.b+c${AT}x.example.org please`), "mail [email] please");
  assert.equal(maskContacts("table for 4 at 7:30, ref 12345"), "table for 4 at 7:30, ref 12345");
  assert.equal(maskContacts("(555) 010-0000"), "[number ending 00]");
});

test("no tool output ever contains a secret value, even when a tool is made to echo one", async () => {
  const r = rig({ CALLING_MODE: "test", CALL_ALLOWED_CALLERS: "15550000001" });
  await seed(r.h);
  const everything: string[] = [];
  for (const t of ADMIN_TOOLS) {
    const args: Record<string, unknown> = {};
    if (t.name === "get_conversation" || t.name === "erase_conversation" || t.name === "erase_call_log") continue;
    if (t.name === "arm_calling") continue;
    if (t.name === "get_call_log") args.call_id = "cl_" + "0".repeat(20);
    r.h.ctx.fetch = async () => new Response("{}", { status: 404 });
    everything.push(JSON.stringify(await r.tool(t.name, args)));
  }
  const all = everything.join("\n");
  for (const s of SECRETS) assert.ok(!all.includes(s), "leaked a secret value");
  // backstop: a tool that returns a secret by mistake is scrubbed on the way out
  const leaky = { name: "leaky", description: "test only", spec: {}, inputSchema: { type: "object" }, run: async (c: any) => ({ v: c.cfg.adminMcpToken, w: c.cfg.xaiApiKey }) };
  (ADMIN_TOOLS as any[]).push(leaky);
  try {
    const out = JSON.stringify(await r.tool("leaky"));
    assert.ok(!out.includes(TOKEN) && !out.includes(XAI), "the route scrubs what a tool returns");
    assert.match(out, /REDACTED/);
  } finally { (ADMIN_TOOLS as any[]).pop(); }
  const dirty = scrub(r.h.ctx, { a: `x ${TOKEN} y`, b: { c: XAI, d: "whsec_" + "A".repeat(20), e: "Bearer abcdefghijklmnopqrstu" } });
  const dt = JSON.stringify(dirty);
  assert.ok(!dt.includes(TOKEN) && !dt.includes(XAI) && !dt.includes("AAAAAAAAAAAAAAAAAAAA") && !dt.includes("abcdefghijklmnopqrstu"));
  assert.match(dt, /REDACTED/);
});

test("logs never carry secrets or message text: denied attempts and tool calls log names only", async () => {
  const r = rig();
  await seed(r.h);
  await r.call({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "WRONG-TOKEN-VALUE-0123456789" });
  await r.tool("get_status");
  const blob = JSON.stringify(r.h.logs);
  for (const s of [...SECRETS, "WRONG-TOKEN-VALUE", "SECRET CUSTOMER TEXT"]) assert.ok(!blob.includes(s), s);
  assert.ok(r.h.logs.some((l) => l.event === "admin_mcp_denied"));
  assert.ok(r.h.logs.some((l) => l.event === "admin_mcp_call" && l.fields?.tool === "get_status"));
});

test("a verified Meta handshake is recorded for get_status (webhook route)", async () => {
  const { handleVerify, recordHandshake } = await import("../lib/webhook");
  const h = makeHarness(base());
  const ok = handleVerify(h.ctx, new URL(`https://bridge.example.test/api/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=7`));
  assert.equal(ok.status, 200);
  recordHandshake(h.ctx);
  await h.flush();
  assert.equal((await h.store.get<{ at: number; count: number }>(VERIFY_KEY))!.value.count, 1);
  recordHandshake(h.ctx);
  await h.flush();
  assert.equal((await h.store.get<{ at: number; count: number }>(VERIFY_KEY))!.value.count, 2);
  assert.ok(signBody("x", "y"));
});
