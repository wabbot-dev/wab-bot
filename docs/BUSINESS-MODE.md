# Business mode: consumers, businesses, or both

One template, three setups. The owner picks who the bot serves during setup (`BUSINESS_MODE`):

| Mode | Who writes in | What changes |
| --- | --- | --- |
| `consumers` (default) | The public | Nothing: the bridge behaves exactly as before and reads nothing extra |
| `businesses` | Trade customers: shops, resellers, companies with an account | The agent sees the owner's **directory** entry for each number and runs the identity check before account details |
| `both` | Both | As `businesses`; unknown numbers are treated as new public customers |

A business that already runs a consumer bot can add a business bot as a second import (its own Worker and number, see
[DEPLOY.md](DEPLOY.md#one-worker-per-bot-a-second-bot-in-the-same-account) and
[META-SETUP.md](META-SETUP.md#one-bot-per-meta-app-a-second-bot-gets-a-new-meta-app)), or run one bot with `both`.

Code: [lib/business.ts](../lib/business.ts). Tests: `tests/business.test.ts`.

## The contact / account directory

A list the **owner** keeps, keyed by WhatsApp number (digits with country code):

| Field | Meaning |
| --- | --- |
| `account` | Company or account name |
| `person` | Contact person |
| `tags` | Lowercase tags, e.g. `wholesale`, `reseller`, `vip`, `net30` (max 12) |
| `known_account` | `true` = an existing business account: account terms, trade prices and private documents may be shared after the identity check |
| `terms` | Short note for the agent: which price list, payment terms, credit status (300 characters) |
| `notes` | Any other short note for the agent (500 characters) |

How the owner manages it:

- Admin API (owner token only; staff sessions cannot change it): `POST /api/admin` with
  `{"action":"contact_upsert","contact":{"number":"...","account":"...","tags":"wholesale,net30","known_account":true,"terms":"..."}}`,
  `{"action":"contact_delete","number":"..."}`, `{"action":"contact_list","tag":"wholesale"}`.
- Admin MCP (owner's agent platform): `directory_list`, `directory_upsert`, `directory_delete`.

Fields not given in an update are kept. Lists show the last 4 digits of the number only. Up to 5000 entries.

**Trust.** Entries come only from the owner. The agent sees them in `get_history` under `business.directory` with
`trusted: true, source: "owner"`. A customer can never create or change an entry; nothing the customer writes is copied into it. A
customer who *claims* to be a known account is still an unknown number until the owner adds it.

## What the agent sees (`get_history` → `business`)

```json
{ "mode": "both", "language": { "preferred": ["ar", "en"] },
  "directory": { "trusted": true, "source": "owner", "known_account": true, "account": "Cedar Retail", "person": "Rana",
                 "tags": ["wholesale", "net30"], "terms": "Trade price list B, net 30", "notes": null },
  "identity_check": "Before account details ...", "customer_details_to_collect": ["name", "company", "email"],
  "payment": { "status": "claimed", "at": "..." }, "requests": [{ "kind": "order", "ok": true, "reference": "BK-1001" }] }
```

In `consumers` mode with no identity check only `mode` and `language` appear and no extra read is made.

## Knowledge sheet sections for businesses

The owner's knowledge sheet (in the agent platform, not in this repository) gains four optional sections the agent uses only for a
`known_account` that passed the identity check:

- **Account terms**: price lists by tag, minimum order, delivery terms.
- **Credit**: who has credit, the limit wording the agent may use, what to escalate.
- **Group and bulk quotes**: quantity breaks, lead times, what needs a person (`submit_request` kind `quote`, or escalate).
- **Private documents**: catalogues or price-list links the agent may send (`send_reply` with `media`, see [OUTBOUND.md](OUTBOUND.md)).

## Customer details and identity checks

- `CUSTOMER_DETAILS` (e.g. `name,company,email`): fields the agent collects before an order, booking or account request.
- `IDENTITY_CHECK`:
  - `none` (default): no check.
  - `known_number`: account details, terms and private documents only for a number marked `known_account`.
  - `details`: also ask the customer to confirm `CUSTOMER_DETAILS` and compare with the directory; on any mismatch reveal nothing and
    escalate with category `identity`.

The checks are instructions to the agent plus the trusted directory data; the bridge itself does not judge answers.

## Payments (staff-verified)

`PAYMENT_CHECK=staff` turns on the `report_payment` tool. When a customer says they paid, the agent records the claim (amount,
reference, method; never card numbers). The bridge stores it as **claimed**, alerts staff (event `payment_claimed`, see
[ALERTS.md](ALERTS.md)), and staff mark it `verified` or `rejected` (`{"action":"payment_verify","conversation_id":"c_...","value":"verified"}`).
The agent must never tell the customer a payment is confirmed until `business.payment.status` is `verified`. Off by default.

## Bookings and orders hook

`BOOKING_WEBHOOK_URL` (https) connects the owner's own system: a booking calendar, an order sheet, an automation. The agent calls
`submit_request` once the customer has confirmed the details:

```json
{ "event": "whatsapp_request", "kind": "order", "conversation_id": "c_...", "customer_number": "<digits>",
  "business_number_id": "...", "summary": "40 units of item A, pickup Friday", "fields": { "item": "A", "quantity": "40" },
  "at": "...", "idempotency_key": "order-1" }
```

- Headers: `Authorization: Bearer <BOOKING_WEBHOOK_KEY>` when set, and `Idempotency-Key: <conversation>:<key>`.
- The body includes the customer's full number because your system needs it to follow up; point the hook only at a system you control.
- A 2xx answer is success; a JSON `reference` (or `id`) in the answer is returned to the agent so it can quote it.
- The same `idempotency_key` after a success returns the stored result without a second POST.
- Failure (non-2xx or network): the agent gets `booking_hook_failed`, tells the customer a person will confirm, and escalates; the
  owner gets a `booking_failed` alert.

## Language

`BOT_LANGUAGE`: `auto` (default, answer in the customer's language) or preferred language codes, first = default (e.g. `ar,en`).
For spoken Arabic replies the dialect preset is `ARABIC_REPLY_DIALECT` ([VOICE-REPLIES.md](VOICE-REPLIES.md#arabic-dialect-presets)).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `BUSINESS_MODE` | `consumers` | `consumers`, `businesses` or `both` |
| `BOT_LANGUAGE` | `auto` | `auto` or language codes |
| `IDENTITY_CHECK` | `none` | `none`, `known_number`, `details` |
| `CUSTOMER_DETAILS` | (none) | Fields to collect, comma separated (max 10) |
| `PAYMENT_CHECK` | `off` | `staff` turns on staff-verified payment claims |
| `BOOKING_WEBHOOK_URL`, `BOOKING_WEBHOOK_KEY` (secret) | (unset) | The bookings/orders hook and its Bearer key |
