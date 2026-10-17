import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signStandardWebhook } from "../../lib/std-webhook";
import { DISARM_GRACE_MS } from "../../lib/call-runner";
import { stateStub } from "../../src/do-backend";
import { callWith, testEnv } from "./helpers";

// FAKE values. Meta Graph, the xAI REST API and xAI's realtime socket are all stubbed in-test: no network is used.
const ADMIN_MCP = "test-admin-mcp-token-0123456789abcdef";
const SECRET = ["whsec", btoa("0123456789abcdef0123456789abcdef")].join("_");
const CALLER = "15550000001";
const NUMBER = "15551000000";
const PW = "test-sip-password-0001";
const PNID = "1000000000001";

interface Rec { method: string; url: string; body: any; t: number }
let calls: Rec[] = [];
let server: WebSocket | null = null;
let closeServerSocket: () => void = () => undefined;
let fromDo: any[] = [];
let metaState = { calling: "DISABLED", sip: "DISABLED" };

function stubAll() {
  calls = []; fromDo = []; server = null; closeServerSocket = () => undefined; metaState = { calling: "DISABLED", sip: "DISABLED" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, t: Date.now() });
    if (url.startsWith("https://graph.facebook.com/")) {
      if (method === "GET" && url.includes("fields=display_phone_number")) return Response.json({ display_phone_number: "+1 555-100-0000" });
      if (method === "GET") return Response.json({ calling: { status: metaState.calling, srtp_key_exchange_protocol: "DTLS", audio: { additional_codecs: [] }, sip: { status: metaState.sip, servers: [{ hostname: "sip.voice.x.ai", port: 5061, sip_user_password: PW }] } } });
      const on = body?.calling?.status === "ENABLED";
      metaState = { calling: on ? "ENABLED" : "DISABLED", sip: on ? "ENABLED" : "DISABLED" };
      return Response.json({ success: true });
    }
    if (url === "https://api.x.ai/v2/phone-numbers" && method === "GET") return Response.json({ phone_numbers: [] });
    if (url === "https://api.x.ai/v2/phone-numbers" && method === "POST") return Response.json({ phone_number: { phone_number_id: "pn_test_1" }, webhook: { dispatch_signing_secret: SECRET } });
    if (url.startsWith("https://api.x.ai/v2/phone-numbers/") && method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/hangup")) { setTimeout(() => closeServerSocket(), 20); return new Response("{}", { status: 200 }); } // like xAI: the realtime socket closes once the SIP leg is hung up
    if (url.startsWith("https://api.x.ai/v1/realtime?call_id=")) {
      // a plain object, not a real socket: a real one is bound to the Durable Object that opened it
      const listeners: Record<string, (ev: { data?: unknown }) => void> = {};
      const fake = {
        accept() {}, close() {}, send(d: string) { fromDo.push(JSON.parse(d)); },
        addEventListener(t: string, fn: (ev: { data?: unknown }) => void) { listeners[t] = fn; },
      };
      closeServerSocket = () => listeners.close?.({});
      server = { send: (d: string) => listeners.message?.({ data: d }) } as unknown as WebSocket;
      return { status: 101, webSocket: fake } as unknown as Response;
    }
    throw new Error("unexpected network call " + url);
  });
}
beforeEach(stubAll);
afterEach(() => { vi.restoreAllMocks(); });

const env = (over: Record<string, string> = {}) => ({ ...testEnv, ...over }) as typeof testEnv;
let ip = 0;
const admin = (e: typeof testEnv, body: unknown, token = ADMIN_MCP, clientIp = `203.0.113.${100 + (++ip % 100)}`) =>
  callWith(e, "/admin/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "cf-connecting-ip": clientIp }, body: JSON.stringify(body) });
const tool = async (e: typeof testEnv, name: string, args: unknown = {}) => {
  const j: any = await (await admin(e, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json();
  if (j.error) return { error: j.error };
  return JSON.parse(j.result.content[0].text);
};
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

function sip(callId: string, from = CALLER, secret = SECRET) {
  const raw = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: callId, sip_headers: [{ name: "From", value: `<sip:+${from}@wa.meta.vc>` }] } });
  const ts = Math.floor(Date.now() / 1000);
  return callWith(env(), "/api/xai-sip", { method: "POST", headers: { "webhook-id": "m_" + callId, "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(secret, "m_" + callId, ts, raw) }, body: raw });
}

describe("admin MCP in workerd", () => {
  it("is 404 without the binding, 401 with a wrong token, and serves the 14 tools with the right one", async () => {
    expect((await callWith(env({ ADMIN_MCP_TOKEN: "" }), "/admin/mcp", { method: "POST", headers: { Authorization: `Bearer ${ADMIN_MCP}` }, body: "{}" })).status).toBe(404);
    expect((await admin(env(), { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-wrong-wrong-wrong-wrong-wrong-12")).status).toBe(401);
    const j: any = await (await admin(env(), { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    expect(j.result.tools).toHaveLength(14);
    const st = await tool(env(), "get_status");
    expect(st.read_only).toBe(true);
    expect(st.config_present.ADMIN_MCP_TOKEN).toBe(true);
    expect(JSON.stringify(st)).not.toContain(ADMIN_MCP);
    expect(JSON.stringify(st)).not.toContain("test-xai-key-0000000001");
  });

  it("failed attempts are blocked by the Durable Object limiter after 10, per client, and the right token still works for others", async () => {
    const e = env();
    const bad = "198.51.100.77";
    for (let i = 0; i < 10; i++) expect((await admin(e, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-wrong-wrong-wrong-wrong-wrong-12", bad)).status).toBe(401);
    const r = await admin(e, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-wrong-wrong-wrong-wrong-wrong-12", bad);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await admin(e, { jsonrpc: "2.0", id: 1, method: "ping" }, ADMIN_MCP, "198.51.100.78")).status).toBe(200);
  });

  it("the Durable Object counter: windows, reset after the window, bounded table", async () => {
    const s = stateStub(testEnv.STATE);
    const t0 = 5_000_000;
    const key = "t-" + Math.random();
    for (let i = 1; i <= 3; i++) expect((await s.rateHit(key, t0, 60_000, 3)).allowed).toBe(true);
    const over = await s.rateHit(key, t0 + 1000, 60_000, 3);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBe(59);
    expect((await s.rateHit(key, t0 + 61_000, 60_000, 3)).allowed).toBe(true);
    for (let i = 0; i < 260; i++) await s.rateHit(`flood-${i}`, t0 + 70_000 + i, 600_000, 5);
    const left = await s.rateHit("probe", t0 + 80_000, 600_000, 5);
    expect(left.count).toBe(1);
  });

  it("erase through the admin MCP removes the conversation (shared erase safeguard) and read tools never show text", async () => {
    const { inbound, signedPost, freshWa, convOf } = await import("./helpers");
    const wa = freshWa();
    await signedPost(JSON.stringify(inbound("wamid.MCPE" + wa, "PRIVATE WORDS", wa)));
    const row = await convOf(wa);
    const list = await tool(env(), "list_conversations", { limit: 100 });
    expect(JSON.stringify(list)).not.toContain("PRIVATE WORDS");
    expect(JSON.stringify(list)).not.toContain(wa);
    expect((await tool(env(), "erase_conversation", { conversation_id: row.id })).error.code).toBe(-32602);
    expect(await tool(env(), "erase_conversation", { conversation_id: row.id, confirm: row.id })).toEqual({ ok: true, deleted: true });
    expect(await convOf(wa)).toBeNull();
  });
});

describe("voice calling in workerd: owner gate, webhook, session Durable Object, auto-disarm", () => {
  it("the webhook is 404 while the owner gate is closed", async () => {
    const r = await callWith(env({ CALLING_MODE: "off" }), "/api/xai-sip", { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
    expect((await tool(env({ CALLING_MODE: "off" }), "arm_calling", { confirm: true })).error).toBe("calling_gate_closed");
    expect(calls.filter((c) => c.url.includes("x.ai") || c.url.includes("facebook"))).toHaveLength(0);
  });

  it("arm -> signed webhook -> session greets, the AI ends the call -> log, usage, and the window switches itself off", async () => {
    const e = env();
    const armed = await tool(e, "arm_calling", { confirm: true, minutes: 5, max_calls: 1 });
    expect(armed.ok).toBe(true);
    expect(metaState).toEqual({ calling: "ENABLED", sip: "ENABLED" });
    expect((await tool(e, "calling_status")).armed).toBe(true);
    expect(JSON.stringify(armed)).not.toContain(SECRET);

    expect((await sip("call_wk_bad", CALLER, ["whsec", btoa("y".repeat(32))].join("_"))).status).toBe(401);
    expect((await sip("call_wk_1", "15550000099")).status).toBe(200); // not an allowed caller: hung up, no session
    expect(server).toBeNull();
    expect(calls.some((c) => c.url.includes("/hangup"))).toBe(true);
    expect((await tool(e, "disarm_calling")).ok).toBe(true);
    expect((await tool(e, "calling_status")).armed).toBe(false);
  });

  it("a real call: session.update, one greeting, end_call, final log, auto-disarm", async () => {
    const e = env();
    calls.length = 0;
    const armed = await tool(e, "arm_calling", { confirm: true, minutes: 5, max_calls: 1 });
    expect(armed.ok).toBe(true);
    const r = await sip("call_wk_live");
    expect(r.status).toBe(200);
    await until(() => server !== null && fromDo.length >= 1);
    expect(fromDo[0].type).toBe("session.update");
    server!.send(JSON.stringify({ type: "session.updated" }));
    await until(() => fromDo.some((m) => m.item?.type === "force_message"));
    server!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "caller words kept in the transcript, ring +1 555 010 0000" }));
    server!.send(JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Goodbye, take care." }));
    server!.send(JSON.stringify({ type: "response.done" }));
    server!.send(JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call", call_id: "fc_live" }));
    await until(() => metaState.calling === "DISABLED", 15000);
    // the tool call is answered, and the auto-disarm waits DISARM_GRACE_MS after the hang-up (a same-second Meta disable + number delete showed up as a FAILED call on the live test)
    expect(fromDo.some((m) => m.item?.type === "function_call_output" && m.item.call_id === "fc_live")).toBe(true);
    const hang = calls.filter((c) => c.url.includes("/hangup")).map((c) => c.t).sort((a, b) => a - b)[0];
    const del = calls.find((c) => c.method === "DELETE" && c.url.endsWith("/pn_test_1"))!.t;
    expect(del - hang).toBeGreaterThanOrEqual(DISARM_GRACE_MS - 250);
    // the object slept after the call (no runner in memory) and its max-duration alarm fires later: it must not hang up again or log "interrupted"
    const stub = e.CALLS.get(e.CALLS.idFromName("call_wk_live")) as any;
    await (runInDurableObject as any)(stub, async (inst: any) => { inst.runner = undefined; });
    const hangupsBefore = calls.filter((c) => c.url.includes("/hangup")).length;
    expect(await (runDurableObjectAlarm as any)(stub)).toBe(true);
    expect(calls.filter((c) => c.url.includes("/hangup")).length).toBe(hangupsBefore);
    const logs = await tool(e, "list_call_logs");
    expect(logs.total_matching).toBeGreaterThanOrEqual(1);
    const mine = logs.calls.find((c: any) => c.outcome === "completed");
    expect(mine.ended_by).toBe("ai");
    expect(mine.end_reason).toBe("ai_end_call"); // not overwritten by the late alarm
    expect(mine.turns).toEqual({ caller: 1, ai: 1 });
    expect(JSON.stringify(logs)).not.toContain("caller words");
    expect(JSON.stringify(logs)).not.toContain(CALLER);
    expect(mine.transcript.stored).toBe(true);
    expect((await tool(e, "get_call_log", { call_id: mine.id })).outcome).toBe("completed");
    const txr = await tool(e, "get_call_log", { call_id: mine.id, include_transcript: true });
    expect(txr.transcript.lines.map((l: any) => l.who)).toEqual(["caller", "ai"]);
    expect(txr.transcript.lines[0].text).toContain("caller words kept in the transcript");
    expect(txr.transcript.lines[0].text).not.toContain("555");
    expect(txr.transcript.lines[1].text).toBe("Goodbye, take care.");
    const er = await tool(e, "erase_call_log", { call_id: mine.id, confirm: mine.id });
    expect(er).toEqual({ ok: true, erased_transcript: true });
    expect((await tool(e, "get_call_log", { call_id: mine.id })).error).toBe("not_found");
    expect((await tool(e, "list_call_logs")).calls.some((c: any) => c.id === mine.id)).toBe(false);
    const cs = await tool(e, "calling_status");
    expect(cs.armed).toBe(false);
    expect(cs.last_disarm.reason).toBe("last_call_ended");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pn_test_1"))).toBe(true);
    expect(calls.filter((c) => c.url.includes("/hangup")).length).toBeGreaterThanOrEqual(1);
    const u = await tool(e, "get_usage_summary");
    expect(u.voice_calls.calls_answered).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await tool(e, "get_status"))).not.toContain(SECRET);
  }, 20000);

  it("the dead-man alarm switches calling off by itself and deletes the xAI number", async () => {
    const e = env();
    expect((await tool(e, "arm_calling", { confirm: true, minutes: 5, max_calls: 2 })).ok).toBe(true);
    expect(metaState.calling).toBe("ENABLED");
    calls.length = 0;
    expect(await runDurableObjectAlarm(stateStub(testEnv.STATE))).toBe(true);
    expect(metaState).toEqual({ calling: "DISABLED", sip: "DISABLED" });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pn_test_1"))).toBe(true);
    const cs = await tool(e, "calling_status");
    expect(cs.armed).toBe(false);
    expect(cs.last_disarm.reason).toBe("deadman");
    expect(await runDurableObjectAlarm(stateStub(testEnv.STATE))).toBe(false); // nothing left to do
  });

  it("disarm_calling works when nothing is armed", async () => {
    const r = await tool(env(), "disarm_calling");
    expect(r.ok).toBe(true);
    expect(metaState.calling).toBe("DISABLED");
  });
});
