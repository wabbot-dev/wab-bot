import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBody } from "../../lib/crypto";
import { APP_SECRET, VERIFY_TOKEN, admin, call, convOf, freshWa, inbound, signedPost, stubNetwork } from "./helpers";

beforeEach(() => { stubNetwork(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("GET /api/webhook handshake", () => {
  const q = (o: Record<string, string | undefined>) => "/api/webhook?" + new URLSearchParams(o as Record<string, string>);
  it("echoes the challenge for subscribe + the right verify token", async () => {
    const r = await call(q({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "12345" }));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("12345");
  });
  it("403 for a wrong token, wrong mode, missing challenge, missing token", async () => {
    for (const o of [
      { "hub.mode": "subscribe", "hub.verify_token": "wrong-wrong-wrong-wrong", "hub.challenge": "1" },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN },
      { "hub.mode": "subscribe", "hub.challenge": "1" },
    ]) expect((await call(q(o))).status).toBe(403);
  });
});

describe("POST /api/webhook signature", () => {
  it("rejects unsigned, wrong-secret, malformed-header and tampered bodies with 401 and stores nothing", async () => {
    const wa = freshWa();
    const raw = JSON.stringify(inbound("wamid.SIG1" + wa, "hello", wa));
    expect((await call("/api/webhook", { method: "POST", body: raw })).status).toBe(401);
    expect((await signedPost(raw, "some-other-secret-000000")).status).toBe(401);
    expect((await call("/api/webhook", { method: "POST", headers: { "X-Hub-Signature-256": "sha256=zz" }, body: raw })).status).toBe(401);
    expect((await call("/api/webhook", { method: "POST", headers: { "X-Hub-Signature-256": signBody(raw, APP_SECRET) }, body: raw + " " })).status).toBe(401);
    expect(await convOf(wa)).toBeNull();
    const ov: any = await (await admin()).json();
    expect(ov.rejections.count).toBeGreaterThanOrEqual(4);
  });

  it("verifies the HMAC over the exact raw bytes, including non-ASCII payloads", async () => {
    const wa = freshWa();
    const payload = inbound("wamid.UTF1" + wa, "héllo 👋 مرحبا", wa);
    // raw JSON with literal UTF-8 (not \u-escaped) and odd spacing: re-serialising would change the bytes
    const raw = JSON.stringify(payload, null, 3);
    const r = await signedPost(raw);
    expect(r.status).toBe(200);
    const c = await convOf(wa);
    expect(c.messages[0].text).toBe("héllo 👋 مرحبا");
  });

  it("is idempotent per wamid: a redelivery adds nothing", async () => {
    const wa = freshWa();
    const raw = JSON.stringify(inbound("wamid.DUP1" + wa, "hello", wa));
    expect((await signedPost(raw)).status).toBe(200);
    expect((await signedPost(raw)).status).toBe(200);
    const c = await convOf(wa);
    expect(c.messages).toHaveLength(1);
    expect(c.unhandled).toBe(1);
  });

  it("400 on a signed body that is not JSON; 405 on other methods", async () => {
    expect((await signedPost("{not json")).status).toBe(400);
    expect((await call("/api/webhook", { method: "PUT" })).status).toBe(405);
  });
});

describe("concurrent webhook POSTs (separate requests in one isolate)", () => {
  // Regression for a bug found by the live Cloudflare test: group-commit promises were shared between requests, so a request
  // waiting on another request's flush was cancelled by the runtime as "hung" (HTTP 500 / error 1101). Each request must own
  // its commit queue.
  it("40 simultaneous signed POSTs from 40 customers all return 200 and are all stored", async () => {
    const was = Array.from({ length: 40 }, () => freshWa());
    const rs = await Promise.all(was.map((wa, i) => signedPost(JSON.stringify(inbound("wamid.CONC" + i + wa, "hi " + i, wa)))));
    expect(rs.map((r) => r.status)).toEqual(was.map(() => 200));
    for (const wa of was) expect((await convOf(wa)).messages).toHaveLength(1);
  });
});
