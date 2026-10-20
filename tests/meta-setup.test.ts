import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, Redactor, writeSecretsFile } from "../scripts/meta-setup.mjs";

// All values are fake, test-only strings. Nothing here touches the network.
const TOKEN = "EAAFAKEtokenFAKEtokenFAKEtoken0123456789";
const APP_SECRET = "fakeappsecret0123456789abcdef";
const PIN = "135790";
const VERIFY = "verify-token-test-0123456789";
const WABA = "1111111111111111";
const PHONE = "2222222222222222";
const APP = "3333333333333333";
const URL_ = "https://example-bridge.example.workers.dev/api/webhook";
const BASE = ["--waba-id", WABA, "--phone-number-id", PHONE, "--webhook-url", URL_, "--verify-token", VERIFY, "--no-prompt"];

type Call = { method: string; url: string; auth: string; body: string };
interface Opts {
  scopes?: string[]; expires?: number; valid?: boolean; subscribeVisible?: boolean; subPostFails?: boolean; appSubOk?: boolean;
  leakTokenInErrors?: boolean; handshakeOk?: boolean; phones?: any[]; granular?: any[];
  existingAppCallback?: string; existingPhoneOverride?: string;
}
function fakeMeta(o: Opts = {}) {
  const calls: Call[] = [];
  let subscribed = false, appSub: any = o.existingAppCallback ? { object: "whatsapp_business_account", callback_url: o.existingAppCallback, fields: [{ name: "messages" }], active: true } : null, override = "";
  let pnOverride = o.existingPhoneOverride ?? "";
  const json = (status: number, body: any) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const f = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const auth = (init.headers && init.headers.Authorization) || "";
    const body = init.body || "";
    calls.push({ method, url, auth, body });
    if (u.hostname !== "graph.facebook.com") {
      if (o.handshakeOk === false) return { ok: false, status: 403, text: async () => "Forbidden" };
      return { ok: true, status: 200, text: async () => u.searchParams.get("hub.challenge") };
    }
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    const err = (code: number, msg: string) => json(400, { error: { message: o.leakTokenInErrors ? `${msg} token=${TOKEN} Bearer ${TOKEN} ${APP}|${APP_SECRET} pin=${PIN}` : msg, type: "OAuthException", code, fbtrace_id: "x" } });
    if (path === "/debug_token") {
      return json(200, { data: { app_id: APP, type: "SYSTEM_USER", is_valid: o.valid !== false, expires_at: o.expires ?? 0, data_access_expires_at: 0,
        scopes: o.scopes ?? ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"], granular_scopes: o.granular ?? [] } });
    }
    if (path === `/${WABA}`) return json(200, { id: WABA, name: "Example Test WABA", currency: "USD" });
    if (path === `/${WABA}/phone_numbers`) return json(200, { data: o.phones ?? [{ id: PHONE, display_phone_number: "+1 555 010 4444", verified_name: "Example", status: "CONNECTED", quality_rating: "GREEN" }] });
    if (path === `/${WABA}/subscribed_apps`) {
      if (method === "POST") {
        if (o.subPostFails) return err(100, "Unsupported post request");
        const p = new URLSearchParams(body);
        if (p.get("override_callback_uri")) override = p.get("override_callback_uri")!;
        if (o.subscribeVisible !== false) subscribed = true;
        return json(200, { success: true });
      }
      return json(200, { data: subscribed ? [{ whatsapp_business_api_data: { id: APP, name: "app", ...(override ? { override_callback_uri: override } : {}) } }] : [] });
    }
    if (path === `/${APP}/subscriptions`) {
      if (auth !== `Bearer ${APP}|${APP_SECRET}`) return err(190, "Invalid OAuth access token");
      if (method === "POST") {
        if (o.appSubOk === false) return err(100, "Callback verification failed");
        const p = new URLSearchParams(body);
        appSub = { object: p.get("object"), callback_url: p.get("callback_url"), fields: [{ name: "messages", version: "v21.0" }], active: true };
        return json(200, { success: true });
      }
      return json(200, { data: appSub ? [appSub] : [] });
    }
    if (path === `/${PHONE}/register`) return json(200, { success: true });
    if (path === `/${PHONE}` && u.searchParams.get("fields") === "webhook_configuration") return json(200, { webhook_configuration: { ...(pnOverride ? { phone_number: pnOverride } : {}), ...(appSub ? { application: appSub.callback_url } : {}) } });
    if (path === `/${PHONE}` && method === "POST") { pnOverride = JSON.parse(body).webhook_configuration.override_callback_uri; return json(200, { success: true }); }
    if (path === `/${PHONE}`) return json(200, { id: PHONE, status: "CONNECTED", code_verification_status: "VERIFIED", platform_type: "CLOUD_API" });
    if (path === `/${WABA}/message_templates`) return json(200, { data: [{ name: "hello_world", language: "en_US", status: "APPROVED" }] });
    if (path === `/${PHONE}/messages`) return json(200, { messaging_product: "whatsapp", contacts: [{ wa_id: "15550000001" }], messages: [{ id: "wamid.FAKE" }] });
    return json(404, { error: { message: "unknown path " + path, code: 803 } });
  };
  return { f, calls };
}

async function run(args: string[], o: Opts = {}, env: Record<string, string> = {}) {
  const meta = fakeMeta(o);
  let out = "", err = "";
  const r = await main(args, { env: { META_SYSTEM_USER_TOKEN: TOKEN, ...env }, fetch: meta.f, stdout: (s) => (out += s), stderr: (s) => (err += s), prompter: null, now: () => new Date("2026-10-15T12:00:00Z") });
  return { ...r, out, err, calls: meta.calls, steps: (r.bundle?.steps ?? []) as { id: string; status: string; detail: string }[] };
}
const st = (r: { steps: any[] }, id: string) => r.steps.find((s) => s.id === id)?.status;

test("success: every step PASS, app-level webhook verified, bundle has no secrets", async () => {
  const r = await run(BASE, {}, { META_APP_SECRET: APP_SECRET });
  assert.equal(r.code, 0, r.err);
  for (const id of ["handshake", "debug_token", "scopes", "expiry", "waba", "phones", "subscribe", "webhook_auth", "webhook"]) assert.equal(st(r, id), "PASS", id + "\n" + r.err);
  assert.equal(st(r, "register"), "SKIP");
  assert.equal(st(r, "test_send"), "SKIP");
  assert.equal(r.bundle.webhook.mode, "app");
  assert.equal(r.bundle.subscription.subscribed, true);
  assert.equal(r.bundle.tokenExpires, "never");
  assert.deepEqual(r.bundle.wabaId, WABA);
  assert.equal(r.bundle.phone.displayNumberMasked?.endsWith("4444"), true);
  const bundleText = JSON.stringify(r.bundle);
  for (const secret of [TOKEN, APP_SECRET, VERIFY]) assert.ok(!bundleText.includes(secret) && !r.out.includes(secret));
  assert.ok(JSON.parse(r.out).ok);
  assert.ok(r.err.includes("PASS"));
  // token only ever in the Authorization header, never in a URL or body (apart from debug_token's input_token, which the redactor guards)
  for (const c of r.calls) { assert.ok(!c.body.includes(TOKEN)); if (!c.url.includes("debug_token")) assert.ok(!c.url.includes(TOKEN)); }
  // read-only verification follows every write
  const seq = r.calls.map((c) => c.method + " " + new URL(c.url).pathname.replace(/^\/v[\d.]+/, ""));
  const post = seq.indexOf(`POST /${WABA}/subscribed_apps`);
  assert.equal(seq[post + 1], `GET /${WABA}/subscribed_apps`);
  const post2 = seq.indexOf(`POST /${APP}/subscriptions`);
  assert.equal(seq[post2 + 1], `GET /${APP}/subscriptions`);
});

test("missing scope -> FAIL with the missing scope named, exit 1", async () => {
  const r = await run(BASE, { scopes: ["whatsapp_business_management"] });
  assert.equal(r.code, 1);
  assert.equal(st(r, "scopes"), "FAIL");
  assert.match(r.steps.find((s) => s.id === "scopes")!.detail, /whatsapp_business_messaging/);
});

test("expiring token -> FAIL, or WARN with --allow-expiring; invalid token stops the run", async () => {
  const soon = Math.floor(Date.parse("2026-10-16T00:00:00Z") / 1000);
  const r1 = await run(BASE, { expires: soon });
  assert.equal(st(r1, "expiry"), "FAIL");
  assert.equal(r1.code, 1);
  const r2 = await run([...BASE, "--allow-expiring"], { expires: soon });
  assert.equal(st(r2, "expiry"), "WARN");
  assert.equal(r2.code, 0);
  const r3 = await run(BASE, { valid: false });
  assert.equal(r3.code, 1);
  assert.equal(st(r3, "debug_token"), "FAIL");
  assert.equal(st(r3, "subscribe"), "SKIP");
  assert.ok(!r3.calls.some((c) => c.method === "POST"), "no write after an invalid token");
});

test("wrong WABA scope in granular_scopes -> FAIL", async () => {
  const r = await run(BASE, { granular: [{ scope: "whatsapp_business_management", target_ids: ["999"] }] });
  assert.equal(st(r, "waba_access"), "FAIL");
});

test("phone number id not on the WABA -> FAIL", async () => {
  const r = await run(BASE, { phones: [{ id: "777", display_phone_number: "1" }] });
  assert.equal(st(r, "phones"), "FAIL");
  assert.equal(r.code, 1);
});

test("subscription failure: POST refused, and POST ok but not visible on re-read", async () => {
  const a = await run(BASE, { subPostFails: true });
  assert.equal(st(a, "subscribe"), "FAIL");
  assert.equal(a.code, 1);
  assert.match(a.steps.find((s) => s.id === "subscribe")!.detail, /code 100/);
  const b = await run(BASE, { subscribeVisible: false });
  assert.equal(st(b, "subscribe"), "FAIL");
  assert.equal(b.bundle.subscription.subscribed, false);
});

test("webhook: no app secret -> SKIP + exact dashboard values printed; app-level refusal -> FAIL + fallback", async () => {
  const a = await run(BASE);
  assert.equal(st(a, "webhook"), "SKIP");
  assert.equal(a.bundle.webhook.mode, "manual_needed");
  assert.ok(a.err.includes(`Callback URL : ${URL_}`) && a.err.includes(`Verify token : ${VERIFY}`), "dashboard values printed to the user's terminal");
  assert.ok(!a.out.includes(VERIFY), "but never in the bundle");
  const b = await run(BASE, { appSubOk: false }, { META_APP_SECRET: APP_SECRET });
  assert.equal(st(b, "webhook"), "FAIL");
  assert.equal(b.code, 1);
  assert.equal(b.bundle.webhook.mode, "manual_needed");
  assert.ok(b.err.includes(`Verify token : ${VERIFY}`));
  const c = await run(BASE, {}, { META_APP_SECRET: "wrong-secret-0123456789" });
  assert.equal(st(c, "webhook_auth"), "FAIL");
});

test("--waba-override sets and verifies the WABA-level callback", async () => {
  const r = await run([...BASE, "--waba-override", "--skip-app-subscription"]);
  assert.equal(st(r, "waba_override"), "PASS", r.err);
  assert.equal(r.bundle.webhook.mode, "waba_override");
});

test("one bot per Meta app (default): an app whose callback points to another bot is never touched; the answer is a new Meta app", async () => {
  const FIRST = "https://wab-bot-first.example.workers.dev/api/webhook";
  const r = await run(BASE, { existingAppCallback: FIRST }, { META_APP_SECRET: APP_SECRET });
  assert.equal(st(r, "webhook_app_level"), "FAIL", r.err);
  assert.equal(r.code, 1);
  assert.equal(r.bundle.webhook.mode, "new_app_required");
  assert.equal(r.bundle.newAppRequired.currentHost, "wab-bot-first.example.workers.dev");
  assert.ok(r.bundle.newAppRequired.steps.length >= 3);
  assert.ok(r.err.includes("NEW META APP REQUIRED"), "clear instruction printed");
  assert.ok(!r.err.includes("MANUAL FALLBACK"), "never tells the owner to type this callback into the shared app's dashboard");
  assert.equal(r.calls.filter((c) => c.method === "POST" && /\/subscriptions$/.test(c.url)).length, 0, "no app-level POST");
  assert.equal(r.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/${PHONE}`)).length, 0, "no per-number override by default");
  assert.equal(st(r, "phone_override"), undefined);
  assert.equal(st(r, "subscribe"), "SKIP");
  assert.equal(r.calls.filter((c) => c.method === "POST").length, 0, "nothing written at Meta at all");
  // seen through the number's own view even without the app secret; the other bot's token is never written or pushed
  const n = await run([...BASE, "--write-secrets", "/nonexistent/x.env"], { existingAppCallback: FIRST });
  assert.equal(st(n, "webhook_app_level"), "FAIL");
  assert.equal(st(n, "secrets_file"), "SKIP");
  assert.equal(n.bundle.secrets.writtenTo, null);
});

test("explicit --phone-override (fallback: one bot, several numbers on a shared app): only this number is routed here", async () => {
  const FIRST = "https://wab-bot-first.example.workers.dev/api/webhook";
  const r = await run([...BASE, "--phone-override"], { existingAppCallback: FIRST }, { META_APP_SECRET: APP_SECRET });
  assert.equal(st(r, "phone_override"), "PASS", r.err);
  assert.equal(r.bundle.webhook.mode, "phone_override");
  assert.equal(r.calls.filter((c) => c.method === "POST" && /\/subscriptions$/.test(c.url)).length, 0, "no app-level POST");
  const post = r.calls.find((c) => c.method === "POST" && c.url.endsWith(`/${PHONE}`))!;
  assert.equal(JSON.parse(post.body).webhook_configuration.override_callback_uri, URL_);
  // number already routed to a third deployment: refused
  const t = await run([...BASE, "--phone-override"], { existingAppCallback: FIRST, existingPhoneOverride: "https://third.example.test/api/webhook" }, { META_APP_SECRET: APP_SECRET });
  assert.equal(st(t, "phone_override"), "FAIL");
  assert.equal(t.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/${PHONE}`)).length, 0);
  // explicit --replace-webhook moves the app level, reported as WARN
  const x = await run([...BASE, "--replace-webhook"], { existingAppCallback: FIRST }, { META_APP_SECRET: APP_SECRET });
  assert.equal(st(x, "webhook"), "WARN");
  assert.equal(x.bundle.webhook.mode, "app");
});

test("handshake FAIL when the bridge rejects the verify token", async () => {
  const r = await run(BASE, { handshakeOk: false });
  assert.equal(st(r, "handshake"), "FAIL");
  assert.equal(r.code, 1);
});

test("redaction: token, app secret, PIN and verify token never reach stdout/stderr/bundle even when Graph echoes them", async () => {
  const r = await run([...BASE, "--register", "--yes", "--test-to", "+15550000001"], { leakTokenInErrors: true, subPostFails: true }, { META_APP_SECRET: APP_SECRET, META_REGISTER_PIN: PIN });
  const hay = r.out + r.err + JSON.stringify(r.bundle);
  assert.ok(!hay.includes(TOKEN), "token leaked");
  assert.ok(!hay.includes(APP_SECRET), "app secret leaked");
  assert.ok(!hay.includes(PIN), "pin leaked");
  assert.ok(!r.out.includes(VERIFY));
  assert.ok(hay.includes("[REDACTED"), "something was actually redacted");
  const rd = new Redactor(); rd.add("hunter2-secret");
  assert.equal(rd.redact("x hunter2-secret y access_token=abc123 Bearer abcdefghijklmnop1234 EAAbcdefghijklmnopqrstuv"), "x [REDACTED] y access_token=[REDACTED] Bearer [REDACTED] [REDACTED_TOKEN]");
});

test("secrets are refused as arguments", async () => {
  for (const flag of ["--token", "--app-secret", "--pin", "--access-token"]) {
    const p = parseArgs([flag, "EAAnotreallyatoken1234567890"]);
    assert.ok(p.errors.length >= 1 && /never passed as arguments/.test(p.errors[0]));
    assert.ok(!p.errors.join(" ").includes("EAAnotreally"));
  }
  const r = await run(["--token", TOKEN, ...BASE]);
  assert.equal(r.code, 2);
  assert.ok(!r.err.includes(TOKEN));
  assert.equal(r.calls.length, 0);
});

test("--register needs a PIN and confirmation; PIN goes in the JSON body only; verified by GET", async () => {
  const noPin = await run([...BASE, "--register", "--yes"]);
  assert.equal(st(noPin, "register"), "FAIL");
  assert.ok(!noPin.calls.some((c) => c.url.endsWith("/register")));
  const ok = await run([...BASE, "--register", "--yes"], {}, { META_REGISTER_PIN: PIN });
  assert.equal(st(ok, "register"), "PASS");
  const reg = ok.calls.find((c) => c.url.endsWith("/register"))!;
  assert.deepEqual(JSON.parse(reg.body), { messaging_product: "whatsapp", pin: PIN });
  assert.ok(!reg.url.includes(PIN));
  assert.equal(ok.calls[ok.calls.indexOf(reg) + 1].url.includes(`/${PHONE}?`), true);
});

test("--test-to sends one template to that recipient only, after checking it is APPROVED", async () => {
  const r = await run([...BASE, "--test-to", "+15550000001", "--yes"]);
  assert.equal(st(r, "test_template"), "PASS");
  assert.equal(st(r, "test_send"), "PASS");
  const sends = r.calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));
  assert.equal(sends.length, 1);
  const body = JSON.parse(sends[0].body);
  assert.equal(body.to, "15550000001");
  assert.equal(body.template.name, "hello_world");
  assert.ok(!JSON.stringify(r.bundle).includes("15550000001"), "recipient is masked in the bundle");
  const none = await run(BASE);
  assert.ok(!none.calls.some((c) => c.url.endsWith("/messages")), "no send without --test-to");
  const bad = await run([...BASE, "--test-to", "abc"]);
  assert.equal(bad.code, 2);
});

test("--write-secrets writes a 0600 file (no overwrite without --force); contents never printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-setup-"));
  const file = join(dir, "secrets.env");
  const r = await run([...BASE, "--write-secrets", file], {}, { META_APP_SECRET: APP_SECRET });
  assert.equal(r.code, 0, r.err);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const txt = readFileSync(file, "utf8");
  assert.ok(txt.includes(`WA_ACCESS_TOKEN=${TOKEN}`) && txt.includes(`WA_APP_SECRET=${APP_SECRET}`));
  assert.equal(st(r, "secrets_file"), "PASS");
  assert.ok(!(r.out + r.err).includes(TOKEN));
  assert.throws(() => writeSecretsFile(file, { A: "b" }), /already exists/);
  assert.ok(existsSync(file));
});

test("--push-cloudflare passes values via stdin only, never argv", async () => {
  const seen: { args: string[]; input: string }[] = [];
  const meta = fakeMeta();
  let err = "";
  const r = await main([...BASE, "--push-cloudflare"], {
    env: { META_SYSTEM_USER_TOKEN: TOKEN, META_APP_SECRET: APP_SECRET }, fetch: meta.f, stdout: () => {}, stderr: (s) => (err += s), prompter: null,
    spawn: (_c: string, args: string[], opts: any) => { seen.push({ args, input: opts.input }); return { status: 0 }; },
  });
  assert.equal(r.code, 0, err);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.input).sort(), [APP_SECRET, TOKEN].sort());
  for (const s of seen) { assert.ok(!s.args.join(" ").includes(TOKEN) && !s.args.join(" ").includes(APP_SECRET)); assert.ok(s.args.includes("secret") && s.args.includes("put")); }
  assert.ok(!err.includes(TOKEN));
});
