// Additional tests: auth, admin API, cron, MCP over HTTP,
// log hygiene. Store contract and op-budget tests live in tests/row-store.test.ts and tests/ops.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminGet, adminPost } from "../lib/admin";
import { handleCron } from "../lib/cron";
import { loadConfig } from "../lib/config";
import { bearerOf, signBody, tokenOk, verifySignature } from "../lib/crypto";
import { createMcpRoute } from "../lib/mcp";
import { claimConversation, finishConversation, sendReply } from "../lib/tools";
import { handleVerify } from "../lib/webhook";
import {
  ADMIN_TOKEN, CRON_SECRET, MCP_TOKEN, VERIFY_TOKEN, WA, activate, adminReq, cid, claimAndRead, getConv,
  inboundPayload, makeHarness, post, APP_SECRET,
} from "./helpers";

test("GET verify handshake: echo challenge, else 403", () => {
  const h = makeHarness();
  const u = (t: string, mode = "subscribe") =>
    new URL(`https://x.test/api/webhook?hub.mode=${mode}&hub.verify_token=${t}&hub.challenge=12345`);
  const ok = handleVerify(h.ctx, u(VERIFY_TOKEN));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/plain");
  assert.equal(handleVerify(h.ctx, u("wrong-wrong-wrong-wrong")).status, 403);
  assert.equal(handleVerify(h.ctx, u(VERIFY_TOKEN, "unsubscribe")).status, 403);
  const short = makeHarness({ WA_VERIFY_TOKEN: "short" });
  assert.equal(handleVerify(short.ctx, u("short")).status, 403, "tokens < 16 chars are refused");
  const none = makeHarness({ WA_VERIFY_TOKEN: "" });
  assert.equal(handleVerify(none.ctx, u("")).status, 403);
});

test("tokens: >= 16 chars, constant-time compare, fail closed", () => {
  assert.equal(tokenOk("a".repeat(16), "a".repeat(16)), true);
  assert.equal(tokenOk("a".repeat(15), "a".repeat(15)), false);
  assert.equal(tokenOk("a".repeat(16), "a".repeat(17)), false);
  assert.equal(tokenOk(null, "a".repeat(16)), false);
  assert.equal(tokenOk("x", undefined), false);
  assert.equal(bearerOf(new Request("https://x.test", { headers: { Authorization: "Bearer abc" } })), "abc");
  assert.equal(bearerOf(new Request("https://x.test", { headers: { Authorization: "Basic abc" } })), null);
  const sig = signBody("{}", APP_SECRET);
  assert.equal(verifySignature("{}", sig, APP_SECRET), true);
  assert.equal(verifySignature("{ }", sig, APP_SECRET), false);
  assert.equal(verifySignature("{}", "sha256=zz", APP_SECRET), false);
});

test("defaults are fail-safe: LAUNCH_MODE test, auto-reply paused, safe limits", async () => {
  const cfg = loadConfig({});
  assert.equal(cfg.launchMode, "test");
  assert.equal(loadConfig({ LAUNCH_MODE: "LIVE " }).launchMode, "live");
  assert.equal(loadConfig({ LAUNCH_MODE: "production" }).launchMode, "test");
  assert.equal(cfg.wakeDebounceMs, 8000);
  assert.equal(loadConfig({ WAKE_DEBOUNCE_MS: "999999" }).wakeDebounceMs, 25000);
  assert.equal(loadConfig({ WAKE_DEBOUNCE_MS: "-5" }).wakeDebounceMs, 0);
  assert.deepEqual([cfg.leaseMs, cfg.rateConvMax, cfg.rateConvWindowMs, cfg.rateGlobalPerHour, cfg.sendTimeoutMs], [300000, 5, 600000, 60, 15000]);
  assert.deepEqual(cfg.templateAllowlist, []);
  const h = makeHarness({ LAUNCH_MODE: undefined });
  const ov: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.deepEqual(ov.controls, { auto_reply: "paused", launch_mode: "test" });
});

test("admin API: auth, overview, actions and their error strings", async () => {
  const h = makeHarness();
  assert.equal((await adminGet(h.ctx, new Request("https://x.test/api/admin"))).status, 401);
  assert.equal((await adminGet(h.ctx, adminReq("GET", undefined, "wrong-token-wrong-token"))).status, 401);
  assert.equal((await adminPost(h.ctx, adminReq("POST", { action: "set_auto_reply", value: "active" }, "short"))).status, 401);
  const noAdmin = makeHarness({ ADMIN_TOKEN: "short" });
  assert.equal((await adminGet(noAdmin.ctx, adminReq("GET", undefined, "short"))).status, 401, "short ADMIN_TOKEN refuses everything");

  await post(h, inboundPayload({ wamid: "wamid.AD1", name: "Pat" }));
  await h.flush();
  const id = cid();
  const post_ = async (b: unknown) => adminPost(h.ctx, adminReq("POST", b));
  assert.equal((await post_({ action: "nope", conversation_id: id })).status, 400);
  assert.equal((await post_({ action: "takeover" })).status, 400);
  assert.equal((await post_({ action: "set_auto_reply", value: "maybe" })).status, 400);
  assert.equal((await adminPost(h.ctx, new Request("https://x.test/api/admin", { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, body: "{" }))).status, 400);
  assert.equal((await post_({ action: "takeover", conversation_id: "c_" + "0".repeat(20) })).status, 404);
  assert.deepEqual(await (await post_({ action: "release", conversation_id: id })).json(), { ok: false, error: "not_in_takeover" });
  assert.deepEqual(await (await post_({ action: "release_hold", conversation_id: id })).json(), { ok: false, error: "not_held" });
  assert.deepEqual(await (await post_({ action: "reopen", conversation_id: id })).json(), { ok: false, error: "not_escalated" });
  // wake: pending -> immediate wake
  const before = h.net.wakes.length;
  assert.equal(((await (await post_({ action: "wake", conversation_id: id })).json()) as any).ok, true);
  await h.flush();
  assert.equal(h.net.wakes.length, before + 1);
  // escalate via lease, then reopen (no auto wake), wake, resolve
  const lease = await claimAndRead(h);
  const { escalateConversation } = await import("../lib/tools");
  assert.deepEqual(await escalateConversation(h.ctx, id, lease, "red flag"), { ok: true, state: "escalated" });
  const ov: any = await (await adminGet(h.ctx, adminReq("GET"))).json();
  assert.equal(ov.conversations[0].state, "escalated");
  assert.equal(ov.conversations[0].escalation_reason, "red flag");
  assert.equal(JSON.stringify(ov).includes(lease), false);
  assert.deepEqual(await (await post_({ action: "wake", conversation_id: id })).json(), { ok: false, error: "not_pending_or_in_flight" });
  assert.equal(((await (await post_({ action: "reopen", conversation_id: id })).json()) as any).state, "pending");
  const w = h.net.wakes.length;
  await h.flush();
  assert.equal(h.net.wakes.length, w, "reopen does not wake by itself");
  await post_({ action: "resolve", conversation_id: id });
  const full: any = await (await adminGet(h.ctx, adminReq("GET", undefined, ADMIN_TOKEN, `?conversation=${id}`))).json();
  assert.equal(full.state, "replied");
  assert.equal(full.unhandled, 0);
  assert.equal(full.lease, undefined);
  assert.equal((await adminGet(h.ctx, adminReq("GET", undefined, ADMIN_TOKEN, "?conversation=c_" + "1".repeat(20)))).status, 404);
  // resume wakes every pending conversation at once
  await post(h, inboundPayload({ wamid: "wamid.AD2", from: "15550000009" }));
  await h.flush();
  h.clock.advance(60 * 1000);
  await post(h, inboundPayload({ wamid: "wamid.AD3", from: "15550000008" }));
  const r: any = await (await post_({ action: "set_auto_reply", value: "active" })).json();
  assert.equal(r.ok, true);
  assert.equal(r.auto_reply, "active");
});

test("cron: Bearer CRON_SECRET required, retries due wakes", async () => {
  const h = makeHarness();
  const mk = (t?: string) => new Request("https://x.test/api/cron/retry-wakes", { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  assert.equal((await handleCron(h.ctx, mk())).status, 401);
  assert.equal((await handleCron(h.ctx, mk("wrong-wrong-wrong-wrong"))).status, 401);
  assert.equal((await handleCron(makeHarness({ CRON_SECRET: "short" }).ctx, mk("short"))).status, 401);
  h.net.wakeStatus = 500;
  await post(h, inboundPayload({ wamid: "wamid.CR1" }));
  await h.flush();
  h.clock.advance(3 * 60 * 1000);
  h.net.wakeStatus = 200;
  const res = await handleCron(h.ctx, mk(CRON_SECRET));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tried: 1, retention: { examined: 0, changed: 0, purged: 0 } });
  assert.equal(h.net.wakes.length, 2);
  assert.equal((await getConv(h)).wake.status, "scheduled", "success is not persisted; claim records it");
});

test("MCP over HTTP: Bearer MCP_TOKEN, nine tools, calls work", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.MC1" }));
  const route = createMcpRoute(() => h.ctx);
  const rpc = async (method: string, params: unknown, token: string | null = MCP_TOKEN, id = 1) => {
    const res = await route(
      new Request("https://x.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
    return res;
  };
  const parse = async (res: Response) => {
    const t = await res.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : t);
  };
  assert.equal((await rpc("tools/list", {}, null)).status, 401);
  assert.equal((await rpc("tools/list", {}, "wrong-wrong-wrong-wrong")).status, 401);
  assert.equal((await route(new Request("https://x.test/mcp", { method: "GET" }))).status, 401);
  const list = await parse(await rpc("tools/list", {}));
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["claim_conversation", "escalate_conversation", "finish_conversation", "get_controls", "get_history", "get_overview", "list_pending", "release_conversation", "send_reply"]);
  const send = list.result.tools.find((t: any) => t.name === "send_reply");
  assert.ok(!("to" in send.inputSchema.properties), "send_reply has no recipient field");
  const call = async (name: string, args: unknown) => {
    const r = await parse(await rpc("tools/call", { name, arguments: args }, MCP_TOKEN, 2));
    return JSON.parse(r.result.content[0].text);
  };
  const pending = await call("list_pending", {});
  assert.equal(pending.length, 1);
  const claim = await call("claim_conversation", { conversation_id: pending[0].conversation_id });
  assert.equal(claim.ok, true);
  const hist = await call("get_history", { conversation_id: claim.conversation_id, lease: claim.lease });
  assert.equal(hist.messages.length, 1);
  const sent = await call("send_reply", { conversation_id: claim.conversation_id, lease: claim.lease, text: "hi" });
  assert.equal(sent.ok, true);
  assert.equal(h.net.graph.length, 1);
  assert.deepEqual(await call("finish_conversation", { conversation_id: claim.conversation_id, lease: claim.lease }), { ok: true, state: "replied" });
  const ctl = await call("get_controls", { conversation_id: claim.conversation_id });
  assert.equal(ctl.auto_reply, "active");
  assert.equal(ctl.conversation.state, "replied");
  // schema validation: a bad id is rejected before reaching the logic
  const bad = await parse(await rpc("tools/call", { name: "claim_conversation", arguments: { conversation_id: "nope" } }, MCP_TOKEN, 3));
  assert.ok(bad.error || bad.result?.isError);
});

import { statusPayload } from "./helpers";
const statusFor = (rk: string, i: number, status: string) => statusPayload({ wamid: `wamid.OUT${i + 1}`, status, rk });

test("logs carry IDs and counters only (no message text, names, numbers, tokens)", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.LG1", text: "my secret symptoms", name: "Zed Hidden" }));
  await h.flush();
  const lease = await claimAndRead(h);
  await sendReply(h.ctx, { conversation_id: cid(), lease, text: "private reply text" });
  await post(h, inboundPayload({ wamid: "wamid.LG2" }, ) as never);
  const bad = new Request("https://x.test/api/webhook", { method: "POST", body: "{}" });
  const { handleWebhookPost } = await import("../lib/webhook");
  await handleWebhookPost(h.ctx, bad);
  const dump = JSON.stringify(h.logs);
  assert.ok(h.logs.length > 5);
  for (const forbidden of ["my secret symptoms", "Zed Hidden", "private reply text", WA, "test-access-token", APP_SECRET, MCP_TOKEN, ADMIN_TOKEN, "test-wake-key"]) {
    assert.equal(dump.includes(forbidden), false, `log leaked ${forbidden.slice(0, 8)}`);
  }
});

test("MCP protocol: initialize negotiates a version, notifications get 202, batches work, bad input is a JSON-RPC error, GET/DELETE are 405", async () => {
  const h = makeHarness();
  const route = createMcpRoute(() => h.ctx);
  const send = (body: unknown, method = "POST", token: string | null = MCP_TOKEN) =>
    route(new Request("https://x.test/mcp", {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }));
  const init: any = await (await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "wab-bot");
  assert.ok(init.result.capabilities.tools);
  const unknownVersion: any = await (await send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
  assert.ok(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(unknownVersion.result.protocolVersion));
  const note = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  const batch: any = await (await send([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])).json();
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0].result, {});
  assert.equal(batch[1].result.tools.length, 9);
  const nf: any = await (await send({ jsonrpc: "2.0", id: 3, method: "nope/nope" })).json();
  assert.equal(nf.error.code, -32601);
  const bad: any = await (await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_history", arguments: { conversation_id: "c_" + "0".repeat(20), lease: "short" } } })).json();
  assert.equal(bad.error.code, -32602);
  const badLimit: any = await (await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_history", arguments: { conversation_id: "c_" + "0".repeat(20), lease: "x".repeat(32), limit: 51 } } })).json();
  assert.equal(badLimit.error.code, -32602);
  const unk: any = await (await send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything", arguments: {} } })).json();
  assert.equal(unk.error.code, -32602);
  assert.equal((await send("{not json")).status, 400);
  assert.equal((await send({}, "GET")).status, 405);
  assert.equal((await send({}, "DELETE")).status, 405);
  assert.equal((await send({}, "GET", null)).status, 401, "auth is checked before the method");
});
