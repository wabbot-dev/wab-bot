// Voice calling: webhook signature, owner gate, arm/disarm, call runner, call logs. All values are fake; the network is a stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CallRunner, HANGUP_CONFIRM_MS, HANGUP_MAX_TRIES, AI_GOODBYE_MS, AI_GOODBYE_MAX_MS, AI_PLAYBACK_TAIL_MS, GREETING_FALLBACK_MS, TX_MAX_LINES, TX_MAX_LINE_CHARS, type SocketLike } from "../lib/call-runner";
import { buildGreeting, buildInstructions, sipSessionUpdate } from "../lib/call-persona";
import { armCalling, disarmCalling, sweepCalling, deadmanAt, type ArmDeps } from "../lib/calls-arm";
import {
  ARM_KEY, INDEX_KEY, callKey, callingGate, eraseCall, estimateUsd, finishCall, handleSipWebhook, tombstone, txKey, usageKey,
  type ArmRow, type CallHost, type CallIndex, type CallLog, type CallTranscript, type CallUsage,
} from "../lib/calls";
import { loadConfig } from "../lib/config";
import { META_AS32934_V4, splitTo16 } from "../lib/meta-prefixes";
import { signStandardWebhook, verifyStandardWebhook } from "../lib/std-webhook";
import { handleWebhookPost } from "../lib/webhook";
import { PN, baseEnv, makeHarness, signedRequest, type Harness } from "./helpers";

const SECRET = ["whsec", Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")].join("_");
const NUMBER = "15551000000"; // fake display number of the test business
const GO = NUMBER;
const CALLER = "15550000001";
const XAI_KEY = "test-xai-key-0000000001";
const PW = "test-sip-password-0001";
const CALL_ID = "call_test_0001";

const callEnv = (over: Record<string, string> = {}) => baseEnv({ XAI_API_KEY: XAI_KEY, CALLING_MODE: "test", CALL_ALLOWED_CALLERS: CALLER, ...over });

// ---- a stub for Meta Graph + xAI REST: records every call, answers like the live services did
interface Rec { method: string; url: string; body: any; auth: string | null }
class CallNet {
  calls: Rec[] = [];
  metaCalling = "DISABLED";
  metaSip = "DISABLED";
  registerStatus = 200;
  metaEnableStatus = 200;
  metaDisableStatus = 200;
  deleteStatus = 204;
  hangupStatus = 200;
  existingNumbers: { phone_number_id: string; phone_number: string }[] = [];
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url, body, auth: new Headers(init?.headers as HeadersInit).get("authorization") });
    const j = (o: unknown, status = 200) => Response.json(o, { status });
    if (url.includes("graph.facebook.com")) {
      if (method === "GET" && url.includes("fields=display_phone_number")) return j({ display_phone_number: "+1 555-100-0000" });
      if (method === "GET" && url.includes("/settings")) return j({ calling: { status: this.metaCalling, srtp_key_exchange_protocol: "DTLS", audio: { additional_codecs: [] }, sip: { status: this.metaSip, servers: [{ hostname: "sip.voice.x.ai", port: 5061, sip_user_password: PW }] } } });
      if (method === "POST" && url.includes("/settings")) {
        const on = body?.calling?.status === "ENABLED";
        const st = on ? this.metaEnableStatus : this.metaDisableStatus;
        if (st === 200) { this.metaCalling = on ? "ENABLED" : "DISABLED"; this.metaSip = on ? "ENABLED" : "DISABLED"; }
        return j({ success: st === 200 }, st);
      }
    }
    if (url === "https://api.x.ai/v2/phone-numbers" && method === "GET") return j({ phone_numbers: this.existingNumbers });
    if (url === "https://api.x.ai/v2/phone-numbers" && method === "POST") return this.registerStatus === 200 ? j({ phone_number: { phone_number_id: "pn_test_1" }, webhook: { dispatch_signing_secret: SECRET } }) : j({ error: "x" }, this.registerStatus);
    if (url.startsWith("https://api.x.ai/v2/phone-numbers/") && method === "DELETE") return new Response(null, { status: this.deleteStatus });
    if (url.includes("/hangup")) return new Response("{}", { status: this.hangupStatus });
    throw new Error("unexpected network call " + url);
  };
  of(pred: (r: Rec) => boolean) { return this.calls.filter(pred); }
}

const setup = (over: Record<string, string> = {}) => {
  const h = makeHarness(callEnv(over));
  const net = new CallNet();
  h.ctx.fetch = net.fetch;
  const deadman: (number | null)[] = [];
  const deps: ArmDeps = { setDeadman: async (at) => { deadman.push(at); } };
  return { h, net, deps, deadman };
};
const WEBHOOK = "https://bridge.example.test/api/xai-sip";
const arm = (s: ReturnType<typeof setup>, o: Partial<{ minutes: number; maxCalls: number; number: string }> = {}) =>
  armCalling(s.h.ctx, { minutes: 10, maxCalls: 1, webhookUrl: WEBHOOK, ...o }, s.deps);
const row = async (h: Harness) => (await h.store.get<ArmRow>(ARM_KEY))?.value ?? null;

function sipRequest(body: unknown, o: { secret?: string; id?: string; ts?: number; raw?: string; method?: string } = {}): Request {
  const raw = o.raw ?? JSON.stringify(body);
  const ts = o.ts ?? Math.floor(Date.parse("2026-10-15T10:00:00.000Z") / 1000);
  const id = o.id ?? "msg_1";
  return new Request("https://bridge.example.test/api/xai-sip", {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(o.secret ?? SECRET, id, ts, raw) },
    body: o.method === "GET" ? undefined : raw,
  });
}
const incoming = (callId = CALL_ID, from = CALLER) => ({ type: "realtime.call.incoming", data: { call_id: callId, sip_headers: [{ name: "From", value: `<sip:+${from}@wa.meta.vc>;tag=x` }, { name: "To", value: `<sip:+${NUMBER}@sip.voice.x.ai>` }] } });
const fakeHost = () => {
  const started: { callId: string; logId: string }[] = [];
  const host: CallHost = { start: async (a) => { started.push(a); } };
  return { host, started };
};

// ------------------------------------------------------------------------------------------------ signature
test("Standard Webhooks: accepts a valid signature and refuses every tampering", () => {
  const raw = '{"a":1}';
  const now = Date.parse("2026-10-15T10:00:00.000Z");
  const ts = Math.floor(now / 1000);
  const hdr = (o: Record<string, string>) => new Headers(o);
  const good = { "webhook-id": "m1", "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(SECRET, "m1", ts, raw) };
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr(good), now), true);
  assert.equal(verifyStandardWebhook(SECRET, raw + " ", hdr(good), now), false, "body changed");
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr({ ...good, "webhook-id": "m2" }), now), false, "id changed");
  assert.equal(verifyStandardWebhook(["whsec", Buffer.from("x".repeat(32)).toString("base64")].join("_"), raw, hdr(good), now), false, "wrong secret");
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr(good), now + 301_000), false, "too old");
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr(good), now - 301_000), false, "too far in the future");
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr({ ...good, "webhook-timestamp": "abc" }), now), false);
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr({ "webhook-id": "m1", "webhook-timestamp": String(ts) }), now), false, "no signature");
  assert.equal(verifyStandardWebhook(undefined, raw, hdr(good), now), false, "no secret");
  assert.equal(verifyStandardWebhook("whsec_!!!", raw, hdr(good), now), false, "malformed secret");
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr({ ...good, "webhook-signature": "v2," + good["webhook-signature"].slice(3) }), now), false, "only v1 counts");
  // a list: the right signature may be any entry
  assert.equal(verifyStandardWebhook(SECRET, raw, hdr({ ...good, "webhook-signature": "v1,AAAA " + good["webhook-signature"] }), now), true);
});

test("Meta prefix list: every CIDR is IPv4 and /16 or narrower after splitting", () => {
  const out = splitTo16(META_AS32934_V4);
  assert.ok(out.length >= META_AS32934_V4.length);
  for (const c of out) { assert.match(c, /^\d+\.\d+\.\d+\.\d+\/\d+$/); assert.ok(Number(c.split("/")[1]) >= 16, c); }
  assert.deepEqual(splitTo16(["57.144.0.0/14"]), ["57.144.0.0/16", "57.145.0.0/16", "57.146.0.0/16", "57.147.0.0/16"]);
  assert.deepEqual(splitTo16(["2a03:2880::/32", "bad", "10.0.0.0/33", "10.0.0.0/24"]), ["10.0.0.0/24"]);
});

// ------------------------------------------------------------------------------------------------ persona
test("persona: neutral, options default OFF, never claims a recording state, session settings", () => {
  const cfg = loadConfig(callEnv());
  const g = buildGreeting(cfg);
  assert.match(g, /^Hello, you've reached our business\./);
  assert.doesNotMatch(g, /virtual assistant|recorded|not a person/i);
  assert.match(buildGreeting(loadConfig(callEnv({ CALL_DISCLOSE_AI: "1" }))), /virtual assistant/);
  assert.match(buildGreeting(loadConfig(callEnv({ CALL_RECORDING_LINE: "true" }))), /may be recorded/);
  assert.equal(buildGreeting(loadConfig(callEnv({ CALL_GREETING: "Custom hello" }))), "Custom hello");
  const ins = buildInstructions(cfg);
  assert.match(ins, /Never claim to be human/);
  assert.match(ins, /end_call/);
  assert.doesNotMatch(ins + g, /not recorded/i, "no promise that nothing is recorded");
  assert.equal(buildInstructions(loadConfig(callEnv({ CALL_INSTRUCTIONS: "Only this." }))), "Only this.");
  const su = sipSessionUpdate(cfg) as any;
  assert.equal(su.type, "session.update");
  assert.equal(su.session.voice, "eve");
  assert.equal(su.session.audio.input.format, undefined, "SIP leg: xAI picks the audio format");
  assert.deepEqual(su.session.audio, { input: { transcription: { model: "grok-transcribe" } } }, "caller transcription is requested explicitly (without it xAI sends no caller text)");
  assert.equal((sipSessionUpdate(loadConfig(callEnv({ CALL_TRANSCRIPTS: "0" }))) as any).session.audio, undefined, "transcripts off, no hint: no transcription block");
  assert.equal(su.session.tools[0].name, "end_call");
  assert.deepEqual((sipSessionUpdate(loadConfig(callEnv({ CALL_LANGUAGE_HINT: "fr", CALL_VOICE: "leo" }))) as any).session.audio, { input: { transcription: { model: "grok-transcribe", language_hint: "fr" } } });
  assert.deepEqual((sipSessionUpdate(loadConfig(callEnv({ CALL_LANGUAGE_HINT: "fr", CALL_TRANSCRIPTS: "off" }))) as any).session.audio, { input: { transcription: { language_hint: "fr" } } });
  assert.equal(loadConfig(callEnv({ CALL_VOICE: "bad voice!" })).callVoice, "eve");
  assert.equal(loadConfig(callEnv({ CALL_LANGUAGE_HINT: "not a code" })).callLanguageHint, "auto");
});

// ------------------------------------------------------------------------------------------------ owner gate
test("gate: off by default; every closed reason is named; test and live need their conditions", () => {
  const g = (o: Record<string, string>) => callingGate(loadConfig(baseEnv(o)));
  assert.deepEqual(g({}), { ok: false, reason: "calling_off" });
  assert.deepEqual(g({ CALLING_MODE: "bogus", XAI_API_KEY: XAI_KEY }), { ok: false, reason: "calling_off" });
  assert.equal(g({ CALLING_MODE: "test" }).reason, "xai_key_missing");
  assert.equal(g({ CALLING_MODE: "test", XAI_API_KEY: XAI_KEY, WA_ACCESS_TOKEN: "" }).reason, "whatsapp_not_configured");
  assert.equal(g({ CALLING_MODE: "test", XAI_API_KEY: XAI_KEY }).reason, "test_mode_needs_CALL_ALLOWED_CALLERS");
  assert.equal(g({ CALLING_MODE: "test", XAI_API_KEY: XAI_KEY, CALL_ALLOWED_CALLERS: CALLER }).ok, true);
  assert.match(g({ CALLING_MODE: "live", XAI_API_KEY: XAI_KEY }).reason!, /^live_mode_needs/);
  assert.match(g({ CALLING_MODE: "live", XAI_API_KEY: XAI_KEY, CALLING_BV_DONE: "1" }).reason!, /^live_mode_needs/);
  assert.match(g({ CALLING_MODE: "live", XAI_API_KEY: XAI_KEY, CALLING_GO_NUMBER: GO }).reason!, /^live_mode_needs/);
  assert.equal(g({ CALLING_MODE: "live", XAI_API_KEY: XAI_KEY, CALLING_GO_NUMBER: GO, CALLING_BV_DONE: "1" }).ok, true);
  assert.equal(g({ CALLING_MODE: "live", XAI_API_KEY: XAI_KEY, CALLING_GO_NUMBER: GO, CALLING_BV_DONE: "true" }).ok, false, "only the exact value 1 attests");
});

test("route is 404 while the gate is closed, and nothing is read or written", async () => {
  const h = makeHarness(baseEnv());
  const { host, started } = fakeHost();
  const r = await handleSipWebhook(h.ctx, sipRequest(incoming()), host);
  assert.equal(r.status, 404);
  assert.equal(started.length, 0);
  assert.deepEqual(h.doc.ops, { read: 0, write: 0 });
});

// ------------------------------------------------------------------------------------------------ arm / disarm
test("arm (test mode): registers at xAI, then enables Meta over SIP; secrets are stored, never returned", async () => {
  const s = setup();
  const r: any = await arm(s);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "test");
  assert.equal(r.max_calls, 1);
  assert.match(r.number_hint, /^…\d\d$/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp([SECRET, PW, XAI_KEY, "test-access-token-0000001"].join("|")), "no credential in the result");
  const reg = s.net.of((c) => c.method === "POST" && c.url.endsWith("/v2/phone-numbers"))[0]!;
  assert.equal(reg.auth, `Bearer ${XAI_KEY}`);
  assert.equal(reg.body.origin, "byo_trunk");
  assert.equal(reg.body.phone_number, "+" + NUMBER);
  assert.equal(reg.body.webhook.url, WEBHOOK);
  assert.equal(reg.body.sip_auth.auth_username, NUMBER);
  assert.equal(reg.body.sip_auth.auth_password, PW, "Meta's digest password goes to xAI only");
  assert.ok(reg.body.sip_auth.allowed_addresses.every((c: string) => Number(c.split("/")[1]) >= 16 && !c.includes(":")));
  const en = s.net.of((c) => c.method === "POST" && c.url.includes("/settings"))[0]!;
  assert.equal(en.body.calling.status, "ENABLED");
  assert.equal(en.body.calling.srtp_key_exchange_protocol, "SDES");
  assert.deepEqual(en.body.calling.audio.additional_codecs, ["PCMA", "PCMU"]);
  assert.deepEqual(en.body.calling.sip.servers, [{ hostname: "sip.voice.x.ai", port: 5061 }]);
  assert.ok(s.net.calls.indexOf(reg) < s.net.calls.indexOf(en), "xAI registration happens before Meta is switched on");
  const a = (await row(s.h))!;
  assert.equal(a.state, "armed");
  assert.equal(a.whSecret, SECRET);
  assert.equal(a.xaiPhoneId, "pn_test_1");
  assert.deepEqual(a.prior, { srtp: "DTLS", codecs: [] });
  assert.equal(s.deadman.at(-1), deadmanAt(a.expiresAt, s.h.ctx.cfg.callMaxSeconds));
});

test("arm refuses: gate closed, live number mismatch, already armed, calling already on, number already at xAI", async () => {
  const closed = setup({ CALLING_MODE: "" });
  assert.equal(((await arm(closed)) as any).error, "calling_gate_closed");
  assert.equal(closed.net.calls.length, 0, "no network when the gate is closed");

  const live = setup({ CALLING_MODE: "live", CALLING_BV_DONE: "1", CALLING_GO_NUMBER: GO });
  assert.equal(((await arm(live)) as any).error, "number_must_match_owner_approved_number", "live needs the number named");
  assert.equal(((await arm(live, { number: "15559999999" })) as any).error, "number_must_match_owner_approved_number");
  assert.equal(live.net.calls.length, 0);
  assert.equal(((await arm(live, { number: GO })) as any).ok, true);
  assert.equal(((await arm(live, { number: GO })) as any).error, "already_armed");

  const on = setup();
  on.net.metaCalling = "ENABLED";
  const r1: any = await arm(on);
  assert.deepEqual([r1.error, r1.step], ["arm_failed", "calling_already_enabled_on_number"]);
  assert.equal(on.net.of((c) => c.method === "POST").length, 0, "touched nothing");

  const dup = setup();
  dup.net.existingNumbers = [{ phone_number_id: "old", phone_number: "+" + NUMBER }];
  const r2: any = await arm(dup);
  assert.equal(r2.step, "number_already_registered_at_xai");
  assert.equal(dup.net.of((c) => c.method === "POST").length, 0);
  assert.equal((await row(dup.h))!.state, "disarmed", "the claim is released");
});

test("arm: a live-mode number that differs from the one Meta reports is refused", async () => {
  const s = setup({ CALLING_MODE: "live", CALLING_BV_DONE: "1", CALLING_GO_NUMBER: "15550000777" });
  const r: any = await arm(s, { number: "15550000777" });
  assert.deepEqual([r.error, r.step], ["arm_failed", "number_not_approved_by_owner"]);
  assert.equal(s.net.of((c) => c.method === "POST").length, 0);
});

test("arm: xAI failure leaves Meta untouched; Meta failure rolls the xAI number back", async () => {
  const a = setup();
  a.net.registerStatus = 401;
  const r1: any = await arm(a);
  assert.deepEqual([r1.error, r1.step, r1.status], ["arm_failed", "xai_register", 401]);
  assert.equal(a.net.of((c) => c.url.includes("/settings") && c.method === "POST").length, 0);

  const b = setup();
  b.net.metaEnableStatus = 400;
  const r2: any = await arm(b);
  assert.deepEqual([r2.error, r2.step, r2.disarmed], ["arm_failed", "meta_enable", true]);
  assert.equal(b.net.of((c) => c.method === "DELETE").length, 1, "xAI number deleted again");
  const rec = (await row(b.h))!;
  assert.equal(rec.state, "disarmed");
  assert.equal(rec.whSecret, undefined, "secret removed");
  assert.equal(rec.xaiPhoneId, undefined);
});

test("disarm: Meta DISABLED (restoring SRTP and codecs), xAI number deleted, secret gone; idempotent; failures are marked for retry", async () => {
  const s = setup();
  await arm(s);
  const r: any = await disarmCalling(s.h.ctx, "owner_disarm", s.deps);
  assert.deepEqual([r.ok, r.meta, r.xai_number], [true, "disabled", "deleted"]);
  const off = s.net.of((c) => c.method === "POST" && c.url.includes("/settings")).at(-1)!;
  assert.deepEqual(off.body.calling, { status: "DISABLED", sip: { status: "DISABLED", webhook_delivery: "DISABLED" }, srtp_key_exchange_protocol: "DTLS", audio: { additional_codecs: [] } });
  const a = (await row(s.h))!;
  assert.equal(a.state, "disarmed");
  assert.equal(a.whSecret, undefined);
  assert.equal(s.deadman.at(-1), null, "dead-man cleared");
  assert.equal(((await disarmCalling(s.h.ctx, "again", s.deps)) as any).ok, true, "second disarm is harmless");

  const f = setup();
  await arm(f);
  f.net.metaDisableStatus = 500;
  f.net.deleteStatus = 500;
  const r2: any = await disarmCalling(f.h.ctx, "owner_disarm", f.deps);
  assert.deepEqual([r2.ok, r2.meta, r2.xai_number], [false, "failed", "failed"]);
  const a2 = (await row(f.h))!;
  assert.equal(a2.needsRetry, true);
  assert.equal(a2.xaiPhoneId, "pn_test_1", "kept so the retry can delete it");
  assert.equal(a2.whSecret, undefined, "no calls are served meanwhile");
  assert.equal(((await arm(f)) as any).error, "previous_disarm_incomplete_run_disarm_first");
  f.net.metaDisableStatus = 200;
  f.net.deleteStatus = 204;
  assert.equal(await sweepCalling(f.h.ctx, f.deps), true, "the cron sweep retries it");
  assert.equal((await row(f.h))!.needsRetry, false);
});

test("sweep closes a window that outlived itself, and leaves a live one alone", async () => {
  const s = setup();
  await arm(s);
  assert.equal(await sweepCalling(s.h.ctx, s.deps), false);
  s.h.clock.advance(10 * 60_000 + s.h.ctx.cfg.callMaxSeconds * 1000 + 60_000);
  assert.equal(await sweepCalling(s.h.ctx, s.deps), true);
  assert.equal((await row(s.h))!.state, "disarmed");
  assert.equal(await sweepCalling(s.h.ctx, s.deps), false);
});

test("tombstone drops the secret and keeps the xAI id only when its delete failed", () => {
  const base: ArmRow = { state: "armed", mode: "test", pnid: PN, armedAt: 1, expiresAt: 2, maxCalls: 1, callsStarted: 0, callsFinished: 0, xaiPhoneId: "p", whSecret: SECRET };
  const ok = tombstone(base, { meta: "disabled", meta_status: 200, xai: "deleted", xai_status: 204 }, 5, "x");
  assert.deepEqual([ok.whSecret, ok.xaiPhoneId, ok.needsRetry], [undefined, undefined, false]);
  const bad = tombstone(base, { meta: "disabled", meta_status: 200, xai: "failed", xai_status: 500 }, 5, "x");
  assert.deepEqual([bad.whSecret, bad.xaiPhoneId, bad.needsRetry, bad.retries], [undefined, "p", true, 1]);
});

// ------------------------------------------------------------------------------------------------ webhook
test("webhook: unarmed and bad signatures get 401 and start nothing", async () => {
  const s = setup();
  const { host, started } = fakeHost();
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming()), host)).status, 401, "not armed: there is no secret to verify with");
  await arm(s);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming(), { secret: ["whsec", Buffer.from("y".repeat(32)).toString("base64")].join("_") }), host)).status, 401);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming(), { ts: 1_700_000_000 }), host)).status, 401, "stale timestamp");
  const unsigned = new Request("https://bridge.example.test/api/xai-sip", { method: "POST", body: JSON.stringify(incoming()) });
  assert.equal((await handleSipWebhook(s.h.ctx, unsigned, host)).status, 401);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming(), { method: "GET" }), host)).status, 405);
  await s.h.flush();
  assert.equal(started.length, 0);
  assert.equal(s.net.of((c) => c.url.includes("/hangup")).length, 0, "an unverified request never makes us call xAI");
});

test("webhook: an allowed caller inside the window starts ONE session; a redelivery does nothing", async () => {
  const s = setup();
  await arm(s);
  const { host, started } = fakeHost();
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming()), host)).status, 200);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(incoming(), { id: "msg_2" }), host)).status, 200, "redelivery");
  await s.h.flush();
  assert.equal(started.length, 1);
  assert.equal(started[0]!.callId, CALL_ID);
  assert.match(started[0]!.logId, /^cl_[0-9a-f]{20}$/);
  const log = (await s.h.store.get<CallLog>(callKey(started[0]!.logId)))!.value;
  assert.equal(log.outcome, "in_progress");
  assert.equal(log.callerHint, "…01", "only the last two digits are kept");
  assert.doesNotMatch(JSON.stringify(log), new RegExp(CALLER + "|" + CALL_ID), "neither the caller number nor xAI's call id is stored");
  assert.equal((await row(s.h))!.callsStarted, 1);
  assert.deepEqual((await s.h.store.get<CallIndex>(INDEX_KEY))!.value.ids, [log.id]);
});

test("webhook: other callers, a used-up window, an expired window and an exhausted budget are hung up", async () => {
  const cases: { name: string; prep(s: ReturnType<typeof setup>): Promise<void> | void; caller?: string; outcome: string }[] = [
    { name: "caller not allowed", prep: () => {}, caller: "15550000002", outcome: "rejected_caller" },
    { name: "window expired", prep: (s) => s.h.clock.advance(11 * 60_000), outcome: "rejected_not_armed" },
    { name: "budget used up", prep: async (s) => {
      await s.h.store.snapshot({ keys: [] });
      const { update } = await import("../lib/store");
      await update<CallUsage, null>(s.h.ctx, usageKey(s.h.ctx.now()), () => ({ next: { seconds: s.h.ctx.cfg.callBudgetSeconds, calls: 7, rejected: 0 }, result: null }));
    }, outcome: "rejected_budget" },
  ];
  for (const c of cases) {
    const s = setup();
    await arm(s);
    await c.prep(s);
    const { host, started } = fakeHost();
    const req = sipRequest(incoming("call_x_" + c.outcome, c.caller ?? CALLER), { ts: Math.floor(s.h.clock.now() / 1000) });
    assert.equal((await handleSipWebhook(s.h.ctx, req, host)).status, 200, c.name);
    await s.h.flush();
    assert.equal(started.length, 0, c.name);
    assert.equal(s.net.of((x) => x.url.includes("/hangup")).length, 1, c.name + ": hung up");
    const idx = (await s.h.store.get<CallIndex>(INDEX_KEY))!.value;
    assert.equal((await s.h.store.get<CallLog>(callKey(idx.ids[0]!)))!.value.outcome, c.outcome, c.name);
  }
  // max calls
  const s = setup();
  await arm(s, { maxCalls: 1 });
  const { host, started } = fakeHost();
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_a")), host);
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_b"), { id: "m3" }), host);
  await s.h.flush();
  assert.equal(started.length, 1, "the window allows one call");
  assert.equal(s.net.of((x) => x.url.includes("/hangup")).length, 1);
});

test("defaults: 120 s per call and 1200 s per UTC month; both can be set", () => {
  const d = loadConfig(callEnv());
  assert.equal(d.callMaxSeconds, 120);
  assert.equal(d.callBudgetSeconds, 1200);
  const o = loadConfig(callEnv({ CALL_MAX_SECONDS: "45", CALL_BUDGET_SECONDS: "300" }));
  assert.equal(o.callMaxSeconds, 45);
  assert.equal(o.callBudgetSeconds, 300);
});

test("budget: counted per UTC month; the next month starts at zero", async () => {
  const s = setup({ CALL_BUDGET_SECONDS: "100" });
  s.h.clock.advance(Date.parse("2026-10-31T23:55:00.000Z") - s.h.clock.now());
  await arm(s, { minutes: 10, maxCalls: 2 });
  const { update } = await import("../lib/store");
  await update<CallUsage, null>(s.h.ctx, usageKey(s.h.ctx.now()), () => ({ next: { seconds: 100, calls: 3, rejected: 0 }, result: null }));
  const { host, started } = fakeHost();
  const at = () => ({ ts: Math.floor(s.h.clock.now() / 1000) });
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_oct"), { id: "m_oct", ...at() }), host);
  await s.h.flush();
  assert.equal(started.length, 0, "October's budget is used up");
  s.h.clock.advance(Date.parse("2026-11-01T00:01:00.000Z") - s.h.clock.now());
  assert.notEqual(usageKey(Date.parse("2026-10-31T23:56:00.000Z")), usageKey(s.h.clock.now()), "a new month, a new usage row");
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_nov"), { id: "m_nov", ...at() }), host);
  await s.h.flush();
  assert.equal(started.length, 1, "November starts with a fresh budget");
});

test("webhook: a session that fails to start closes its log and hangs up", async () => {
  const s = setup();
  await arm(s);
  const host: CallHost = { start: async () => { throw new Error("boom"); } };
  await handleSipWebhook(s.h.ctx, sipRequest(incoming()), host);
  await s.h.flush();
  const idx = (await s.h.store.get<CallIndex>(INDEX_KEY))!.value;
  const log = (await s.h.store.get<CallLog>(callKey(idx.ids[0]!)))!.value;
  assert.equal(log.outcome, "failed_to_start");
  assert.equal(s.net.of((x) => x.url.includes("/hangup")).length, 1);
});

test("webhook: other event types are acknowledged and ignored; garbage ids are refused", async () => {
  const s = setup();
  await arm(s);
  const { host, started } = fakeHost();
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest({ type: "something.else", data: {} }), host)).status, 200);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest({ type: "realtime.call.incoming", data: { call_id: "../../x y" } }), host)).status, 400);
  assert.equal((await handleSipWebhook(s.h.ctx, sipRequest(null, { raw: "{not json" }), host)).status, 400);
  await s.h.flush();
  assert.equal(started.length, 0);
});

// ------------------------------------------------------------------------------------------------ finish + usage
test("finishCall writes the log, the month's usage and the window counter in one commit, once", async () => {
  const s = setup();
  await arm(s, { maxCalls: 2 });
  const { host } = fakeHost();
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_f1")), host);
  const logId = (await s.h.store.get<CallIndex>(INDEX_KEY))!.value.ids[0]!;
  const seen: boolean[] = [];
  const r = await finishCall(s.h.ctx, logId, { endReason: "ai_end_call", endedBy: "ai", durationS: 39.4, turns: { caller: 3, ai: 4 } }, async (x) => { seen.push(x.shouldDisarm); });
  assert.deepEqual(r, { shouldDisarm: false }, "one of two slots used");
  const again = await finishCall(s.h.ctx, logId, { endReason: "x", endedBy: "x", durationS: 100 });
  assert.equal(again.shouldDisarm, false);
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.deepEqual([log.outcome, log.durationS, log.endedBy, log.endReason, log.turns], ["completed", 39, "ai", "ai_end_call", { caller: 3, ai: 4 }]);
  const u = (await s.h.store.get<CallUsage>(usageKey(s.h.ctx.now())))!.value;
  assert.deepEqual([u.seconds, u.calls], [39, 1], "second finish did not double-count");
  assert.equal((await row(s.h))!.callsFinished, 1);
  // last slot: tells the caller to disarm
  await handleSipWebhook(s.h.ctx, sipRequest(incoming("call_f2"), { id: "m9" }), host);
  const id2 = (await s.h.store.get<CallIndex>(INDEX_KEY))!.value.ids[0]!;
  assert.deepEqual(await finishCall(s.h.ctx, id2, { endReason: "max_duration", endedBy: "limit", durationS: 90 }), { shouldDisarm: true });
  assert.equal(estimateUsd(39 + 90), 0.17);
});

// ------------------------------------------------------------------------------------------------ runner
class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed = false;
  private l: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  addEventListener(t: string, fn: (e: { data?: unknown }) => void) { (this.l[t] ??= []).push(fn); }
  emit(t: string, data?: unknown) { for (const f of this.l[t] ?? []) f({ data }); }
}
class Timers {
  items: { id: number; at: number; fn: () => void }[] = [];
  n = 0;
  now = 0;
  set = (fn: () => void, ms: number) => { const id = ++this.n; this.items.push({ id, at: this.now + ms, fn }); return id; };
  clear = (h: unknown) => { this.items = this.items.filter((t) => t.id !== h); };
  run(ms: number) {
    const to = this.now + ms;
    for (;;) {
      const next = this.items.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.items = this.items.filter((t) => t !== next);
      this.now = next.at;
      next.fn();
    }
    this.now = to;
  }
}

async function runnerSetup(over: Record<string, string> = {}, sleep?: (ms: number, sock: FakeSocket) => Promise<void>) {
  const s = setup(over);
  await arm(s, { maxCalls: 1 });
  const { host } = fakeHost();
  await handleSipWebhook(s.h.ctx, sipRequest(incoming()), host);
  const logId = (await s.h.store.get<CallIndex>(INDEX_KEY))!.value.ids[0]!;
  const sock = new FakeSocket();
  const timers = new Timers();
  const disarms: boolean[] = [];
  const runner = new CallRunner({
    getCtx: () => s.h.ctx,
    afterFinish: async (x) => { disarms.push(x.shouldDisarm); },
    openSocket: async () => sock,
    hangup: async (id) => { s.net.calls.push({ method: "POST", url: `hangup:${id}`, body: undefined, auth: null }); return { ok: true, status: 200, alreadyClosed: false }; },
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...(sleep ? { sleep: (ms: number) => sleep(ms, sock) } : {}),
  }, { callId: CALL_ID, logId });
  return { s, sock, timers, disarms, runner, logId };
}

test("CALL_SIP_WEBHOOKS: off by default (Meta SIP webhook_delivery DISABLED); on = ENABLED", async () => {
  const off = setup();
  await arm(off);
  assert.equal(off.net.of((c) => c.method === "POST" && c.url.includes("/settings"))[0]!.body.calling.sip.webhook_delivery, "DISABLED");
  const on = setup({ CALL_SIP_WEBHOOKS: "1" });
  await arm(on);
  assert.equal(on.net.of((c) => c.method === "POST" && c.url.includes("/settings"))[0]!.body.calling.sip.webhook_delivery, "ENABLED");
  assert.equal(loadConfig(callEnv({ CALL_SIP_WEBHOOKS: "yes" })).callSipWebhooks, false, "only the exact value 1");
});

test("Meta call webhooks (field calls): logged by type, call id, status and times only, and only with CALL_SIP_WEBHOOKS=1; nothing stored", async () => {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "2000000000002", changes: [{ field: "calls", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: NUMBER, phone_number_id: PN },
    calls: [{ id: "wacid.HBgLMTU1NTAwMDAwMDEVAgASGCBGQUtFMENBTEwwSUQwRkFLRTBDQUxMMA==", to: NUMBER, from: CALLER, event: "terminate", direction: "USER_INITIATED", status: "COMPLETED", duration: 17, timestamp: "1792232000", start_time: "1792231983", end_time: "1792232000", sdp: "v=0 SECRET-SDP", errors: [{ code: 138012, message: "caller words" }] }],
  } }] }] };
  const off = setup();
  assert.equal((await handleWebhookPost(off.h.ctx, signedRequest(payload))).status, 200);
  assert.equal(off.h.logs.filter((l) => l.event === "meta_call_event").length, 0, "off by default: ignored");
  const on = setup({ CALL_SIP_WEBHOOKS: "1" });
  assert.equal((await handleWebhookPost(on.h.ctx, signedRequest(payload))).status, 200);
  const ev = on.h.logs.filter((l) => l.event === "meta_call_event");
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0]!.fields, { event: "terminate", call_id: "wacid.HBgLMTU1NTAwMDAwMDEVAgASGCBGQUtFMENBTEwwSUQwRkFLRTBDQUxMMA==", status: "COMPLETED", direction: "USER_INITIATED", duration: "17", ts: "1792232000", start: "1792231983", end: "1792232000", err: "138012" });
  assert.doesNotMatch(JSON.stringify(on.h.logs), new RegExp([CALLER, "SECRET-SDP", "caller words"].join("|")), "no number, SDP or free text in the logs");
  const other = { ...payload, entry: [{ ...payload.entry[0]!, changes: [{ field: "calls", value: { ...(payload.entry[0]!.changes[0] as any).value, metadata: { phone_number_id: "999" } } }] }] };
  await handleWebhookPost(on.h.ctx, signedRequest(other));
  assert.equal(on.h.logs.filter((l) => l.event === "meta_call_event").length, 1, "another phone number id is ignored");
});

test("runner: session.update first, ONE greeting after session.updated, audio events ignored, text of each turn kept (transcripts on by default)", async () => {
  const { s, sock, runner, logId, timers } = await runnerSetup();
  await runner.start();
  assert.equal(sock.sent[0].type, "session.update");
  assert.equal(sock.sent.length, 1);
  sock.emit("message", JSON.stringify({ type: "session.updated" }));
  sock.emit("message", JSON.stringify({ type: "session.updated" }));
  assert.equal(sock.sent.filter((m) => m.item?.type === "force_message").length, 1);
  assert.equal(sock.sent[1].item.interruptible, false);
  timers.run(GREETING_FALLBACK_MS + 1);
  assert.equal(sock.sent.filter((m) => m.item?.type === "force_message").length, 1, "the fallback timer does not greet twice");
  sock.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: "AAAA" }));
  sock.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "hello there" }));
  sock.emit("message", JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "How can I help?" }));
  sock.emit("message", JSON.stringify({ type: "response.done" }));
  sock.emit("message", "not json");
  sock.emit("message", new ArrayBuffer(4));
  await runner.end("test_end", "owner");
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.deepEqual(log.turns, { caller: 1, ai: 1 });
  assert.equal(log.errors, 1);
  assert.doesNotMatch(JSON.stringify(log), /hello there/, "the log row itself holds no text");
  assert.deepEqual(log.transcript, { lines: 2, expiresAt: s.h.clock.now() + 30 * 86400_000 });
  const tx = (await s.h.store.get<CallTranscript>(txKey(logId)))!.value;
  assert.deepEqual(tx.lines.map((l) => [l.who, l.text]), [["caller", "hello there"], ["ai", "How can I help?"]]);
  assert.equal(sock.closed, true);
});

const emit = (sock: FakeSocket, o: unknown) => sock.emit("message", JSON.stringify(o));

test("transcripts: one caller turn per xAI item id (completed twice = one turn, latest text), streaming updates ignored, the greeting is in the transcript", async () => {
  const { s, sock, runner, logId } = await runnerSetup();
  await runner.start();
  emit(sock, { type: "session.updated" });
  emit(sock, { type: "response.output_audio_transcript.done", item_id: "g", transcript: "Hello, you've reached our business." });
  emit(sock, { type: "conversation.item.input_audio_transcription.updated", item_id: "c1", transcript: "Hi what" });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "Hi, what time" });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "Hi, what time do you open?" });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c2", transcript: "   " });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c3", transcript: 42 });
  await runner.end("test_end", "owner");
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.deepEqual(log.turns, { caller: 3, ai: 0 }, "empty text still counts as a turn the caller took");
  const tx = (await s.h.store.get<CallTranscript>(txKey(logId)))!.value;
  assert.deepEqual(tx.lines.map((l) => [l.who, l.text]), [["ai", "Hello, you've reached our business."], ["caller", "Hi, what time do you open?"]]);
  assert.equal(tx.truncated, undefined);
  assert.equal(typeof tx.lines[0].atS, "number");
});

test("transcripts: caps (characters per turn, number of turns) keep the row small and say so", async () => {
  const { s, sock, runner, logId } = await runnerSetup();
  await runner.start();
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "long", transcript: "x".repeat(TX_MAX_LINE_CHARS + 500) });
  for (let i = 0; i < TX_MAX_LINES + 20; i++) emit(sock, { type: "response.output_audio_transcript.done", item_id: "a" + i, transcript: "ok " + i });
  await runner.end("test_end", "owner");
  const tx = (await s.h.store.get<CallTranscript>(txKey(logId)))!.value;
  assert.equal(tx.lines[0].text.length, TX_MAX_LINE_CHARS);
  assert.equal(tx.lines.length, TX_MAX_LINES);
  assert.equal(tx.truncated, true);
  assert.equal((await s.h.store.get<CallLog>(callKey(logId)))!.value.transcript?.truncated, true);
});

test("transcripts: owner setting OFF keeps no text and no row; caller turns fall back to speech segments", async () => {
  const { s, sock, runner, logId } = await runnerSetup({ CALL_TRANSCRIPTS: "0" });
  await runner.start();
  assert.equal(sock.sent[0].session.audio, undefined, "no caller transcription is requested");
  emit(sock, { type: "input_audio_buffer.speech_started" });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "never stored" });
  emit(sock, { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "never stored either" });
  emit(sock, { type: "response.done" });
  await runner.end("test_end", "owner");
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.equal(log.transcript, undefined);
  assert.deepEqual(log.turns, { caller: 1, ai: 1 });
  assert.equal(await s.h.store.get(txKey(logId)), null);
  assert.doesNotMatch(JSON.stringify(log), /never stored/);
});

test("transcripts: with the setting OFF, finishCall itself refuses to store text even if a caller hands it some (second guard)", async () => {
  const { s, sock, runner, logId } = await runnerSetup({ CALL_TRANSCRIPTS: "0" });
  await runner.start();
  void sock;
  await finishCall(s.h.ctx, logId, { endReason: "x", endedBy: "system", durationS: 1, transcript: { lines: [{ who: "caller", atS: 1, text: "must not be stored" }] } });
  assert.equal(await s.h.store.get(txKey(logId)), null);
  assert.equal((await s.h.store.get<CallLog>(callKey(logId)))!.value.transcript, undefined);
});

test("transcripts: expire after the retention days (log row stays); retention setting is clamped", async () => {
  const { s, sock, runner, logId } = await runnerSetup({ CALL_TRANSCRIPT_RETENTION_DAYS: "7" });
  await runner.start();
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "keep me a week" });
  await runner.end("test_end", "owner");
  assert.ok(await s.h.store.get(txKey(logId)));
  assert.equal((await s.h.store.get<CallLog>(callKey(logId)))!.value.transcript?.expiresAt, s.h.clock.now() + 7 * 86400_000);
  s.h.clock.advance(7 * 86400_000 + 1000);
  assert.equal(await s.h.store.get(txKey(logId)), null, "transcript gone after 7 days");
  assert.ok(await s.h.store.get(callKey(logId)), "the metadata log lives on (90 days)");
  assert.equal(loadConfig(callEnv({})).callTranscriptDays, 30);
  assert.equal(loadConfig(callEnv({ CALL_TRANSCRIPT_RETENTION_DAYS: "9999" })).callTranscriptDays, 365);
  assert.equal(loadConfig(callEnv({ CALL_TRANSCRIPT_RETENTION_DAYS: "0" })).callTranscriptDays, 1);
  assert.equal(loadConfig(callEnv({ CALL_TRANSCRIPT_RETENTION_DAYS: "soon" })).callTranscriptDays, 30);
  assert.equal(loadConfig(callEnv({})).callTranscripts, true, "ON by default");
  for (const off of ["0", "false", "no", "OFF"]) assert.equal(loadConfig(callEnv({ CALL_TRANSCRIPTS: off })).callTranscripts, false, off);
});

test("eraseCall: removes the log, the transcript and the index entry in one commit; refuses an in-progress call; keeps the usage counters", async () => {
  const { s, sock, runner, logId } = await runnerSetup();
  await runner.start();
  assert.deepEqual(await eraseCall(s.h.ctx, logId), { ok: false, error: "call_in_progress" });
  emit(sock, { type: "conversation.item.input_audio_transcription.completed", item_id: "c1", transcript: "private words" });
  s.h.clock.advance(12_000);
  await runner.end("test_end", "owner");
  const usage = (await s.h.store.get<CallUsage>(usageKey(s.h.clock.now())))!.value;
  assert.deepEqual(await eraseCall(s.h.ctx, "cl_" + "9".repeat(20)), { ok: false, error: "not_found" });
  assert.deepEqual(await eraseCall(s.h.ctx, logId), { ok: true, erased_transcript: true });
  assert.equal(await s.h.store.get(callKey(logId)), null);
  assert.equal(await s.h.store.get(txKey(logId)), null);
  assert.deepEqual((await s.h.store.get<CallIndex>(INDEX_KEY))!.value.ids, []);
  assert.deepEqual((await s.h.store.get<CallUsage>(usageKey(s.h.clock.now())))!.value, usage);
  assert.deepEqual(await eraseCall(s.h.ctx, logId), { ok: false, error: "not_found" }, "second erase is a clean not_found");
  // a late final write from a session that was erased mid-flight recreates nothing
  await finishCall(s.h.ctx, logId, { endReason: "late", endedBy: "system", durationS: 1, transcript: { lines: [{ who: "caller", atS: 1, text: "late" }] } });
  assert.equal(await s.h.store.get(txKey(logId)), null);
  assert.equal(await s.h.store.get(callKey(logId)), null);
});

test("persona: if asked about recording the agent says a transcript is kept (never that nothing is kept); with transcripts off it cannot confirm", () => {
  const on = buildInstructions(loadConfig(callEnv({})));
  assert.match(on, /written transcript of the conversation is kept/);
  assert.match(on, /no audio is recorded/);
  assert.doesNotMatch(on, /not recorded|isn't recorded|is not recorded/i);
  const off = buildInstructions(loadConfig(callEnv({ CALL_TRANSCRIPTS: "0" })));
  assert.match(off, /cannot confirm/);
  assert.doesNotMatch(off, /transcript of the conversation is kept/);
  assert.match(buildInstructions(loadConfig(callEnv({ CALL_RECORDING_LINE: "1" }))), /told the call may be recorded/);
});

test("runner: greets by timer when session.updated never arrives", async () => {
  const { sock, runner, timers } = await runnerSetup();
  await runner.start();
  timers.run(GREETING_FALLBACK_MS + 1);
  assert.equal(sock.sent.filter((m) => m.item?.type === "force_message").length, 1);
});

test("runner: the model's end_call ends the call after the goodbye; the last slot disarms", async () => {
  const { s, sock, runner, logId, timers, disarms } = await runnerSetup();
  await runner.start();
  s.h.clock.advance(38_000);
  sock.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call" }));
  sock.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name: "something_else" }));
  assert.equal(runner.isEnded, false);
  timers.run(AI_GOODBYE_MS + 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isEnded, true);
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.deepEqual([log.outcome, log.endedBy, log.endReason, log.durationS], ["completed", "ai", "ai_end_call", 38]);
  assert.ok(s.net.calls.some((c) => c.url === `hangup:${CALL_ID}`));
  assert.deepEqual(disarms, [true]);
});

test("runner: end_call while the goodbye is still playing waits for xAI's playback-stopped event, answers the tool call, and does not ask for another response", async () => {
  const { s, sock, runner, logId, timers } = await runnerSetup();
  await runner.start();
  s.h.clock.advance(19_000);
  sock.emit("message", JSON.stringify({ type: "output_audio_buffer.started" }));
  sock.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call", call_id: "fc_1" }));
  sock.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call", call_id: "fc_2" })); // a repeat changes nothing
  const outs = sock.sent.filter((m) => m.item?.type === "function_call_output");
  assert.equal(outs.length, 1, "the tool call is answered exactly once");
  assert.deepEqual([outs[0].type, outs[0].item.call_id, JSON.parse(outs[0].item.output)], ["conversation.item.create", "fc_1", { ok: true }]);
  timers.run(AI_GOODBYE_MS + 1); // the old fixed 2.5 s would have hung up here, in the middle of the goodbye
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isEnded, false, "still playing: do not hang up yet");
  sock.emit("message", JSON.stringify({ type: "output_audio_buffer.stopped" }));
  assert.equal(runner.isEnded, false);
  timers.run(AI_PLAYBACK_TAIL_MS + 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isEnded, true);
  assert.equal(sock.sent.filter((m) => m.type === "response.create").length, 0, "no response.create after the function output");
  const log = (await s.h.store.get<CallLog>(callKey(logId)))!.value;
  assert.deepEqual([log.endedBy, log.endReason], ["ai", "ai_end_call"]);
  assert.equal(s.net.calls.filter((c) => c.url === `hangup:${CALL_ID}`).length, 1);
});

test("runner: if the playback-stopped event never comes, end_call still hangs up after the maximum goodbye wait", async () => {
  const { sock, runner, timers } = await runnerSetup();
  await runner.start();
  sock.emit("message", JSON.stringify({ type: "output_audio_buffer.started" }));
  sock.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", name: "end_call" }));
  timers.run(AI_GOODBYE_MAX_MS - 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isEnded, false);
  timers.run(2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.isEnded, true);
});

test("runner: after the hang-up request it waits for xAI to close the socket and asks again (up to the limit) when it does not", async () => {
  const waits: number[] = [];
  const a = await runnerSetup({}, async (ms) => { waits.push(ms); });
  await a.runner.start();
  await a.runner.end("test_end", "owner");
  assert.equal(a.s.net.calls.filter((c) => c.url === `hangup:${CALL_ID}`).length, HANGUP_MAX_TRIES, "xAI never closed: asked HANGUP_MAX_TRIES times");
  assert.deepEqual(waits, Array(HANGUP_MAX_TRIES).fill(HANGUP_CONFIRM_MS));
  assert.equal(a.sock.closed, true, "our socket is closed at the end");

  const b = await runnerSetup({}, async (_ms, sock) => { sock.emit("close"); }); // xAI closes right after the first request: that is the confirmation
  await b.runner.start();
  await b.runner.end("test_end", "owner");
  assert.equal(b.s.net.calls.filter((c) => c.url === `hangup:${CALL_ID}`).length, 1);

  const c = await runnerSetup({}, async () => { throw new Error("must not wait"); }); // the caller hung up: xAI closed first, nothing to confirm
  await c.runner.start();
  c.sock.emit("close");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.runner.isEnded, true);
  assert.equal(c.s.net.calls.filter((x) => x.url === `hangup:${CALL_ID}`).length, 1);
});

test("runner: maximum duration ends the call; a socket close ends it once; end is idempotent", async () => {
  const a = await runnerSetup();
  await a.runner.start();
  const maxMs = a.s.h.ctx.cfg.callMaxSeconds * 1000;
  a.s.h.clock.advance(maxMs);
  a.timers.run(maxMs + 1);
  await new Promise((r) => setTimeout(r, 20));
  const la = (await a.s.h.store.get<CallLog>(callKey(a.logId)))!.value;
  assert.deepEqual([la.endedBy, la.endReason], ["limit", "max_duration"]);

  const b = await runnerSetup();
  await b.runner.start();
  b.sock.emit("close");
  b.sock.emit("close");
  await b.runner.end("again", "owner");
  await new Promise((r) => setTimeout(r, 20));
  const lb = (await b.s.h.store.get<CallLog>(callKey(b.logId)))!.value;
  assert.deepEqual([lb.endedBy, lb.endReason], ["caller_or_network", "xai_closed"]);
  assert.equal(b.disarms.length, 1, "finished exactly once");
  assert.equal(b.s.net.calls.filter((c) => c.url.startsWith("hangup:")).length, 1);
});
