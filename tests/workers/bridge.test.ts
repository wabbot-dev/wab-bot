import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBody } from "../../lib/crypto";
import {
  ADMIN_TOKEN, APP_SECRET, BASE, CRON_SECRET, MCP_TOKEN, admin, bearer, call, callWith, convOf, freshWa, inbound,
  mcp, testEnv, tool, stubNetwork,
} from "./helpers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/worker";

let net: ReturnType<typeof stubNetwork>;
beforeEach(() => { net = stubNetwork(); });
afterEach(() => { vi.restoreAllMocks(); });

const post = (e: typeof testEnv, raw: string) =>
  callWith(e, "/api/webhook", { method: "POST", headers: { "X-Hub-Signature-256": signBody(raw, APP_SECRET), "Content-Type": "application/json" }, body: raw });

describe("auth on every protected endpoint", () => {
  it("admin, mcp and cron answer 401 without the right bearer", async () => {
    expect((await call("/api/admin")).status).toBe(401);
    expect((await call("/api/admin", { headers: bearer("wrong-wrong-wrong-wrong") })).status).toBe(401);
    expect((await call("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/cron/retry-wakes")).status).toBe(401);
    expect((await call("/api/cron/retry-wakes", { headers: bearer(CRON_SECRET) })).status).toBe(200);
  });
  it("the media self-test route is off (404) unless MEDIA_SELFTEST=1, even with the owner token", async () => {
    expect((await call("/api/admin/media-selftest?kind=audio", { method: "POST", headers: bearer(ADMIN_TOKEN), body: "x" })).status).toBe(404);
    expect((await call("/api/admin/media-selftest?kind=audio", { method: "GET", headers: bearer(ADMIN_TOKEN) })).status).toBe(405);
    expect((await call("/api/admin/voice-selftest?lang=en", { method: "POST", headers: bearer(ADMIN_TOKEN), body: "x" })).status).toBe(404);
    expect((await call("/api/admin/voice-selftest?lang=en", { method: "GET", headers: bearer(ADMIN_TOKEN) })).status).toBe(405);
  });
  it("an MCP token is not an admin token and vice versa", async () => {
    expect((await call("/api/admin", { headers: bearer(MCP_TOKEN) })).status).toBe(401);
    expect((await mcp("tools/list", {}, 1, ADMIN_TOKEN)).status).toBe(401);
  });
});

describe("claim / reply / finish over MCP with the Durable Object store", () => {
  it("full exchange: inbound -> wake -> list -> claim -> history -> send -> finish, recipient fixed server-side", async () => {
    const wa = freshWa();
    expect((await (await admin({ method: "POST", body: JSON.stringify({ action: "set_auto_reply", value: "active" }) })).json() as any).ok).toBe(true);
    const raw = JSON.stringify(inbound("wamid.FLOW" + wa, "Hi, are you open today?", wa));
    expect((await post(testEnv, raw)).status).toBe(200);
    // the debounced wake ran in waitUntil and posted to the (stubbed) wake URL with the bearer key
    expect(net.wakes().length).toBeGreaterThanOrEqual(1);

    const conv = await convOf(wa);
    expect(conv.state).toBe("pending");
    const pending = await tool("list_pending", {});
    expect(JSON.stringify(pending)).toContain(conv.id);
    expect(JSON.stringify(pending)).not.toContain("Hi, are you open"); // ids and counters only

    const claim = await tool("claim_conversation", { conversation_id: conv.id });
    expect(claim.ok).toBe(true);
    expect(typeof claim.lease).toBe("string");
    expect((await tool("claim_conversation", { conversation_id: conv.id })).ok).toBe(false); // already leased

    const bad = await tool("get_history", { conversation_id: conv.id, lease: "x".repeat(32) });
    expect(bad.ok).toBe(false);
    const hist = await tool("get_history", { conversation_id: conv.id, lease: claim.lease });
    expect(hist.ok).toBe(true);
    expect(JSON.stringify(hist.messages)).toContain("Hi, are you open today?");

    const sent = await tool("send_reply", { conversation_id: conv.id, lease: claim.lease, text: "Yes, until 6 pm." });
    expect(sent.ok).toBe(true);
    const g = net.graph();
    expect(g).toHaveLength(1);
    expect(g[0]!.body.to).toBe(wa); // recipient is the customer, chosen by the server
    expect(g[0]!.body.text.body).toBe("Yes, until 6 pm.");

    const fin = await tool("finish_conversation", { conversation_id: conv.id, lease: claim.lease });
    expect(fin.ok).toBe(true);
    expect((await convOf(wa)).state).toBe("replied");
  });

  it("the tool list has twelve tools and send_reply has no recipient field", async () => {
    const j: any = await (await mcp("tools/list", {})).json();
    expect(j.result.tools.map((t: any) => t.name).sort()).toEqual([
      "claim_conversation", "escalate_conversation", "finish_conversation", "get_controls", "get_history", "get_overview", "list_pending", "release_conversation", "report_payment", "send_reply", "start_conversation", "submit_request",
    ]);
    expect(Object.keys(j.result.tools.find((t: any) => t.name === "send_reply").inputSchema.properties)).not.toContain("to");
  });

  it("get_overview over the real Worker: counts, controls and secret NAMES (bindings = env), no values, no writes", async () => {
    const wa = freshWa();
    await admin({ method: "POST", body: JSON.stringify({ action: "set_auto_reply", value: "active" }) });
    expect((await post(testEnv, JSON.stringify(inbound("wamid.OVW" + wa, "overview private text", wa)))).status).toBe(200);
    const conv = await convOf(wa);
    const before = JSON.stringify(await (await admin(undefined, "?conversation=" + conv.id)).json());
    const res = await mcp("tools/call", { name: "get_overview", arguments: { action: "delete_conversation", conversation_id: conv.id } });
    const text = ((await res.json()) as any).result.content[0].text as string;
    const o = JSON.parse(text);
    expect(o.read_only).toBe(true);
    expect(o.conversations.pending).toBeGreaterThanOrEqual(1);
    expect(Object.keys(o.conversations.by_state).sort()).toEqual(["claimed", "escalated", "held_for_review", "human_takeover", "pending", "replied"]);
    expect(typeof o.conversations.oldest_pending_age_seconds).toBe("number");
    expect(o.controls.launch_mode).toBe("live");
    expect(o.controls.auto_reply).toBe("active");
    expect(o.wake.url_configured).toBe(true);
    expect(o.wake.key_present).toBe(true);
    expect(o.secrets.names.MCP_TOKEN).toEqual({ source: "env", kind: "secret" });
    expect(o.secrets.names.LAUNCH_MODE).toEqual({ source: "env", kind: "setting" });
    expect(o.secrets.names.TEST_RECIPIENTS.source).toBe("unset");
    expect(o.secrets.present).toContain("ADMIN_TOKEN");
    expect(o.secrets.missing).toContain("TEST_RECIPIENTS");
    for (const forbidden of [wa, "overview private text", MCP_TOKEN, ADMIN_TOKEN, APP_SECRET, CRON_SECRET, "test-access-token-0000001", "test-wake-key-00000001", "wake.example.test"]) {
      expect(text).not.toContain(forbidden);
    }
    // the call changed nothing, and the conversation (given as a hostile argument) still exists
    expect(JSON.stringify(await (await admin(undefined, "?conversation=" + conv.id)).json())).toBe(before);
    expect((await mcp("tools/call", { name: "get_overview", arguments: {} }, 2, ADMIN_TOKEN)).status).toBe(401);
  });

  it("GET /mcp is 405 (stateless, no SSE) once authorised", async () => {
    expect((await call("/mcp", { headers: bearer(MCP_TOKEN) })).status).toBe(405);
  });
});

describe("admin actions and retention", () => {
  it("takeover, release and delete_conversation work; deleted data is really gone", async () => {
    const wa = freshWa();
    await post(testEnv, JSON.stringify(inbound("wamid.ADM" + wa, "secret text", wa)));
    const c = await convOf(wa);
    const act = async (action: string) => (await (await admin({ method: "POST", body: JSON.stringify({ action, conversation_id: c.id }) })).json()) as any;
    expect((await act("takeover")).state).toBe("human_takeover");
    expect((await act("release")).state).toBe("replied");
    expect((await act("delete_conversation")).deleted).toBe(true);
    expect(await convOf(wa)).toBeNull();
    expect((await admin(undefined, `?conversation=${c.id}`)).status).toBe(404);
  });
});

describe("cron", () => {
  it("scheduled() runs the wake-retry pass without HTTP", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.now(), cron: "0 5 * * *" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
  });
});

describe("meta-setup route is off by default", () => {
  it("404 unless META_SETUP_ENABLED=1; when enabled it still needs the admin token and dry-run never calls Meta", async () => {
    expect((await call("/api/admin/meta-setup", { headers: bearer(ADMIN_TOKEN) })).status).toBe(404);
    const on = { ...testEnv, META_SETUP_ENABLED: "1", META_SETUP_DRY_RUN: "1" } as typeof testEnv;
    expect((await callWith(on, "/api/admin/meta-setup")).status).toBe(401);
    const r = await callWith(on, "/api/admin/meta-setup", { headers: bearer(ADMIN_TOKEN) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).dry_run).toBe(true);
    expect(net.calls.filter((c) => c.url.includes("facebook.com"))).toHaveLength(0);
  });
});

describe("pages, headers, routing", () => {
  it("GET / is a static ok page with hardening headers; /admin is noindex + CSP; unknown path 404", async () => {
    const r = await call("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ok");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const a = await call("/admin");
    expect(a.status).toBe(200);
    expect(a.headers.get("x-robots-tag")).toBe("noindex");
    expect(a.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/", { method: "POST" })).status).toBe(405);
    expect(BASE).toContain("https://");
  });
  it("GET /api/health is a cheap liveness check: 200 {ok, version} only, no secret or data, other methods 405", async () => {
    const r = await call("/api/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const raw = await r.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const v of [ADMIN_TOKEN, MCP_TOKEN, APP_SECRET, CRON_SECRET]) expect(raw).not.toContain(v);
    expect((await call("/api/health", { method: "HEAD" })).status).toBe(200);
    expect((await call("/api/health", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("/api/health/")).status).toBe(200); // same trailing-slash rule as every other route
    expect(net.calls).toHaveLength(0);
  });
  it("team inbox: staff sign-in by one-time code over the real Worker; cookie session reads the inbox; owner-only routes stay closed", async () => {
    expect((await call("/api/staff/session")).status).toBe(401);
    expect((await call("/api/staff/login", { method: "POST", body: JSON.stringify({ code: "AAAA-BBBB-CCCC" }) })).status).toBe(401);
    const inv = (await (await admin({ method: "POST", body: JSON.stringify({ action: "staff_invite" }) })).json()) as { code: string };
    const login = await call("/api/staff/login", { method: "POST", body: JSON.stringify({ code: inv.code }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toMatch(/^wb_staff=\d{13}\.[0-9a-f]{64}$/);
    expect((await call("/api/admin", { headers: { cookie } })).status).toBe(200);
    expect((await call("/api/staff/session", { headers: { cookie } })).status).toBe(200);
    expect((await call("/api/admin/secrets", { headers: { cookie } })).status).toBe(401);
    expect((await call("/api/admin/start-conversation", { method: "POST", headers: { cookie, "X-Staff-Request": "1" }, body: "{}" })).status).toBe(401);
    const page = await (await call("/admin")).text();
    expect(page).toContain("Team inbox");
    expect(page).toContain("/api/staff/login");
  });
  it("the page source contains no token or secret values", async () => {
    const t = await (await call("/admin")).text();
    for (const v of [ADMIN_TOKEN, MCP_TOKEN, APP_SECRET, CRON_SECRET]) expect(t).not.toContain(v);
  });
});
