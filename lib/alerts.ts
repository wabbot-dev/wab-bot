/**
 * Instant owner/staff alerts (docs/ALERTS.md): when a conversation needs a person (the agent escalates, or a customer says they paid),
 * the bridge tells the owner at once, by a webhook POST and/or a WhatsApp message to the owner's own number(s). Off unless configured.
 *
 *  - Webhook (ALERT_WEBHOOK_URL, https only; optional ALERT_WEBHOOK_KEY sent as a Bearer token): a small JSON body with the event, the
 *    conversation id, a category, the agent's short reason and the last 4 digits of the customer's number. Never message text.
 *  - WhatsApp (ALERT_WHATSAPP_TO, digits, comma separated): from the business number to the owner's/staff's own WhatsApp. Outside the 24-hour
 *    window Meta only delivers templates, so set ALERT_TEMPLATE (an approved UTILITY template in WA_TEMPLATE_ALLOWLIST with one body
 *    parameter); without it a plain text is tried, which Meta delivers only if that person wrote to the business number in the last 24 h.
 *    In LAUNCH_MODE=test an alert number must also be in TEST_RECIPIENTS.
 * Best effort and never retried in a loop: the result (status codes only) is kept in one row and shown by get_overview.
 */
import type { Ctx } from "./ctx";
import { fetchTimeout } from "./ctx";
import { update } from "./store";

export const ALERTS_KEY = "alerts/last";
export const ALERT_EVENTS = ["escalation", "payment_claimed", "booking_failed", "test"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
export const ESCALATION_CATEGORIES = ["human_requested", "complaint", "payment", "order", "booking", "account", "identity", "urgent", "other"] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

export interface AlertInput { event: AlertEvent; conversationId?: string; category?: string; reason?: string; waId?: string }
export interface AlertRecord {
  at: number; event: AlertEvent; count: number;
  webhook?: { status: number | "network" | "blocked" | "skipped" };
  whatsapp?: { sent: number; failed: number; codes: string[] };
}

const clean = (s: string | undefined, n: number) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const tail4 = (wa?: string) => (wa ? `***${wa.slice(-4)}` : null);

export function alertsConfigured(ctx: Ctx): boolean {
  return !!ctx.cfg.alertWebhookUrl || ctx.cfg.alertWhatsappTo.length > 0;
}

export function alertText(a: AlertInput): string {
  const what = a.event === "escalation" ? "A conversation needs a person" : a.event === "payment_claimed" ? "A customer says they paid: please verify" : a.event === "booking_failed" ? "A booking/order could not be passed to your system" : "Test alert";
  const bits = [what, a.category ? ` (${a.category})` : "", a.reason ? `: ${clean(a.reason, 200)}` : "", a.waId ? `. Customer ${tail4(a.waId)}` : "", a.conversationId ? `. Conversation ${a.conversationId.slice(0, 10)}` : ""];
  return `${bits.join("")}. Open the admin page.`.slice(0, 900);
}

/** Send one alert to every configured channel. Never throws. */
export async function sendAlert(ctx: Ctx, a: AlertInput): Promise<AlertRecord | null> {
  const cfg = ctx.cfg;
  if (!alertsConfigured(ctx) || !cfg.alertEvents.includes(a.event)) return null;
  const rec: AlertRecord = { at: ctx.now(), event: a.event, count: 1 };
  if (cfg.alertWebhookUrl) {
    const body = {
      event: `whatsapp_${a.event}`, conversation_id: a.conversationId ?? null, category: a.category ?? null,
      reason: a.reason ? clean(a.reason, 200) : null, customer: tail4(a.waId), at: new Date(rec.at).toISOString(),
      ...(cfg.alertAdminUrl ? { admin_url: cfg.alertAdminUrl } : {}),
      note: "Content-free alert from your WhatsApp bridge. Open the admin page to read the conversation.",
    };
    try {
      const res = await fetchTimeout(ctx, cfg.alertWebhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...(cfg.alertWebhookKey ? { Authorization: `Bearer ${cfg.alertWebhookKey}` } : {}) }, body: JSON.stringify(body),
      }, 8000);
      await res.body?.cancel().catch(() => {});
      rec.webhook = { status: res.status };
    } catch {
      rec.webhook = { status: "network" };
    }
  }
  if (cfg.alertWhatsappTo.length) {
    const pn = cfg.phoneNumberIds[0];
    const wa = { sent: 0, failed: 0, codes: [] as string[] };
    for (const to of cfg.alertWhatsappTo.slice(0, 5)) {
      if (!pn || !cfg.waAccessToken) { wa.failed++; wa.codes.push("no_number_or_token"); continue; }
      if (cfg.launchMode !== "live" && !cfg.testRecipients.includes(to)) { wa.failed++; wa.codes.push("blocked_test_mode"); continue; }
      const tpl = cfg.alertTemplate && cfg.templateAllowlist.includes(cfg.alertTemplate) ? cfg.alertTemplate : undefined;
      const payload = tpl
        ? { messaging_product: "whatsapp", to, type: "template", template: { name: tpl, language: { code: cfg.alertTemplateLanguage }, components: [{ type: "body", parameters: [{ type: "text", text: clean(alertText(a), 900) }] }] } }
        : { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: alertText(a) } };
      try {
        const res = await fetchTimeout(ctx, `https://graph.facebook.com/${cfg.graphVersion}/${pn}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${cfg.waAccessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
        }, 8000);
        const j = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
        if (res.ok) wa.sent++; else { wa.failed++; wa.codes.push(`http_${res.status}${j.error?.code ? `_${j.error.code}` : ""}`); }
      } catch {
        wa.failed++; wa.codes.push("network");
      }
    }
    rec.whatsapp = wa;
  }
  ctx.log("alert", { event: a.event, webhook: rec.webhook?.status ?? null, wa_sent: rec.whatsapp?.sent ?? 0, wa_failed: rec.whatsapp?.failed ?? 0 });
  try {
    await update<AlertRecord, null>(ctx, ALERTS_KEY, (cur) => ({ next: { ...rec, count: (cur?.count ?? 0) + 1 }, result: null }));
  } catch { /* status only */ }
  return rec;
}

/** Fire an alert after the response (waitUntil). */
export function scheduleAlert(ctx: Ctx, a: AlertInput): void {
  if (!alertsConfigured(ctx)) return;
  ctx.schedule(async () => { await sendAlert(ctx, a); }, "maintenance");
}
