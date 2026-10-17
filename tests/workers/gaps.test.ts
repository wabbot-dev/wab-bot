// The two v0.1.0 "known gaps" that this repository now closes, tested over the real Worker + SQLite Durable Object:
//  1. /api/admin/meta-setup is OFF by default and can only be switched on by a real deployment variable.
//  2. A single conversation can be erased on request (DELETE /api/admin/conversations/<id>).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBody } from "../../lib/crypto";
import {
  ADMIN_TOKEN, APP_SECRET, MCP_TOKEN, admin, bearer, call, callWith, convOf, freshWa, inbound, mcp, stubNetwork, testEnv,
} from "./helpers";

let net: ReturnType<typeof stubNetwork>;
beforeEach(() => { net = stubNetwork(); });
afterEach(() => { vi.restoreAllMocks(); });

const postInbound = (wa: string, wamid: string, text: string) => {
  const raw = JSON.stringify(inbound(wamid, text, wa));
  return callWith(testEnv, "/api/webhook", { method: "POST", headers: { "X-Hub-Signature-256": signBody(raw, APP_SECRET), "Content-Type": "application/json" }, body: raw });
};
const del = (id: string, token: string | null = ADMIN_TOKEN) => call(`/api/admin/conversations/${id}`, { method: "DELETE", headers: token ? bearer(token) : {} });

describe("meta-setup route is off by default (gap 1)", () => {
  const on = (v: string) => ({ ...testEnv, META_SETUP_ENABLED: v, META_SETUP_DRY_RUN: "1" }) as typeof testEnv;

  it("GET and POST answer 404 even WITH a valid admin token, on every path spelling", async () => {
    for (const path of ["/api/admin/meta-setup", "/api/admin/meta-setup/"]) {
      expect((await call(path, { headers: bearer(ADMIN_TOKEN) })).status).toBe(404);
      expect((await call(path, { method: "POST", headers: bearer(ADMIN_TOKEN), body: "{}" })).status).toBe(404);
      expect((await call(path)).status).toBe(404); // not even a 401: the route does not exist
    }
    expect(net.calls.filter((c) => c.url.includes("facebook.com"))).toHaveLength(0);
  });

  it("only the exact value 1 enables it; true / yes / 0 / empty keep it off", async () => {
    for (const v of ["true", "yes", "0", "", "on", "2"]) {
      expect((await callWith(on(v), "/api/admin/meta-setup", { headers: bearer(ADMIN_TOKEN) })).status).toBe(404);
    }
    expect((await callWith(on("1"), "/api/admin/meta-setup", { headers: bearer(ADMIN_TOKEN) })).status).toBe(200);
  });

  it("when enabled it still needs the admin token (the MCP token is not enough) and makes no Meta call without it", async () => {
    expect((await callWith(on("1"), "/api/admin/meta-setup")).status).toBe(401);
    expect((await callWith(on("1"), "/api/admin/meta-setup", { headers: bearer(MCP_TOKEN) })).status).toBe(401);
    expect((await callWith(on("1"), "/api/admin/meta-setup", { method: "POST", body: "{}" })).status).toBe(401);
    expect(net.calls.filter((c) => c.url.includes("facebook.com"))).toHaveLength(0);
  });

  it("cannot be switched on through the secrets/provisioning API (it is not a managed name)", async () => {
    const res = await call("/api/admin/secrets", { method: "POST", headers: { ...bearer(ADMIN_TOKEN), "Content-Type": "application/json" }, body: JSON.stringify({ secrets: { META_SETUP_ENABLED: "1" } }) });
    expect(res.status).toBe(400);
    expect((await call("/api/admin/meta-setup", { headers: bearer(ADMIN_TOKEN) })).status).toBe(404);
  });

  it("get_overview reports whether the route is enabled (read-only health signal)", async () => {
    const res = await mcp("tools/call", { name: "get_overview", arguments: {} });
    const o = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(o.controls.meta_setup_enabled).toBe(false);
  });
});

describe("per-conversation erase (gap 2)", () => {
  it("DELETE /api/admin/conversations/<id>: needs the admin token, erases one customer, leaves the others", async () => {
    const a = freshWa(), b = freshWa();
    expect((await postInbound(a, "wamid.GAPA" + a, "erase me please text")).status).toBe(200);
    expect((await postInbound(b, "wamid.GAPB" + b, "keep me text")).status).toBe(200);
    const ca = await convOf(a);
    expect(ca).not.toBeNull();

    expect((await del(ca.id, null)).status).toBe(401);
    expect((await del(ca.id, MCP_TOKEN)).status).toBe(401);
    expect((await call(`/api/admin/conversations/${ca.id}`, { headers: bearer(ADMIN_TOKEN) })).status).toBe(405);
    expect((await del("not-an-id")).status).toBe(400);
    expect((await del("c_" + "0".repeat(20))).status).toBe(404);
    expect(await convOf(a)).not.toBeNull(); // refused calls changed nothing

    const r = await del(ca.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, deleted: true });
    expect(await convOf(a)).toBeNull();
    expect((await admin(undefined, `?conversation=${ca.id}`)).status).toBe(404);
    expect((await convOf(b))?.messages?.[0]?.text ?? JSON.stringify(await convOf(b))).toContain("keep me text");
    expect((await del(ca.id)).status).toBe(404); // second erase

    // the whole admin overview no longer mentions the erased number or text
    const overview = JSON.stringify(await (await admin()).json());
    expect(overview).not.toContain(a);
    expect(overview).not.toContain("erase me please");
  });

  it("erased data is not reachable through the agent's MCP tools either", async () => {
    const wa = freshWa();
    await admin({ method: "POST", body: JSON.stringify({ action: "set_auto_reply", value: "active" }) });
    await postInbound(wa, "wamid.GAPC" + wa, "secret mcp text");
    const conv = await convOf(wa);
    const claim = JSON.parse(((await (await mcp("tools/call", { name: "claim_conversation", arguments: { conversation_id: conv.id } })).json()) as any).result.content[0].text);
    expect(claim.ok).toBe(true);
    expect((await del(conv.id)).status).toBe(200);
    const hist = JSON.parse(((await (await mcp("tools/call", { name: "get_history", arguments: { conversation_id: conv.id, lease: claim.lease } })).json()) as any).result.content[0].text);
    expect(hist.ok).toBe(false);
    const send = JSON.parse(((await (await mcp("tools/call", { name: "send_reply", arguments: { conversation_id: conv.id, lease: claim.lease, text: "hi" } })).json()) as any).result.content[0].text);
    expect(send).toEqual({ ok: false, error: "not_found" });
    expect(net.graph()).toHaveLength(0);
    const pending = JSON.stringify(await (await mcp("tools/call", { name: "list_pending", arguments: {} })).json());
    expect(pending).not.toContain(conv.id);
    expect(pending).not.toContain("secret mcp text");
  });

  it("the older POST action still works and is the same erase", async () => {
    const wa = freshWa();
    await postInbound(wa, "wamid.GAPD" + wa, "legacy action text");
    const conv = await convOf(wa);
    const r: any = await (await admin({ method: "POST", body: JSON.stringify({ action: "delete_conversation", conversation_id: conv.id }) })).json();
    expect(r).toEqual({ ok: true, deleted: true });
    expect(await convOf(wa)).toBeNull();
  });
});
