// Business mode (docs/BUSINESS-MODE.md): owner directory, mode and checks in get_history, staff-verified payments, booking/order hook,
// language setting, and the CALL_SIP_TARGET choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminPost } from "../lib/admin";
import { sipTargetOf } from "../lib/config";
import { claimConversation, getHistory, reportPaymentTool, submitRequestTool } from "../lib/tools";
import { activate, adminReq, cid, inboundPayload, makeHarness, post, WA } from "./helpers";

const HOOK = "https://orders.example.test/in";
const ALERT = "https://alerts.example.test/hook";

function tap(h: ReturnType<typeof makeHarness>, urls: string[], status = 200, reply: unknown = { reference: "BK-1001" }) {
  const hits: { url: string; headers: Headers; body: any }[] = [];
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    if (urls.includes(url)) {
      hits.push({ url, headers: new Headers(init?.headers as HeadersInit), body: JSON.parse(String(init?.body)) });
      return Response.json(reply, { status: url === HOOK ? status : 200 });
    }
    return inner(input, init);
  };
  return hits;
}
async function open(env: Record<string, string> = {}) {
  const h = makeHarness(env);
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.B1", text: "Hi, I need 40 units for our shop" }));
  await h.flush();
  const c: any = await claimConversation(h.ctx, cid());
  return { h, lease: c.lease as string };
}

test("consumer mode (default) is unchanged: no directory, no extra read; language setting shown", async () => {
  const { h, lease } = await open({ BOT_LANGUAGE: "ar,en" });
  const reads0 = h.doc.log.filter((x) => x === "read").length;
  const g: any = await getHistory(h.ctx, cid(), lease);
  assert.deepEqual(g.business, { mode: "consumers", language: { preferred: ["ar", "en"] } });
  assert.equal(h.doc.log.filter((x) => x === "read").length - reads0, 1, "one read, as before");
  const d: any = await getHistory(h.ctx, cid(), lease);
  assert.ok(d.business.directory === undefined);
});

test("business mode: unknown numbers are new contacts; the owner's directory entry is trusted metadata; identity and detail checks", async () => {
  const env = { BUSINESS_MODE: "both", IDENTITY_CHECK: "details", CUSTOMER_DETAILS: "name, company , email" };
  const { h, lease } = await open(env);
  let g: any = await getHistory(h.ctx, cid(), lease);
  assert.equal(g.business.mode, "both");
  assert.equal(g.business.directory.known_account, false);
  assert.match(g.business.directory.note, /not in the owner's directory/);
  assert.deepEqual(g.business.customer_details_to_collect, ["name", "company", "email"]);
  assert.match(g.business.identity_check, /name, company, email/);
  // the owner adds the number; staff (wrong token) cannot
  assert.equal((await adminPost(h.ctx, adminReq("POST", { action: "contact_upsert", contact: { number: WA } }, "not-the-owner-token-xx"))).status, 401);
  const up: any = await (await adminPost(h.ctx, adminReq("POST", { action: "contact_upsert", contact: { number: `+${WA}`, account: "Cedar Retail", person: "Rana", tags: "Wholesale, net30, wholesale", known_account: true, terms: "Trade price list B, net 30" } }))).json();
  assert.equal(up.ok, true);
  assert.equal(up.contact.number_last4, WA.slice(-4));
  assert.ok(!JSON.stringify(up).includes(WA), "never the full number back");
  g = await getHistory(h.ctx, cid(), lease);
  assert.deepEqual(g.business.directory, { trusted: true, source: "owner", known_account: true, account: "Cedar Retail", person: "Rana", tags: ["wholesale", "net30"], terms: "Trade price list B, net 30", notes: null });
  // partial update keeps the other fields; list filters; delete
  await adminPost(h.ctx, adminReq("POST", { action: "contact_upsert", contact: { number: WA, notes: "prefers voice notes" } }));
  const list: any = await (await adminPost(h.ctx, adminReq("POST", { action: "contact_list", tag: "net30" }))).json();
  assert.equal(list.total_matching, 1);
  assert.equal(list.contacts[0].account, "Cedar Retail");
  assert.equal(list.contacts[0].notes_set, true);
  assert.equal(((await (await adminPost(h.ctx, adminReq("POST", { action: "contact_list", known: false }))).json()) as any).total_matching, 0);
  assert.deepEqual(await (await adminPost(h.ctx, adminReq("POST", { action: "contact_delete", number: WA }))).json(), { ok: true, deleted: true });
  g = await getHistory(h.ctx, cid(), lease);
  assert.equal(g.business.directory.known_account, false);
  assert.equal((await adminPost(h.ctx, adminReq("POST", { action: "contact_upsert", contact: { number: "12" } }))).status, 400);
});

test("payments: off by default; with PAYMENT_CHECK=staff a claim is recorded as CLAIMED, staff alerted, staff verify in admin", async () => {
  const off = await open();
  assert.equal(((await reportPaymentTool(off.h.ctx, cid(), off.lease, { amount: "120 USD" })) as any).error, "payments_not_enabled");
  const { h, lease } = await open({ PAYMENT_CHECK: "staff", ALERT_WEBHOOK_URL: ALERT });
  const hits = tap(h, [ALERT]);
  assert.equal(((await reportPaymentTool(h.ctx, cid(), "x".repeat(20), {})) as any).error, "lease_invalid_or_expired");
  const r: any = await reportPaymentTool(h.ctx, cid(), lease, { amount: "120 USD", method: "bank transfer", reference: "TRX-77" });
  await h.flush();
  assert.equal(r.status, "claimed");
  assert.equal(r.owner_alerted, true);
  assert.match(r.note, /never say it is confirmed/);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.body.event, "whatsapp_payment_claimed");
  assert.equal(hits[0]!.body.reason, "bank transfer 120 USD");
  let g: any = await getHistory(h.ctx, cid(), lease);
  assert.equal(g.business.payment.status, "claimed");
  const v: any = await (await adminPost(h.ctx, adminReq("POST", { action: "payment_verify", conversation_id: cid(), value: "verified" }))).json();
  assert.deepEqual(v, { ok: true, payment: "verified" });
  g = await getHistory(h.ctx, cid(), lease);
  assert.equal(g.business.payment.status, "verified");
  assert.equal(((await (await adminPost(h.ctx, adminReq("POST", { action: "payment_verify", conversation_id: cid(), value: "maybe" }))).json()) as any).error, "value_must_be_verified_or_rejected");
});

test("booking/order hook: one POST with the details and an Idempotency-Key; replay sends nothing; failure alerts the owner", async () => {
  const none = await open();
  assert.equal(((await submitRequestTool(none.h.ctx, cid(), none.lease, { kind: "order", summary: "x", idempotency_key: "k" })) as any).error, "booking_hook_not_configured");
  const { h, lease } = await open({ BOOKING_WEBHOOK_URL: HOOK, BOOKING_WEBHOOK_KEY: "hook-key-0123456789", ALERT_WEBHOOK_URL: ALERT });
  const hits = tap(h, [HOOK, ALERT]);
  const r: any = await submitRequestTool(h.ctx, cid(), lease, { kind: "order", summary: "40 units of item A, pickup Friday", fields: { item: "A", quantity: 40, "pickup date": "Friday", nested: { x: 1 } }, idempotency_key: "order-1" });
  assert.deepEqual(r, { ok: true, kind: "order", reference: "BK-1001", note: r.note });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.headers.get("authorization"), "Bearer hook-key-0123456789");
  assert.equal(hits[0]!.headers.get("idempotency-key"), `${cid()}:order-1`);
  assert.deepEqual(hits[0]!.body.fields, { item: "A", quantity: "40", pickupdate: "Friday" });
  assert.equal(hits[0]!.body.customer_number, WA);
  const again: any = await submitRequestTool(h.ctx, cid(), lease, { kind: "order", summary: "same", idempotency_key: "order-1" });
  assert.deepEqual(again, { ok: true, idempotent_replay: true, reference: "BK-1001" });
  assert.equal(hits.length, 1);
  const g: any = await getHistory(h.ctx, cid(), lease);
  assert.deepEqual(g.business.requests.map((x: any) => [x.kind, x.ok, x.reference]), [["order", true, "BK-1001"]]);
  assert.equal(((await submitRequestTool(h.ctx, cid(), lease, { kind: "spaceship", summary: "x", idempotency_key: "k2" })) as any).error, "invalid_kind");
  const f = await open({ BOOKING_WEBHOOK_URL: HOOK, ALERT_WEBHOOK_URL: ALERT });
  const fh = tap(f.h, [HOOK, ALERT], 500);
  const bad: any = await submitRequestTool(f.h.ctx, cid(), f.lease, { kind: "booking", summary: "table for 4 at 8pm", idempotency_key: "b1" });
  await f.h.flush();
  assert.equal(bad.error, "booking_hook_failed");
  assert.equal(bad.http, 500);
  assert.equal(fh.filter((x) => x.url === ALERT)[0]!.body.event, "whatsapp_booking_failed");
  assert.ok(!JSON.stringify(fh.filter((x) => x.url === ALERT)).includes("table for 4"), "the alert carries no request content");
});

test("CALL_SIP_TARGET: xai by default; a public SIP host[:port] selects another voice agent; anything else falls back to xai", () => {
  assert.deepEqual(sipTargetOf(undefined), { kind: "xai" });
  assert.deepEqual(sipTargetOf("xai"), { kind: "xai" });
  assert.deepEqual(sipTargetOf("sip.voice-agent.example.com"), { kind: "custom", host: "sip.voice-agent.example.com", port: 5061 });
  assert.deepEqual(sipTargetOf("sips:sip.voice-agent.example.com:5062"), { kind: "custom", host: "sip.voice-agent.example.com", port: 5062 });
  for (const v of ["10.0.0.1", "localhost", "bad host", "x.example.com:99999"]) assert.deepEqual(sipTargetOf(v), { kind: "xai" }, v);
});
