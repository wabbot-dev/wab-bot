# Owner and staff alerts (optional)

When a conversation needs a person, the bridge can tell you **at once** instead of waiting for someone to open `/admin`. Off unless
you configure at least one channel. Code: [lib/alerts.ts](../lib/alerts.ts).

## When an alert fires

| Event (`ALERT_EVENTS`) | When |
| --- | --- |
| `escalation` | The agent calls `escalate_conversation` (with a `category`: `human_requested`, `complaint`, `payment`, `order`, `booking`, `account`, `identity`, `urgent`, `other`) |
| `payment_claimed` | The agent records that a customer says they paid (`report_payment`, see [BUSINESS-MODE.md](BUSINESS-MODE.md#payments-staff-verified)) |
| `booking_failed` | The booking/order hook could not pass a request to your system ([BUSINESS-MODE.md](BUSINESS-MODE.md#bookings-and-orders-hook)) |
| `test` | The owner presses "test alert" (`POST /api/admin` with `{"action":"test_alert"}`, owner token only) |

All four are on by default once a channel is set; `ALERT_EVENTS=escalation` limits them.

## Channels

**Webhook** (`ALERT_WEBHOOK_URL`, https only; optional secret `ALERT_WEBHOOK_KEY`, sent as `Authorization: Bearer ...`). Point it at
anything that can receive a POST: an automation in your agent platform, a chat tool's incoming webhook, a small script. Body:

```json
{ "event": "whatsapp_escalation", "conversation_id": "c_...", "category": "complaint", "reason": "Customer wants a refund",
  "customer": "***0001", "at": "2026-10-20T19:00:00.000Z", "admin_url": "https://<worker>/admin", "note": "..." }
```

It never carries message text or the full customer number. `reason` is the agent's own short summary (max 200 characters); the
`escalate_conversation` description tells the agent never to put card numbers or passwords in it. `admin_url` appears when
`ALERT_ADMIN_URL` is set.

**WhatsApp to the owner** (`ALERT_WHATSAPP_TO`: your own number(s), digits with country code, comma separated, at most 5). The alert is
sent from the business number. Meta delivers free text only inside a 24-hour window (the owner wrote to the business number in the last
24 hours), so for reliable alerts create a **UTILITY template** with one body parameter, for example
`New WhatsApp alert: {{1}}`, get it approved, add it to `WA_TEMPLATE_ALLOWLIST` and set `ALERT_TEMPLATE` (and `ALERT_TEMPLATE_LANGUAGE`,
default `en`). In `LAUNCH_MODE=test` an alert number must also be in `TEST_RECIPIENTS`. Each alert counts as a message Meta may bill
(utility template rates), like any other.

## Reliability and privacy

- Fired right after the state is stored, in the background; a failing channel never blocks or undoes the escalation.
- One attempt per channel, no retry loop. The last result (status codes only) is in `get_overview` → `alerts` (`webhook_configured`,
  `whatsapp_recipients_count`, `template_set`, `events`, `sent_count`, `last_at`, `last_event`, `last_webhook_status`, `last_whatsapp`).
- Staff still read and answer the conversation in `/admin`; the alert is only the nudge.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ALERT_WEBHOOK_URL` | (unset) | https URL that receives the alert POST |
| `ALERT_WEBHOOK_KEY` | (secret, unset) | Bearer token for that URL |
| `ALERT_WHATSAPP_TO` | (unset) | Owner/staff WhatsApp numbers |
| `ALERT_TEMPLATE`, `ALERT_TEMPLATE_LANGUAGE` | (unset), `en` | Approved, allowlisted template with one body parameter |
| `ALERT_EVENTS` | all | `escalation`, `payment_claimed`, `booking_failed`, `test` |
| `ALERT_ADMIN_URL` | (unset) | Link included in the webhook body |

## Evidence

Tested locally in `tests/alerts.test.ts` (webhook body and auth, no content, WhatsApp template and text paths, test-mode block, event
filter, failures recorded, the owner test action). The webhook path was run on a test Worker (see [STATUS.md](STATUS.md)); WhatsApp alerts
were not sent to a real phone.
