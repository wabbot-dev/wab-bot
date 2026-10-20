// Instant owner/staff alerts on escalation (docs/ALERTS.md): webhook and/or WhatsApp to the owner, content-free, best effort.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminPost } from "../lib/admin";
import { ALERTS_KEY, alertText, type AlertRecord } from "../lib/alerts";
import { getOverview } from "../lib/overview";
import { claimConversation, escalateConversation, getHistory } from "../lib/tools";
import { activate, adminReq, cid, getConv, inboundPayload, makeHarness, post, WA } from "./helpers";

const HOOK = "https://alerts.example.test/hook";
const OWNER = "15550000099";
const KEY = "alert-key-" + "0123456789abcdef";

function alertNet(h: ReturnType<typeof makeHarness>, status = 200) {
  const hits: { url: string; auth: string | null; body: any }[] = [];
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    if (url === HOOK) { hits.push({ url, auth: new Headers(init?.headers as HeadersInit).get("authorization"), body: JSON.parse(String(init?.body)) }); return new Response("ok", { status }); }
    return inner(input, init);
  };
  return hits;
}
async function escalate(h: ReturnType<typeof makeHarness>, reason = "Customer wants a refund for order 123", category?: string) {
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.E1", text: "my private message text" }));
  await h.flush();
  const c: any = await claimConversation(h.ctx, cid());
  await getHistory(h.ctx, cid(), c.lease);
  const r: any = await escalateConversation(h.ctx, cid(), c.lease, reason, category);
  await h.flush();
  return r;
}

test("escalation fires one content-free webhook alert at once (category, reason, last 4 digits; never message text); recorded for get_overview", async () => {
  const h = makeHarness({ ALERT_WEBHOOK_URL: HOOK, ALERT_WEBHOOK_KEY: KEY });
  const hits = alertNet(h);
  const r = await escalate(h, "Customer wants a refund", "complaint");
  assert.deepEqual(r, { ok: true, state: "escalated", category: "complaint", owner_alerted: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.auth, `Bearer ${KEY}`);
  const b = hits[0]!.body;
  assert.equal(b.event, "whatsapp_escalation");
  assert.equal(b.conversation_id, cid());
  assert.equal(b.category, "complaint");
  assert.equal(b.reason, "Customer wants a refund");
  assert.equal(b.customer, `***${WA.slice(-4)}`);
  assert.ok(!JSON.stringify(b).includes("my private message text"));
  assert.ok(!JSON.stringify(b).includes(WA));
  assert.equal((await getConv(h)).escalation?.category, "complaint");
  const ov: any = await getOverview(h.ctx, null);
  assert.equal(ov.alerts.sent_count, 1);
  assert.equal(ov.alerts.last_webhook_status, 200);
  assert.equal(ov.alerts.last_event, "escalation");
  assert.ok(!JSON.stringify(ov).includes(KEY));
});

test("WhatsApp alert to the owner: template when set and allowlisted, else text; blocked in test mode unless allowlisted; failures recorded", async () => {
  const h = makeHarness({ ALERT_WHATSAPP_TO: `+${OWNER}`, ALERT_TEMPLATE: "staff_alert", WA_TEMPLATE_ALLOWLIST: "staff_alert" });
  await escalate(h, "Needs a manager", "urgent");
  const s = h.net.graph.filter((c) => /\/messages$/.test(c.url) && c.body?.to === OWNER);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.body.type, "template");
  assert.equal(s[0]!.body.template.name, "staff_alert");
  assert.match(s[0]!.body.template.components[0].parameters[0].text, /needs a person \(urgent\): Needs a manager\. Customer \*\*\*\d{4}/);
  const t = makeHarness({ ALERT_WHATSAPP_TO: OWNER });
  await escalate(t);
  assert.equal(t.net.graph.filter((c) => c.body?.to === OWNER)[0]!.body.type, "text", "no template: plain text (delivered only inside the owner's 24 h window)");
  const tm = makeHarness({ ALERT_WHATSAPP_TO: OWNER, LAUNCH_MODE: "test", TEST_RECIPIENTS: WA });
  await escalate(tm);
  assert.equal(tm.net.graph.filter((c) => c.body?.to === OWNER).length, 0, "test mode: the owner number must be in TEST_RECIPIENTS too");
  const rec = (await tm.store.get<AlertRecord>(ALERTS_KEY))?.value;
  assert.deepEqual(rec?.whatsapp, { sent: 0, failed: 1, codes: ["blocked_test_mode"] });
});

test("no alert configured: escalation works as before, owner_alerted false, no network call; ALERT_EVENTS filters", async () => {
  const h = makeHarness();
  const r = await escalate(h);
  assert.equal(r.owner_alerted, false);
  assert.equal(h.net.calls.filter((c) => !c.url.includes("wake")).filter((c) => !/graph/.test(c.url)).length, 0);
  const f = makeHarness({ ALERT_WEBHOOK_URL: HOOK, ALERT_EVENTS: "payment_claimed" });
  const hits = alertNet(f);
  await escalate(f);
  assert.equal(hits.length, 0);
  assert.equal(makeHarness({ ALERT_WEBHOOK_URL: "http://insecure.example.test/x" }).ctx.cfg.alertWebhookUrl, undefined, "https only");
});

test("a failing webhook never breaks the escalation; owner test_alert action", async () => {
  const h = makeHarness({ ALERT_WEBHOOK_URL: HOOK });
  alertNet(h, 500);
  const r = await escalate(h);
  assert.equal(r.ok, true);
  assert.equal((await getConv(h)).state, "escalated");
  const res = await adminPost(h.ctx, adminReq("POST", { action: "test_alert" }));
  const j: any = await res.json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.webhook, { status: 500 });
  assert.match(alertText({ event: "payment_claimed", reason: "paid by transfer" }), /says they paid: please verify: paid by transfer/);
});
