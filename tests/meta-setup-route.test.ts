import test from "node:test";
import assert from "node:assert/strict";
import { FakeMeta, DRY_RUN_TOKEN, type FakeMetaOpts } from "../lib/meta-fake";
import { handleVerify } from "../lib/webhook";
import { metaSetupGet, metaSetupPost, TIME_BUDGET_MS } from "../lib/meta-setup";
import { Redactor } from "../lib/redact";
import { ADMIN_TOKEN, T0, VERIFY_TOKEN, makeHarness } from "./helpers";

// All values are fake, test-only strings. Meta is always a FakeMeta (mocked fetch); nothing here touches the network.
const BOOT = "EAAFAKEbootstrapUSERtoken0123456789abcdef";
const SECRET = "fakeappsecret0123456789abcdef0123";
const SYS = "EAAFAKEsystemUSERtokenMINTED0123456789zz";
const OTP = "482915";
const PIN = "135790";
const URL_ = "https://bridge.example.test/api/admin/meta-setup";
const ALL = ["business_management", "whatsapp_business_management", "whatsapp_business_messaging"];
const exp = T0 / 1000 + 7200;

function setup(env: Record<string, string | undefined> = {}, o: FakeMetaOpts = {}, tokenScopes = ALL) {
  const h = makeHarness({ LAUNCH_MODE: "test", ...env });
  const fm = new FakeMeta({
    appSecret: SECRET, mintedToken: SYS, otp: OTP,
    handshake: (cb, vt) => { const u = new URL(cb); u.searchParams.set("hub.mode", "subscribe"); u.searchParams.set("hub.verify_token", vt); u.searchParams.set("hub.challenge", "c"); return handleVerify(h.ctx, u).status === 200; },
    ...o,
    tokens: { [BOOT]: { type: "USER", scopes: tokenScopes, expiresAt: exp }, ...(o.tokens ?? {}) },
  });
  h.ctx.fetch = fm.fetch;
  const call = async (body: unknown, token: string | null = ADMIN_TOKEN, url = URL_) => {
    const res = await metaSetupPost(h.ctx, new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as any, headers: res.headers };
  };
  return { h, fm, call };
}
const step = (j: any, id: string) => j.results.find((r: any) => r.id === id);
const statuses = (j: any) => Object.fromEntries(j.results.map((r: any) => [r.id, r.status]));
const FULL = { steps: ["businesses", "waba", "system_user", "subscribed_apps", "webhook"], bootstrap_token: BOOT, app_secret: SECRET };

test("auth: 401 without / with wrong admin token; GET status needs auth and makes no Meta call", async () => {
  const { h, fm, call } = setup();
  assert.equal((await call({ bootstrap_token: BOOT }, null)).status, 401);
  assert.equal((await call({ bootstrap_token: BOOT }, "wrong-admin-token-0000")).status, 401);
  const noAuth = await metaSetupGet(h.ctx, new Request(URL_));
  assert.equal(noAuth.status, 401);
  const ok = await metaSetupGet(h.ctx, new Request(URL_, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }));
  assert.equal(ok.status, 200);
  const j: any = await ok.json();
  assert.equal(j.dry_run, false);
  assert.equal(j.env_present.WA_ACCESS_TOKEN, true);
  assert.equal(fm.calls.length, 0);
  assert.ok(!JSON.stringify(j).includes("test-access-token"));
});

test("unauthorized requests never reach Meta even with a valid bootstrap token", async () => {
  const { fm, call } = setup();
  await call({ ...FULL }, null);
  assert.equal(fm.calls.length, 0);
});

test("bad requests: unknown field, bad formats, secrets in the URL, missing token, mint without return_token (no echo of values)", async () => {
  const { fm, call } = setup({ WA_ACCESS_TOKEN: undefined });
  for (const body of [
    { bootstrap_token: BOOT, bootstrap_tokens: "typo" },
    { bootstrap_token: "short" },
    { bootstrap_token: BOOT, steps: ["nope"] },
    { bootstrap_token: BOOT, action: "drop_tables" },
    { bootstrap_token: BOOT, business_id: "abc" },
    { bootstrap_token: BOOT, code: "12" },
    { bootstrap_token: BOOT, pin: "12345" },
    { bootstrap_token: BOOT, steps: ["system_user"], mint_token: true },
    { bootstrap_token: BOOT, steps: ["waba"], mint_token: true, return_token: true },
    { bootstrap_token: BOOT, webhook_fields: ["everything"] },
    { bootstrap_token: BOOT, create_business: { name: "x" } },
    { bootstrap_token: BOOT, confirm: "yes" },
  ]) {
    const r = await call(body);
    assert.equal(r.status, 400, JSON.stringify(Object.keys(body)));
    assert.ok(!r.text.includes(BOOT));
  }
  assert.equal((await call("not json")).status, 400);
  assert.equal((await call({ steps: ["waba"] })).status, 400); // no token anywhere
  assert.equal((await call({ steps: ["waba"], bootstrap_token: BOOT }, ADMIN_TOKEN, URL_ + "?bootstrap_token=" + BOOT)).status, 400);
  assert.equal((await call("x".repeat(30000))).status, 413);
  assert.equal(fm.calls.length, 0);
});

test("falls back to WA_ACCESS_TOKEN of the deployment when no bootstrap token is sent (token_source env)", async () => {
  const { call } = setup({ WA_ACCESS_TOKEN: BOOT });
  const r = await call({ steps: ["businesses"] });
  assert.equal(r.status, 200);
  assert.equal(r.json.token_source, "env");
  assert.equal(step(r.json, "preflight").status, "PASS");
});

test("full happy run: every step PASS with read-back, token minted + verified, delivered once, secrets never echoed/logged/stored", async () => {
  const { h, fm, call } = setup({ WA_ACCESS_TOKEN: undefined, WA_APP_SECRET: "placeholder-secret-not-used-0000" }, {});
  h.doc.resetOps();
  const r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.ok, true, r.text);
  assert.deepEqual(statuses(j), {
    preflight: "PASS", businesses: "PASS", waba: "PASS", system_user_create: "PASS", system_user_install_app: "PASS", system_user_assign_waba: "PASS",
    system_user_token: "PASS", subscribed_apps: "PASS", webhook_handshake_local: "PASS", webhook: "PASS",
  });
  assert.equal(j.ids.business_id, fm.businessId);
  assert.equal(j.ids.waba_id, fm.wabaId);
  assert.equal(j.ids.app_id, fm.appId);
  assert.equal(step(j, "system_user_token").facts.expires, "never");
  assert.equal(step(j, "webhook").facts.mode, "app");
  assert.equal(fm.appSub?.callback_url, "https://bridge.example.test/api/webhook");
  assert.deepEqual(fm.subscribedApps, [fm.appId]);
  // secret delivery: exactly once, only in secret_delivery
  assert.equal(j.secret_delivery.values.WA_ACCESS_TOKEN, SYS);
  assert.equal(r.text.split(SYS).length - 1, 1);
  assert.ok(!r.text.includes(BOOT));
  assert.ok(!r.text.includes(SECRET));
  assert.equal(r.headers.get("cache-control"), "no-store");
  // nothing logged, nothing stored
  assert.ok(!JSON.stringify(h.logs).includes(BOOT) && !JSON.stringify(h.logs).includes(SYS) && !JSON.stringify(h.logs).includes(SECRET));
  assert.deepEqual(h.doc.ops, { read: 0, write: 0 });
  // Meta only saw the bootstrap token as bearer (+ the minted token for its own verification)
  const bearers = new Set(fm.calls.map((c) => c.token));
  assert.ok(bearers.has(BOOT) && bearers.has(SYS));
  assert.ok(fm.calls.every((c) => c.method === "GET" || c.method === "POST"));
});

test("a re-run is idempotent: no duplicate creates/installs/assigns/subscriptions, mint skipped when the deployment already has a good token", async () => {
  const { h, fm, call } = setup({ WA_ACCESS_TOKEN: undefined });
  await call({ ...FULL, mint_token: true, return_token: true });
  const writes = fm.calls.filter((c) => c.method === "POST").length;
  // second run: the deployment now has the minted token as WA_ACCESS_TOKEN
  h.ctx.cfg.waAccessToken = SYS;
  const r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(fm.calls.filter((c) => c.method === "POST").length, writes, "no write on a repeat run");
  assert.equal(fm.systemUsers.length, 1);
  assert.equal(step(r.json, "system_user_create").facts.created, false);
  assert.equal(step(r.json, "system_user_token").facts.already_present, true);
  assert.equal(r.json.secret_delivery, undefined);
  assert.equal(step(r.json, "webhook").facts.changed, false);
  assert.ok(!r.text.includes(SYS));
});

test("force_mint mints another token even when the deployment has a good one", async () => {
  const { h, fm, call } = setup({ WA_ACCESS_TOKEN: undefined });
  await call({ ...FULL, mint_token: true, return_token: true });
  h.ctx.cfg.waAccessToken = SYS;
  const r = await call({ ...FULL, mint_token: true, return_token: true, force_mint: true });
  assert.equal(fm.post(/access_tokens/).length, 2);
  assert.equal(r.json.secret_delivery.values.WA_ACCESS_TOKEN, SYS);
});

test("invalid token: preflight FAIL, every other step SKIPPED, exactly one Meta call, nothing else touched", async () => {
  const { fm, call } = setup();
  const r = await call({ ...FULL, bootstrap_token: "EAAnotAknownTOKEN0123456789abcdefgh" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(step(r.json, "preflight").status, "FAIL");
  assert.match(step(r.json, "preflight").detail, /190/);
  for (const id of FULL.steps) assert.equal(step(r.json, id).status, "SKIP");
  assert.equal(fm.calls.length, 1);
  assert.equal(fm.calls[0]!.path, "/debug_token");
  assert.ok(!r.text.includes("notAknown"));
});

test("expired/revoked token (is_valid false) fails safely", async () => {
  const { fm, call } = setup({}, { tokens: { EAAexpiredTOKEN0123456789abcdefghij: { type: "USER", scopes: ALL, expiresAt: exp, valid: false } } });
  const r = await call({ ...FULL, bootstrap_token: "EAAexpiredTOKEN0123456789abcdefghij" });
  assert.equal(r.json.ok, false);
  assert.equal(step(r.json, "preflight").status, "FAIL");
  assert.ok(fm.calls.length <= 1);
});

test("scope failures: missing business_management fails only the steps that need it, with no Meta call for them", async () => {
  const { fm, call } = setup({}, {}, ["whatsapp_business_management", "whatsapp_business_messaging"]);
  const r = await call({ ...FULL, continue_on_fail: true });
  assert.equal(step(r.json, "preflight").status, "FAIL");
  assert.match(step(r.json, "preflight").detail, /business_management/);
  assert.equal(step(r.json, "businesses").status, "FAIL");
  assert.match(step(r.json, "businesses").detail, /scope_missing/);
  assert.equal(step(r.json, "system_user").status, "FAIL");
  assert.ok(!fm.calls.some((c) => c.path === "/me/businesses" || /system_users/.test(c.path)));
  // WhatsApp-only steps still run when the caller names the ids
  const r2 = await call({ steps: ["waba", "subscribed_apps"], bootstrap_token: BOOT, waba_id: fm.wabaId, continue_on_fail: true }, ADMIN_TOKEN);
  assert.equal(step(r2.json, "waba").status, "PASS");
});

test("without continue_on_fail a failed step blocks the rest (SKIP blocked by ...)", async () => {
  const { call } = setup({}, {}, ["whatsapp_business_management"]);
  const r = await call({ ...FULL });
  assert.equal(step(r.json, "businesses").status, "FAIL");
  assert.equal(step(r.json, "waba").status, "SKIP");
  assert.match(step(r.json, "waba").detail, /blocked by businesses/);
});

test("token scoped to a specific WABA (granular scopes) other than the one asked for: waba step FAILs", async () => {
  const h = setup();
  // custom debug_token response with granular scopes
  const orig = h.fm.fetch;
  h.h.ctx.fetch = async (i, init) => {
    const res = await orig(i, init);
    if (String(i).includes("/debug_token")) { const b: any = await res.json(); b.data.granular_scopes = [{ scope: "whatsapp_business_management", target_ids: ["111111111111"] }]; return Response.json(b); }
    return res;
  };
  const r = await h.call({ steps: ["waba"], bootstrap_token: BOOT, waba_id: h.fm.wabaId });
  assert.equal(step(r.json, "waba").status, "FAIL");
  assert.match(step(r.json, "waba").detail, /other WABA/);
});

test("business discovery: none -> FAIL with guidance and NO create; create only when explicit; create is idempotent; several -> FAIL with candidates; given id verified", async () => {
  const none = setup({}, { noBusiness: true });
  let r = await none.call({ steps: ["businesses"], bootstrap_token: BOOT });
  assert.equal(step(r.json, "businesses").status, "FAIL");
  assert.equal(none.fm.post(/businesses/).length, 0);
  r = await none.call({ steps: ["businesses"], bootstrap_token: BOOT, create_business: { name: "Acme Dental", email: "owner@example.test" } });
  assert.equal(step(r.json, "businesses").status, "PASS");
  assert.equal(step(r.json, "businesses").facts.created, true);
  assert.equal(none.fm.post(/businesses/).length, 1);
  r = await none.call({ steps: ["businesses"], bootstrap_token: BOOT, create_business: { name: "acme dental" } });
  assert.equal(step(r.json, "businesses").facts.created, false);
  assert.equal(none.fm.post(/businesses/).length, 1, "same name never creates twice");
  assert.ok(!r.text.includes("owner@example.test"));

  const many = setup({}, { businessCount: 2 });
  r = await many.call({ steps: ["businesses"], bootstrap_token: BOOT });
  assert.equal(step(r.json, "businesses").status, "FAIL");
  assert.equal(step(r.json, "businesses").facts.businesses.length, 2);
  r = await many.call({ steps: ["businesses"], bootstrap_token: BOOT, business_id: many.fm.businesses[1]!.id });
  assert.equal(step(r.json, "businesses").status, "PASS");
  r = await many.call({ steps: ["businesses"], bootstrap_token: BOOT, business_id: "123456789012" });
  assert.equal(step(r.json, "businesses").status, "FAIL");
});

test("WABA discovery: none / several / unknown phone id / lists masked numbers and selects the only one", async () => {
  const s = setup({}, { noBusiness: false, wabaCount: 0, phones: [] });
  let r = await s.call({ steps: ["businesses", "waba"], bootstrap_token: BOOT });
  assert.equal(step(r.json, "waba").status, "FAIL");
  const two = setup({}, { wabaCount: 2 });
  r = await two.call({ steps: ["businesses", "waba"], bootstrap_token: BOOT });
  assert.equal(step(r.json, "waba").status, "FAIL");
  const ok = setup({}, { phones: [{}] });
  r = await ok.call({ steps: ["businesses", "waba"], bootstrap_token: BOOT });
  const w = step(r.json, "waba");
  assert.equal(w.status, "PASS");
  assert.equal(w.facts.phones.length, 1);
  assert.match(w.facts.phones[0].display_number_masked, /^\*+4444$/);
  assert.equal(r.json.ids.phone_number_id, ok.fm.phones[0]!.id);
  assert.equal(w.facts.env_WA_PHONE_NUMBER_IDS_includes_selected, false);
  r = await ok.call({ steps: ["waba"], bootstrap_token: BOOT, waba_id: ok.fm.wabaId, phone_number_id: "999999999999" });
  assert.equal(step(r.json, "waba").status, "FAIL");
});

test("partial failure then resume: failed install_app blocks the chain, the re-run does not recreate the system user and finishes", async () => {
  const { fm, call } = setup({ WA_ACCESS_TOKEN: undefined }, { failures: [{ match: /^POST \/\d+\/applications$/, times: 1, code: 100, message: "temporary" }] });
  let r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(r.json.ok, false);
  assert.equal(step(r.json, "system_user_create").status, "PASS");
  assert.equal(step(r.json, "system_user_install_app").status, "FAIL");
  assert.equal(step(r.json, "system_user_assign_waba"), undefined);
  assert.equal(step(r.json, "subscribed_apps").status, "SKIP");
  assert.equal(r.json.secret_delivery, undefined, "nothing minted yet");
  r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(fm.post(/system_users$/).length, 1);
  assert.equal(step(r.json, "system_user_create").facts.created, false);
  assert.equal(r.json.secret_delivery.values.WA_ACCESS_TOKEN, SYS);
});

test("install-app read-back edge unavailable -> WARN (token step proves it); token mint falls back to the second edge", async () => {
  const { fm, call } = setup({ WA_ACCESS_TOKEN: undefined }, { installReadable: false, mintViaSuEdge: false });
  const r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(step(r.json, "system_user_install_app").status, "WARN");
  assert.equal(step(r.json, "system_user_token").status, "PASS");
  assert.equal(step(r.json, "system_user_token").facts.edge, "business/system_user_access_tokens");
  assert.equal(r.json.ok, true);
  assert.equal(fm.post(/system_user_access_tokens$/).length, 1);
});

test("mint verification failure (token expires / lacks scopes): FAIL, still delivered once for revocation, flagged do-not-use", async () => {
  const { call } = setup({ WA_ACCESS_TOKEN: undefined }, { mintedScopes: ["business_management"], mintedExpiresAt: exp });
  const r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(step(r.json, "system_user_token").status, "FAIL");
  assert.match(step(r.json, "system_user_token").detail, /do NOT use/);
  assert.equal(r.json.secret_delivery.values.WA_ACCESS_TOKEN, SYS);
});

test("mint refused by Meta -> FAIL with the dashboard fallback; no token delivered", async () => {
  const { call } = setup({ WA_ACCESS_TOKEN: undefined }, { failures: [{ match: /access_tokens$/, code: 200, status: 403, message: "(#200) not allowed" }] });
  const r = await call({ ...FULL, mint_token: true, return_token: true });
  assert.equal(step(r.json, "system_user_token").status, "FAIL");
  assert.match(step(r.json, "system_user_token").detail, /Business Settings/);
  assert.equal(r.json.secret_delivery, undefined);
});

test("system_user without mint_token: SKIP on the token step (nothing minted by accident)", async () => {
  const { fm, call } = setup();
  const r = await call({ ...FULL });
  assert.equal(step(r.json, "system_user_token").status, "SKIP");
  assert.equal(fm.post(/access_tokens/).length, 0);
});

test("phone lifecycle: add (idempotent) -> request_code -> wrong OTP FAIL -> right OTP PASS -> register with PIN; OTP/PIN never echoed or logged; rerun skips", async () => {
  const { h, fm, call } = setup({}, { phones: [] });
  const base = { bootstrap_token: BOOT, waba_id: fm.wabaId };
  let r = await call({ ...base, steps: ["phone_add"], phone: { cc: "1", phone_number: "5550100123", verified_name: "Acme Dental" } });
  assert.equal(step(r.json, "phone_add").status, "PASS");
  const pid = r.json.ids.phone_number_id;
  assert.ok(pid);
  r = await call({ ...base, steps: ["phone_add"], phone: { cc: "1", phone_number: "5550100123", verified_name: "Acme Dental" } });
  assert.equal(step(r.json, "phone_add").facts.added, false);
  assert.equal(fm.post(/\/phone_numbers$/).length, 1);

  r = await call({ ...base, phone_number_id: pid, steps: ["phone_request_code"], code_method: "SMS" });
  assert.equal(step(r.json, "phone_request_code").status, "PASS");
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_verify_code"] });
  assert.equal(step(r.json, "phone_verify_code").status, "FAIL"); // no code given
  assert.equal(fm.post(/verify_code/).length, 0);
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_verify_code"], code: "000000" });
  assert.equal(step(r.json, "phone_verify_code").status, "FAIL");
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_register"], pin: PIN });
  assert.equal(step(r.json, "phone_register").status, "FAIL", "register before verify makes no call");
  assert.match(step(r.json, "phone_register").detail, /not_verified/);
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_verify_code"], code: `${OTP.slice(0, 3)}-${OTP.slice(3)}` });
  assert.equal(step(r.json, "phone_verify_code").status, "PASS");
  assert.ok(!r.text.includes(OTP));
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_verify_code"], code: OTP });
  assert.equal(step(r.json, "phone_verify_code").status, "SKIP");
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_register"], pin: PIN });
  assert.equal(step(r.json, "phone_register").status, "PASS");
  assert.equal(step(r.json, "phone_register").facts.status, "CONNECTED");
  assert.ok(!r.text.includes(PIN));
  assert.equal(r.json.secret_delivery, undefined);
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_register"], pin: PIN });
  assert.equal(step(r.json, "phone_register").status, "SKIP");
  assert.equal(fm.post(/\/register$/).length, 1);
  r = await call({ ...base, phone_number_id: pid, steps: ["phone_request_code"] });
  assert.equal(step(r.json, "phone_request_code").status, "SKIP");
  const all = JSON.stringify(h.logs);
  assert.ok(!all.includes(OTP) && !all.includes(PIN) && !all.includes(BOOT));
});

test("register: generate_pin returns the PIN once in secret_delivery; missing PIN fails without a call; wrong format is a 400", async () => {
  const { fm, call } = setup({}, { phones: [{ status: "PENDING", platform_type: "NOT_APPLICABLE" }] });
  const pid = fm.phones[0]!.id;
  const base = { bootstrap_token: BOOT, waba_id: fm.wabaId, phone_number_id: pid, steps: ["phone_register"] };
  let r = await call(base);
  assert.equal(step(r.json, "phone_register").status, "FAIL");
  assert.equal(fm.post(/register/).length, 0);
  r = await call({ ...base, generate_pin: true });
  assert.equal(step(r.json, "phone_register").status, "PASS");
  const pin = r.json.secret_delivery.values.REGISTRATION_PIN;
  assert.match(pin, /^\d{6}$/);
  assert.equal(r.text.split(`"${pin}"`).length - 1, 1);
  assert.equal(fm.phones[0]!.pin, pin);
});

test("request_code is rate-guarded (3 per number per hour from this deployment)", async () => {
  const { fm, call } = setup({}, { phones: [{ code_verification_status: "NOT_VERIFIED", status: "PENDING" }] });
  const body = { bootstrap_token: BOOT, waba_id: fm.wabaId, phone_number_id: fm.phones[0]!.id, steps: ["phone_request_code"] };
  for (let i = 0; i < 3; i++) assert.equal(step((await call(body)).json, "phone_request_code").status, "PASS");
  const r = await call(body);
  assert.equal(step(r.json, "phone_request_code").status, "FAIL");
  assert.match(step(r.json, "phone_request_code").detail, /rate_guard/);
  assert.equal(fm.post(/request_code/).length, 3);
});

test("Meta test number path: numbers already CONNECTED/VERIFIED -> add/verify/register are skipped, no writes, no OTP", async () => {
  const { fm, call } = setup({}, { phones: [{}] });
  const r = await call({ bootstrap_token: BOOT, steps: ["businesses", "waba", "phone_request_code", "phone_verify_code", "phone_register"] });
  assert.deepEqual(statuses(r.json), { preflight: "PASS", businesses: "PASS", waba: "PASS", phone_request_code: "SKIP", phone_verify_code: "SKIP", phone_register: "SKIP" });
  assert.equal(fm.calls.filter((c) => c.method === "POST").length, 0);
});

test("subscribed_apps: subscribes once, read-back verified, then skips", async () => {
  const { fm, call } = setup();
  const body = { bootstrap_token: BOOT, waba_id: fm.wabaId, steps: ["subscribed_apps"] };
  let r = await call(body);
  assert.equal(step(r.json, "subscribed_apps").facts.changed, true);
  r = await call(body);
  assert.equal(step(r.json, "subscribed_apps").facts.changed, false);
  assert.equal(fm.post(/subscribed_apps/).length, 1);
});

test("subscribe POST accepted but not visible -> FAIL", async () => {
  const s2 = setup();
  const o2 = s2.fm.fetch;
  let posted = false;
  s2.h.ctx.fetch = async (i, init) => {
    const res = await o2(i, init);
    const post = (init?.method ?? "GET") === "POST";
    if (String(i).includes("subscribed_apps")) { if (post) posted = true; else if (posted) return Response.json({ data: [] }); }
    return res;
  };
  const r = await s2.call({ bootstrap_token: BOOT, waba_id: s2.fm.wabaId, steps: ["subscribed_apps"] });
  assert.equal(step(r.json, "subscribed_apps").status, "FAIL");
});

test("webhook: app-level set + read back through Meta's handshake against this deployment; fallback prints dashboard values when refused / no secret / wrong verify token", async () => {
  // refused by Meta -> WARN + manual values
  const refused = setup({}, { appWebhookSupported: false });
  let r = await refused.call({ bootstrap_token: BOOT, steps: ["webhook"], app_secret: SECRET });
  assert.equal(step(r.json, "webhook").status, "WARN");
  assert.deepEqual(r.json.manual.subscribe_to_fields, ["messages"]);
  assert.equal(r.json.manual.callback_url, "https://bridge.example.test/api/webhook");
  assert.equal(r.json.manual.verify_token, VERIFY_TOKEN);
  assert.ok(!r.text.includes(SECRET));
  assert.equal(r.json.ok, true, "WARN is not a failure");

  // no app secret anywhere -> manual
  const nosec = setup({ WA_APP_SECRET: undefined });
  r = await nosec.call({ bootstrap_token: BOOT, steps: ["webhook"] });
  assert.equal(step(r.json, "webhook").status, "WARN");
  assert.ok(r.json.manual);
  assert.equal(nosec.fm.calls.filter((c) => /subscriptions/.test(c.path)).length, 0);

  // wrong app secret -> manual
  const wrong = setup();
  r = await wrong.call({ bootstrap_token: BOOT, steps: ["webhook"], app_secret: "wrongsecretwrongsecret0123456789" });
  assert.equal(step(r.json, "webhook").status, "WARN");
  assert.ok(!r.text.includes("wrongsecretwrong"));

  // verify token missing on the deployment -> FAIL (handshake would fail)
  const nov = setup({ WA_VERIFY_TOKEN: undefined });
  r = await nov.call({ bootstrap_token: BOOT, steps: ["webhook"], app_secret: SECRET });
  assert.equal(step(r.json, "webhook_handshake_local").status, "FAIL");
  assert.equal(nov.fm.calls.filter((c) => /subscriptions/.test(c.path)).length, 0);

  // Meta's live handshake fails (callback unreachable) -> WARN + manual
  const hs = setup({}, { handshake: () => false });
  r = await hs.call({ bootstrap_token: BOOT, steps: ["webhook"], app_secret: SECRET });
  assert.equal(step(r.json, "webhook").status, "WARN");
  assert.match(step(r.json, "webhook").detail, /2200|verif/i);

  // bad webhook_url
  const bad = setup();
  r = await bad.call({ bootstrap_token: BOOT, steps: ["webhook"], app_secret: SECRET, webhook_url: "https://example.test/other" });
  assert.equal(step(r.json, "webhook_handshake_local").status, "FAIL");
});

test("webhook: waba_override opt-in is verified by read-back; custom fields; idempotent", async () => {
  const { fm, call } = setup();
  const body = { bootstrap_token: BOOT, waba_id: fm.wabaId, steps: ["webhook"], app_secret: SECRET, webhook_fields: ["messages", "message_template_status_update"] };
  let r = await call(body);
  assert.equal(step(r.json, "webhook").status, "PASS");
  assert.deepEqual(fm.appSub?.fields, ["messages", "message_template_status_update"]);
  r = await call(body);
  assert.equal(step(r.json, "webhook").facts.changed, false);
  assert.equal(fm.post(/\/subscriptions$/).length, 1);
  r = await call({ ...body, waba_override: true });
  assert.equal(step(r.json, "waba_override").status, "FAIL"); // fake does not model override_callback_uri: must not be reported as success
});

test("templates: submits once, read-back, WARN when not allowlisted, FAIL surfaces Meta error; validation 400", async () => {
  const { fm, call } = setup({ WA_TEMPLATE_ALLOWLIST: "appointment_reminder" });
  const tpl = (name: string) => ({ name, category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "Hello {{1}}" }] });
  const body = { bootstrap_token: BOOT, waba_id: fm.wabaId, steps: ["templates"], templates: [tpl("appointment_reminder"), tpl("other_one")] };
  let r = await call(body);
  assert.equal(step(r.json, "templates").status, "WARN");
  assert.match(step(r.json, "templates").detail, /other_one/);
  assert.equal(fm.templates.length, 2);
  r = await call(body);
  assert.equal(fm.post(/message_templates/).length, 2, "no resubmission");
  assert.equal(step(r.json, "templates").facts.templates[0].result, "exists");
  const bad = setup({}, { failures: [{ match: /POST .*message_templates/, message: "Invalid template" }] });
  r = await bad.call({ ...body, waba_id: bad.fm.wabaId });
  assert.equal(step(r.json, "templates").status, "FAIL");
  assert.equal((await call({ ...body, templates: [{ name: "Bad Name", category: "UTILITY", language: "en_US", components: [{}] }] })).status, 400);
  r = await call({ bootstrap_token: BOOT, waba_id: fm.wabaId, steps: ["templates"] });
  assert.equal(step(r.json, "templates").status, "SKIP");
});

test("display name: submit, read back, idempotent, SKIP when already verified", async () => {
  const { fm, call } = setup({}, { phones: [{ verified_name: "Old Name" }] });
  const body = { bootstrap_token: BOOT, waba_id: fm.wabaId, phone_number_id: fm.phones[0]!.id, steps: ["display_name"], new_display_name: "New Business Name" };
  let r = await call(body);
  assert.equal(step(r.json, "display_name").status, "PASS");
  r = await call(body);
  assert.equal(step(r.json, "display_name").status, "PASS");
  assert.equal(fm.calls.filter((c) => c.method === "POST" && c.form.new_display_name).length, 1);
  r = await call({ ...body, new_display_name: "Old Name" });
  assert.equal(step(r.json, "display_name").status, "SKIP");
  r = await call({ ...body, new_display_name: undefined });
  assert.equal(step(r.json, "display_name").status, "FAIL");
});

test("test send is gated: live mode, recipient not allowlisted, no confirm, template not approved -> no message; success once; duplicate suppressed", async () => {
  const mk = (env: Record<string, string | undefined>) => setup({ TEST_RECIPIENTS: "15550000001", ...env }, { phones: [{}], allowedRecipients: ["15550000001"] });
  const body = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => ({ bootstrap_token: BOOT, waba_id: s.fm.wabaId, phone_number_id: s.fm.phones[0]!.id, steps: ["test_send"], to: "+15550000001", confirm: true, ...extra });
  const live = mk({ LAUNCH_MODE: "live" });
  let r = await live.call(body(live));
  assert.match(step(r.json, "test_send").detail, /blocked_live_mode/);
  assert.equal(live.fm.sends.length, 0);

  const s = mk({});
  r = await s.call(body(s, { to: "15550000999" }));
  assert.match(step(r.json, "test_send").detail, /not_allowlisted/);
  r = await s.call(body(s, { confirm: undefined }));
  assert.match(step(r.json, "test_send").detail, /confirm_required/);
  r = await s.call(body(s));
  assert.match(step(r.json, "test_send").detail, /no APPROVED template/);
  assert.equal(s.fm.sends.length, 0);

  s.fm.templates.push({ id: "t1", name: "hello_world", status: "APPROVED", language: "en_US", category: "UTILITY" });
  r = await s.call(body(s));
  assert.equal(step(r.json, "test_send").status, "PASS");
  assert.equal(step(r.json, "test_send").facts.to_masked, "********001");
  assert.equal(s.fm.sends.length, 1);
  assert.ok(!r.text.includes("15550000001"));
  r = await s.call(body(s));
  assert.match(step(r.json, "test_send").detail, /duplicate_send_suppressed/);
  assert.equal(s.fm.sends.length, 1);
});

test("redaction: tokens, app secret, OTP and PIN echoed back by Meta inside error text never reach the response or logs", async () => {
  const leak = `boom ${BOOT} Bearer ${BOOT} access_token=${BOOT} ${"9990000000001"}|${SECRET} code=${OTP} pin=${PIN} ${SECRET}`;
  const s = setup({}, { phones: [{ code_verification_status: "NOT_VERIFIED", status: "PENDING", platform_type: "NOT_APPLICABLE" }], failures: [{ match: /POST .*verify_code/, message: leak }, { match: /POST .*\/subscriptions/, message: leak }] });
  const b = { bootstrap_token: BOOT, waba_id: s.fm.wabaId, phone_number_id: s.fm.phones[0]!.id, app_secret: SECRET };
  const r1 = await s.call({ ...b, steps: ["phone_verify_code"], code: OTP });
  const r2 = await s.call({ ...b, steps: ["webhook"] });
  for (const r of [r1, r2]) {
    for (const secret of [BOOT, SECRET, `code=${OTP}`, `pin=${PIN}`]) assert.ok(!r.text.includes(secret), `leaked ${secret.slice(0, 8)}`);
    assert.match(r.text, /REDACTED/);
  }
  assert.ok(!JSON.stringify(s.h.logs).includes(BOOT));
});

test("Redactor: digit-only secrets do not mangle longer numeric ids; shapes are scrubbed", () => {
  const r = new Redactor();
  r.add("123456");
  assert.equal(r.redact("id 99123456789 otp 123456 end"), "id 99123456789 otp [REDACTED] end");
  assert.match(r.redact(`x EAAB${"a".repeat(30)} y`), /REDACTED_TOKEN/);
  assert.match(r.redact("1234567890|abcdefghijklmnopqrstuv"), /REDACTED_APP_TOKEN/);
  assert.match(r.redact('{"access_token":"abc"}'), /"access_token":"\[REDACTED\]"/);
  r.add("pa|ss word12");
  assert.ok(!r.redact("q=" + encodeURIComponent("pa|ss word12")).includes("word12"));
});

test("network failure and time budget: errors are redacted; steps after the budget are SKIPPED with a resume hint", async () => {
  const s = setup();
  s.h.ctx.fetch = async () => { throw new Error(`socket hang up ${BOOT}`); };
  let r = await s.call({ ...FULL });
  assert.equal(step(r.json, "preflight").status, "FAIL");
  assert.ok(!r.text.includes(BOOT));
  const t = setup();
  const orig = t.fm.fetch;
  t.h.ctx.fetch = async (i, init) => { const res = await orig(i, init); t.h.clock.advance(TIME_BUDGET_MS - 2000); return res; };
  r = await t.call({ ...FULL });
  const skipped = r.json.results.filter((x: any) => x.status === "SKIP");
  assert.ok(skipped.length >= 1);
  assert.ok(skipped.some((x: any) => /time_budget|blocked/.test(x.detail)));
});

test("dry run (META_SETUP_DRY_RUN=1): invalid token fails safely and NO call goes to graph.facebook.com", async () => {
  const h = makeHarness({ LAUNCH_MODE: "test", META_SETUP_DRY_RUN: "1", WA_ACCESS_TOKEN: undefined, WA_APP_SECRET: undefined });
  const post = async (body: unknown) => {
    const res = await metaSetupPost(h.ctx, new Request(URL_, { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as any };
  };
  const g = await (await metaSetupGet(h.ctx, new Request(URL_, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }))).json() as any;
  assert.equal(g.dry_run, true);
  assert.equal(g.dry_run_token, DRY_RUN_TOKEN);
  let r = await post({ steps: ["businesses"], bootstrap_token: "EAAdefinitelyNotAnActualToken0123456789" });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.results[0].id, "preflight");
  assert.equal(r.json.results[0].status, "FAIL");
  assert.equal(h.net.calls.length, 0, "the real fetch was never called");
  // the stub token walks the whole flow, still without touching the network
  r = await post({ steps: ["businesses", "waba", "system_user", "subscribed_apps", "webhook"], bootstrap_token: DRY_RUN_TOKEN, app_secret: SECRET, mint_token: true, return_token: true });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.secret_delivery.values.WA_ACCESS_TOKEN, "DRYRUN_MINTED_TOKEN_NOT_REAL");
  assert.match(r.json.dry_run_notice, /nothing was sent/);
  assert.equal(h.net.calls.length, 0);
  assert.equal(h.net.graph.length, 0);
});

test("dry run keeps the safety checks: wrong admin token is still 401", async () => {
  const h = makeHarness({ META_SETUP_DRY_RUN: "1" });
  const res = await metaSetupPost(h.ctx, new Request(URL_, { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
});

test("the route never touches the state store", async () => {
  const s = setup({ WA_ACCESS_TOKEN: undefined });
  s.h.doc.resetOps();
  await s.call({ ...FULL, mint_token: true, return_token: true });
  await s.call({ bootstrap_token: BOOT, waba_id: s.fm.wabaId, phone_number_id: s.fm.phones[0]?.id ?? "99999999", steps: ["phone_register"], generate_pin: true });
  assert.deepEqual(s.h.doc.ops, { read: 0, write: 0 });
  assert.equal(s.h.doc.size, 0);
});

// ---- docs-conformance regressions (Meta Business SDK specs, re-checked 2026-10-15) ----------------------------------------------
test("docs conformance: never requests the non-existent `role` / `tasks` fields; fallback mint edge sends no app param", async () => {
  const { fm, call } = setup({ WA_ACCESS_TOKEN: undefined }, { installReadable: false, mintViaSuEdge: false });
  const r = await call({ ...FULL, steps: ["businesses", "waba", "system_user"], mint_token: true, return_token: true });
  assert.equal(r.status, 200);
  for (const c of fm.calls) {
    const f = c.query.fields ?? "";
    if (/\/system_users$/.test(c.path)) assert.ok(!f.split(",").includes("role"), `system_users must not request role: ${f}`);
    if (/\/assigned_users$/.test(c.path)) assert.ok(!f.split(",").includes("tasks"), `assigned_users must not request tasks: ${f}`);
  }
  const edge = fm.calls.find((c) => /\/system_user_access_tokens$/.test(c.path));
  assert.ok(edge, "fallback edge used");
  assert.equal(edge!.form.app_id, undefined);
  assert.equal(edge!.form.business_app, undefined);
  assert.equal(edge!.form.set_token_expires_in_60_days, "false");
  assert.equal(statuses(r.json).system_user_token, "PASS");
});

test("docs conformance: language must be a locale (en_US) and unknown business verticals fall back to OTHER", async () => {
  const { fm, call } = setup();
  const bad = await call({ steps: ["phone_request_code"], bootstrap_token: BOOT, language: "en" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, "language");
  const ok = await call({ steps: ["businesses"], bootstrap_token: BOOT, create_business: { name: "Zzz Brand New Co", vertical: "NOT_A_VERTICAL" } });
  assert.equal(ok.status, 200);
  const post = fm.calls.find((c) => c.method === "POST" && /\/businesses$/.test(c.path));
  assert.equal(post?.form.vertical, "OTHER");
});

test("subscribed_apps: before/after app ids in the facts; WARN when only other apps were subscribed", async () => {
  const { fm, call } = setup();
  fm.subscribedApps.push("1111111111111");
  const r = await call({ bootstrap_token: BOOT, waba_id: fm.wabaId, steps: ["subscribed_apps"] });
  const f = step(r.json, "subscribed_apps").facts;
  assert.deepEqual(f.before_app_ids, ["1111111111111"]);
  assert.deepEqual(f.after_app_ids, ["1111111111111", fm.appId]);
  assert.equal(step(r.json, "subscribed_apps_other_apps").status, "WARN");
});

test("store_token: the verified minted token goes into the Worker's store, never into the response", async () => {
  const { fm, call, h } = setup({ WA_ACCESS_TOKEN: undefined });
  void fm;
  const stored: Record<string, string>[] = [];
  const bad = await call({ ...FULL, mint_token: true, return_token: true, store_token: true });
  assert.equal(bad.status, 400);
  const res = await metaSetupPost(h.ctx, new Request(URL_, { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ ...FULL, mint_token: true, store_token: true }) }),
    { storeSecrets: async (v) => { stored.push(v); return { overridden_by_env: [] }; } });
  const text = await res.text();
  const j = JSON.parse(text);
  assert.equal(step(j, "system_user_token").status, "PASS");
  assert.equal(step(j, "system_user_token_stored").status, "PASS");
  assert.equal(j.secret_delivery, undefined);
  assert.ok(!text.includes(SYS));
  assert.deepEqual(stored, [{ WA_ACCESS_TOKEN: SYS }]);
});

test("store_token without a host that can store: falls back to one-time delivery", async () => {
  const { call } = setup({ WA_ACCESS_TOKEN: undefined });
  const r = await call({ ...FULL, mint_token: true, store_token: true });
  assert.equal(step(r.json, "system_user_token_stored").status, "FAIL");
  assert.equal(r.json.secret_delivery.values.WA_ACCESS_TOKEN, SYS);
});
