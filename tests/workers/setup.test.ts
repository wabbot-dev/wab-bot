import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBody } from "../../lib/crypto";
import type { Env } from "../../src/env";
import { PN, callWith, inbound, stubNetwork, testEnv } from "./helpers";

// All values are FAKE. The env below has NO secret bindings: everything comes from POST /api/setup.
const NONCE = "n".repeat(8) + "0123456789abcdef0123456789abcdef0123";
const S = {
  WA_APP_SECRET: "fake-app-secret-for-setup-test-1",
  WA_ACCESS_TOKEN: "fake-access-token-for-setup-test-1",
  WA_VERIFY_TOKEN: "fake-verify-token-for-setup-1",
  MCP_TOKEN: "fake-mcp-token-for-setup-0001",
  ADMIN_TOKEN: "fake-admin-token-for-setup-001",
  CRON_SECRET: "fake-cron-secret-for-setup-001",
};
const env: Env = { STATE: testEnv.STATE, SETUP_NONCE: NONCE, WA_PHONE_NUMBER_IDS: PN, WAKE_DEBOUNCE_MS: "0" } as unknown as Env;
const post = (path: string, body: unknown, headers: Record<string, string> = {}, e: Env = env) =>
  callWith(e, path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const setup = (body: unknown, e: Env = env) => post("/api/setup", body, {}, e);
const adminAuth = (t: string) => ({ Authorization: `Bearer ${t}` });
const signed = (raw: string, secret: string, e: Env = env) =>
  post("/api/webhook", raw, { "X-Hub-Signature-256": signBody(raw, secret) }, e);

let logs: string[] = [];
beforeEach(() => {
  stubNetwork();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

const everything = () => logs.join("\n");
const noSecretIn = (text: string) => { for (const v of Object.values(S)) expect(text).not.toContain(v); expect(text).not.toContain(NONCE); };

describe("self-provisioning: POST /api/setup", () => {
  it("is closed before setup: no secrets means handshake 403 and webhook 401", async () => {
    expect((await callWith(env, "/api/webhook?hub.mode=subscribe&hub.verify_token=anything-anything-1&hub.challenge=1")).status).toBe(403);
    const raw = JSON.stringify(inbound("wamid.PRE1"));
    expect((await signed(raw, "whatever-whatever-1")).status).toBe(401);
  });

  it("403 for a missing or wrong nonce, and nothing is claimed", async () => {
    expect((await setup({ secrets: S })).status).toBe(403);
    expect((await setup({ nonce: "x".repeat(44), secrets: S })).status).toBe(403);
    expect((await setup({ nonce: NONCE.slice(0, -1), secrets: S })).status).toBe(403);
    expect((await callWith(env, "/api/setup")).status).toBe(405);
    const st = await testEnv.STATE.get(testEnv.STATE.idFromName("state-v1")).getSecrets();
    expect(st.claimed).toBe(false);
    expect(Object.keys(st.values)).toHaveLength(0);
  });

  it("setup is disabled when SETUP_NONCE is unset or short, even if the caller sends the same short string", async () => {
    expect((await setup({ nonce: "short", secrets: S }, { ...env, SETUP_NONCE: "short" } as Env)).status).toBe(403);
    expect((await setup({ nonce: "", secrets: S }, { ...env, SETUP_NONCE: undefined } as Env)).status).toBe(403);
  });

  it("400 (and NOT claimed) for a bad body: unknown name, short token, bad LAUNCH_MODE, missing ADMIN_TOKEN, junk", async () => {
    for (const secrets of [
      { ...S, NOPE: "value" },
      { ...S, MCP_TOKEN: "short" },
      { ...S, LAUNCH_MODE: "prod" },
      { ...S, WA_APP_SECRET: "has space inside" },
      { ...S, WA_ACCESS_TOKEN: null },
      { WA_APP_SECRET: S.WA_APP_SECRET },
    ]) {
      const r = await setup({ nonce: NONCE, secrets });
      expect(r.status).toBe(400);
      noSecretIn(await r.text());
    }
    expect((await post("/api/setup", "{not json")).status).toBe(400);
    expect((await post("/api/setup", "[]")).status).toBe(400);
    const st = await testEnv.STATE.get(testEnv.STATE.idFromName("state-v1")).getSecrets();
    expect(st.claimed).toBe(false);
  });

  it("stores the secrets once, locks, and never echoes or logs a value", async () => {
    const r = await setup({ nonce: NONCE, secrets: { ...S, TEST_RECIPIENTS: "15550000111", LAUNCH_MODE: "test" } });
    expect(r.status).toBe(200);
    const text = await r.text();
    noSecretIn(text);
    const j = JSON.parse(text);
    expect(j.locked).toBe(true);
    expect(j.stored).toEqual(["ADMIN_TOKEN", "CRON_SECRET", "LAUNCH_MODE", "MCP_TOKEN", "TEST_RECIPIENTS", "WA_ACCESS_TOKEN", "WA_APP_SECRET", "WA_VERIFY_TOKEN"]);
    expect(JSON.stringify(j)).not.toContain("15550000111");
    noSecretIn(everything());
  });

  it("a second /api/setup is 403 (right nonce and wrong nonce alike) and changes nothing", async () => {
    const r = await setup({ nonce: NONCE, secrets: { ...S, WA_APP_SECRET: "attacker-secret-attacker-secret", ADMIN_TOKEN: "attacker-admin-token-0000" } });
    expect(r.status).toBe(403);
    expect((await r.json() as any).error).toBe("setup_locked");
    expect((await setup({ nonce: "z".repeat(44), secrets: S })).status).toBe(403);
    // the original secret still works
    const raw = JSON.stringify(inbound("wamid.LOCK1"));
    expect((await signed(raw, S.WA_APP_SECRET)).status).toBe(200);
    expect((await signed(raw, "attacker-secret-attacker-secret")).status).toBe(401);
  });

  it("uses the stored values: handshake passes, a correctly signed POST is 200, a bad signature is 401", async () => {
    const q = (t: string) => `/api/webhook?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=777`;
    const ok = await callWith(env, q(S.WA_VERIFY_TOKEN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    expect((await callWith(env, q("wrong-wrong-wrong-wrong"))).status).toBe(403);
    const raw = JSON.stringify(inbound("wamid.OK1", "héllo 👋"));
    expect((await signed(raw, S.WA_APP_SECRET)).status).toBe(200);
    expect((await signed(raw, "not-the-secret-not-the-secret")).status).toBe(401);
    expect((await post("/api/webhook", raw)).status).toBe(401);
    expect((await post("/api/webhook", raw, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401);
  });

  it("stored TEST_RECIPIENTS / LAUNCH_MODE reach the config; stored ADMIN_TOKEN and MCP_TOKEN authenticate", async () => {
    const ov = await callWith(env, "/api/admin", { headers: adminAuth(S.ADMIN_TOKEN) });
    expect(ov.status).toBe(200);
    expect((await callWith(env, "/api/admin", { headers: adminAuth("nope-nope-nope-nope-nope") })).status).toBe(401);
    const mcp = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...adminAuth(S.MCP_TOKEN), Accept: "application/json, text/event-stream" });
    expect(mcp.status).toBe(200);
    const list = await callWith(env, "/api/admin/secrets", { headers: adminAuth(S.ADMIN_TOKEN) });
    const j: any = await list.json();
    expect(j.setup_locked).toBe(true);
    expect(j.names.LAUNCH_MODE.source).toBe("stored");
    expect(j.names.TEST_RECIPIENTS.source).toBe("stored");
    expect(j.names.WAKE_KEY.source).toBe("unset");
    noSecretIn(JSON.stringify(j));
    expect(JSON.stringify(j)).not.toContain("15550000111");
  });

  it("get_overview reports stored credentials by NAME with source=stored, and no value", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } }, { ...adminAuth(S.MCP_TOKEN), Accept: "application/json, text/event-stream" });
    expect(r.status).toBe(200);
    const text = ((await r.json()) as any).result.content[0].text as string;
    const o = JSON.parse(text);
    expect(o.secrets.setup_locked).toBe(true);
    expect(o.secrets.names.MCP_TOKEN).toEqual({ source: "stored", kind: "secret" });
    expect(o.secrets.names.LAUNCH_MODE.source).toBe("stored");
    expect(o.secrets.names.WAKE_KEY.source).toBe("unset");
    expect(o.secrets.present).toContain("WA_APP_SECRET");
    expect(o.secrets.missing).toContain("WAKE_KEY");
    expect(o.controls.launch_mode).toBe("test");
    expect(o.controls.test_recipients_count).toBe(1);
    noSecretIn(text);
    expect(text).not.toContain("15550000111");
    expect((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overview", arguments: {} } }, { ...adminAuth(S.ADMIN_TOKEN), Accept: "application/json, text/event-stream" })).status).toBe(401);
  });

  it("a real Worker secret binding wins over the stored value", async () => {
    const e2 = { ...env, WA_APP_SECRET: "binding-app-secret-binding-1" } as Env;
    const raw = JSON.stringify(inbound("wamid.ENV1"));
    expect((await signed(raw, S.WA_APP_SECRET, e2)).status).toBe(401);
    expect((await signed(raw, "binding-app-secret-binding-1", e2)).status).toBe(200);
  });
});

describe("rotation: /api/admin/secrets", () => {
  const rot = (secrets: unknown, token: string | null = S.ADMIN_TOKEN) =>
    post("/api/admin/secrets", { secrets }, token ? adminAuth(token) : {});

  it("needs the admin token (401 without, with a wrong one, and with the nonce)", async () => {
    expect((await rot({ WA_APP_SECRET: "new-app-secret-new-app-secret" }, null)).status).toBe(401);
    expect((await rot({ WA_APP_SECRET: "new-app-secret-new-app-secret" }, "wrong-wrong-wrong-wrong")).status).toBe(401);
    expect((await rot({ WA_APP_SECRET: "new-app-secret-new-app-secret" }, NONCE)).status).toBe(401);
    expect((await callWith(env, "/api/admin/secrets")).status).toBe(401);
  });

  it("rotates a secret: the old one stops working at once, the new one works; the reply carries no value", async () => {
    const next = "rotated-app-secret-rotated-0001";
    const r = await rot({ WA_APP_SECRET: next });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(next);
    expect(JSON.parse(text).changed).toEqual(["WA_APP_SECRET"]);
    const raw = JSON.stringify(inbound("wamid.ROT1"));
    expect((await signed(raw, S.WA_APP_SECRET)).status).toBe(401);
    expect((await signed(raw, next)).status).toBe(200);
    S.WA_APP_SECRET = next;
  });

  it("rotates the admin token itself; refuses to delete it; validates input", async () => {
    expect((await rot({ ADMIN_TOKEN: null })).status).toBe(400);
    expect((await rot({ NOPE: "x".repeat(20) })).status).toBe(400);
    expect((await rot({ MCP_TOKEN: "short" })).status).toBe(400);
    expect((await rot({})).status).toBe(400);
    const next = "rotated-admin-token-0000000001";
    expect((await rot({ ADMIN_TOKEN: next })).status).toBe(200);
    expect((await callWith(env, "/api/admin", { headers: adminAuth(S.ADMIN_TOKEN) })).status).toBe(401);
    expect((await callWith(env, "/api/admin", { headers: adminAuth(next) })).status).toBe(200);
    S.ADMIN_TOKEN = next;
  });

  it("can delete a setting (null) and reports names overridden by a real binding", async () => {
    const e2 = { ...env, MCP_TOKEN: "binding-mcp-token-binding-0001" } as Env;
    const r = await post("/api/admin/secrets", { secrets: { MCP_TOKEN: "stored-mcp-token-stored-00001", TEST_RECIPIENTS: null } }, adminAuth(S.ADMIN_TOKEN), e2);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.overridden_by_env).toEqual(["MCP_TOKEN"]);
    const list: any = await (await callWith(env, "/api/admin/secrets", { headers: adminAuth(S.ADMIN_TOKEN) })).json();
    expect(list.names.TEST_RECIPIENTS.source).toBe("unset");
    expect(list.setup_locked).toBe(true); // rotation never unlocks, and setup is still 403
    expect((await setup({ nonce: NONCE, secrets: S })).status).toBe(403);
  });

  it("no log line of the whole file contains a secret value", () => {
    noSecretIn(everything());
    expect(everything()).not.toContain("rotated-");
  });
});

describe("atomic claim in the Durable Object", () => {
  it("20 concurrent claimSetup calls: exactly one wins, and its values are the ones stored", async () => {
    const stub = testEnv.STATE.get(testEnv.STATE.idFromName("race-test"));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stub.claimSetup({ WA_APP_SECRET: `race-secret-${i}-xxxxxxxx` }, Date.now())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const st = await stub.getSecrets();
    const winner = results.findIndex((r) => r.ok);
    expect(st.values.WA_APP_SECRET).toBe(`race-secret-${winner}-xxxxxxxx`);
    expect(st.claimed).toBe(true);
    expect((await stub.claimSetup({ WA_APP_SECRET: "late-late-late-late" }, Date.now())).ok).toBe(false);
  });

  it("putSecrets (rotation) never claims setup", async () => {
    const stub = testEnv.STATE.get(testEnv.STATE.idFromName("rotate-only"));
    await stub.putSecrets({ MCP_TOKEN: "m".repeat(20) }, Date.now());
    expect((await stub.getSecrets()).claimed).toBe(false);
    expect((await stub.claimSetup({ ADMIN_TOKEN: "a".repeat(20) }, Date.now())).ok).toBe(true);
  });
});
