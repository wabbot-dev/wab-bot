import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { signBody } from "../../lib/crypto";
import worker from "../../src/worker";
import type { Env } from "../../src/env";

// FAKE values, identical to vitest.config.ts
export const PN = "1000000000001";
export const WABA = "2000000000002";
export const WA = "15550000001";
export const APP_SECRET = "test-app-secret-0000001";
export const VERIFY_TOKEN = "test-verify-token-0001";
export const MCP_TOKEN = "test-mcp-token-0000001";
export const ADMIN_TOKEN = "test-admin-token-00001";
export const CRON_SECRET = "test-cron-secret-00001";
export const WAKE_URL = "https://wake.example.test/hook";

export const testEnv = env as unknown as Env;
export const BASE = "https://bridge.example.test";

export const call = (path: string, init?: RequestInit) => (exports as unknown as { default: Fetcher }).default.fetch(new Request(BASE + path, init));
export const bearer = (t: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${t}`, ...extra });

/** Run a request through the Worker with an explicit env (to flip flags) and await its waitUntil work. */
export async function callWith(e: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function inbound(wamid: string, text = "hello", from = WA) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: WABA,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15551000000", phone_number_id: PN },
          contacts: [{ profile: { name: "Test Customer" }, wa_id: from }],
          messages: [{ id: wamid, from, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }],
        },
      }],
    }],
  };
}

export const signedPost = (raw: string, secret = APP_SECRET) =>
  call("/api/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody(raw, secret) }, body: raw });

export const admin = (init?: RequestInit, q = "") => call("/api/admin" + q, { ...init, headers: { ...bearer(ADMIN_TOKEN, { "Content-Type": "application/json" }), ...(init?.headers as object) } });

/** Stub every outbound fetch: Meta Graph + the wake URL. Anything else throws, so a test can never reach the network. */
export function stubNetwork() {
  const calls: { url: string; body: any }[] = [];
  let n = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.startsWith("https://graph.facebook.com/")) return Response.json({ messages: [{ id: `wamid.OUT${++n}` }] });
    if (url === WAKE_URL) return new Response("{}", { status: 200 });
    throw new Error("unexpected network call " + url);
  });
  return { calls, spy, graph: () => calls.filter((c) => c.url.startsWith("https://graph.facebook.com/")), wakes: () => calls.filter((c) => c.url === WAKE_URL) };
}

export async function mcp(method: string, params: unknown, id = 1, token: string | null = MCP_TOKEN) {
  const res = await call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? bearer(token) : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res;
}
export async function tool(name: string, args: unknown) {
  const res = await mcp("tools/call", { name, arguments: args });
  const j: any = await res.json();
  return JSON.parse(j.result.content[0].text);
}

let seq = 0;
/** A fresh, unique customer number per call (Durable Object storage is shared by the tests of a file). */
export const freshWa = () => `1555${String(Date.now()).slice(-6)}${String(++seq).padStart(2, "0")}`;

export async function convOf(wa: string): Promise<any> {
  const ov: any = await (await admin()).json();
  const row = ov.conversations.find((c: any) => c.wa_id === wa);
  if (!row) return null;
  return (await admin(undefined, `?conversation=${row.id}`)).json();
}
