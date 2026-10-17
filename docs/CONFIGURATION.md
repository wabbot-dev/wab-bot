# Configuration reference

Endpoints, MCP tools, send guards and environment variables. Names only: values belong in your own Worker secrets or `[vars]`, never in this repository. `.env.example` lists every name.

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /` | none | health page, 200 `ok` |
| `GET /api/webhook` | `hub.verify_token` = `WA_VERIFY_TOKEN` | Meta handshake: 200 echo of `hub.challenge`, else 403 |
| `POST /api/webhook` | `X-Hub-Signature-256` HMAC (`WA_APP_SECRET`) over the **raw body bytes**, constant-time compare | 200 `{ok:true}`, 401 invalid signature (no storage touched), 400 bad json, **503 + `Retry-After: 2`** if the store stayed contended for the whole ~8 s retry budget (nothing applied), 500 real store/config error. Meta redelivers on non-200; wamid dedupe makes redelivery idempotent |
| `POST /mcp` | `Bearer MCP_TOKEN` | stateless MCP over Streamable HTTP (JSON responses, no SSE, no sessions); `GET`/`DELETE` answer 405 after auth |
| `GET/POST /api/admin`, `/admin` page | `Bearer ADMIN_TOKEN` | the page is static HTML (CSP, noindex, no polling); data needs the token (kept in `sessionStorage`). Actions: `set_auto_reply`, `takeover`, `release`, `release_hold`, `reopen`, `resolve`, `wake`, `delete_conversation` |
| `POST /api/setup` | one-time `SETUP_NONCE` in the JSON body | **self-provisioning:** stores `secrets` in the Durable Object and locks forever. 200 once; every later call 403; 400 on a bad body (nothing claimed); never echoes values. See "Self-provisioning secrets" |
| `GET/POST /api/admin/secrets` | `Bearer ADMIN_TOKEN` | names and sources only (GET); rotate or delete a stored value (POST) |
| `GET/POST /api/admin/meta-setup` | `Bearer ADMIN_TOKEN` | **404 unless the deployment variable `META_SETUP_ENABLED` is exactly `1`** (any other value, including `true`, keeps it off; it is not a managed secret, so `/api/setup` and `/api/admin/secrets` cannot turn it on). Prefer `scripts/meta-setup.mjs` on your own computer |
| `DELETE /api/admin/conversations/<id>` | `Bearer ADMIN_TOKEN` | **erase one conversation** (customer number, profile name, message text, reply records, wake log, lease) in one commit. 200 `{ok:true,deleted:true}`, 400 malformed id, 401, 404 unknown id (also on a second call), 405 other methods. Same effect as the admin action `delete_conversation`. See [PRIVACY.md](PRIVACY.md) |
| `POST /admin/mcp` | `Bearer ADMIN_MCP_TOKEN` (>= 32 chars) | **owner-only admin MCP** (14 tools, Streamable HTTP, stateless). **404 unless the secret binding `ADMIN_MCP_TOKEN` is set.** 401 bad token, 403 foreign `Origin`, 429 rate limited. See [mcp.md](mcp.md) |
| `POST /api/xai-sip` | Standard Webhooks signature from xAI, over the raw body | **voice calling webhook. 404 unless the owner gate is open** (`CALLING_MODE` is `test` or `live`); 401 unless a calling window is armed and the signature is valid. See [VOICE-CALLS.md](VOICE-CALLS.md) |
| `GET /api/cron/retry-wakes` | `Bearer CRON_SECRET` | manual trigger; the daily Cron Trigger calls the same retry pass directly |

Bearer secrets must be >= 16 characters (shorter or unset refuses everything), compared in constant time.

### MCP tools (each returns one JSON text block)
`list_pending`, `claim_conversation`, `get_history` (limit 1-50, default 20; customer text wrapped in `<untrusted_customer_text>`), `send_reply` (no `to` field; text <= 4000 or `template_name`, optional `template_language`, `template_params`, `idempotency_key`), `finish_conversation`, `release_conversation`, `escalate_conversation` (reason 1-500), `get_controls`, `get_overview`. No tool can change global controls. A store that stays busy yields `{"ok":false,"error":"store_busy","retryable":true}` (nothing applied; call again). Invalid arguments are JSON-RPC error -32602.

**`get_overview`** (no arguments, read-only; Bearer `MCP_TOKEN`, so a routine needs no admin token): one JSON block with `conversations` (`total`, `by_state` for `pending`/`claimed`/`replied`/`held_for_review`/`escalated`/`human_takeover`, `oldest_pending_age_seconds` + `oldest_pending_conversation_id`, `last_inbound_at`), `wake` (`failed_count`, `scheduled_count`, `earliest_next_retry_at`, `url_configured`, `key_present`, `auth_mode`, `debounce_ms`), `controls` (`launch_mode`, `auto_reply`, and only COUNTS for `TEST_RECIPIENTS`, `WA_TEMPLATE_ALLOWLIST`, `WA_PHONE_NUMBER_IDS`, plus `meta_setup_enabled`), `rejections` (bad-signature counter) and `secrets` (`setup_locked`, `present` / `missing` lists and the NAME -> `{source: env|stored|unset, kind: secret|setting}` map). It never returns message text, customer names or numbers, conversation leases, secret values, `WAKE_URL`, or the contents of any list-type setting, and it cannot change anything (it takes no input that is used). Cost: one store read (same as the admin overview), zero writes. An expired lease counts as `pending`, like `list_pending`. If the credential-name lookup fails, `secrets` is `null` and the rest is still returned.
The MCP endpoint is hand-written (initialize, ping, tools/list, tools/call) rather than built on an SDK, to keep per-request CPU low; it has been tested with direct JSON-RPC calls only, **not with real MCP clients**.

### `send_reply` guards, in order (exact `error` strings)
1 `not_found` -> 2 `blocked_human_takeover` -> 3 `blocked_held_for_review` -> 4 `lease_invalid_or_expired` -> 5 `unseen_inbound_messages` (+ `hint`, `unseen_messages[]`) -> 6 `blocked_auto_reply_paused` -> 7 `blocked_test_mode_recipient_not_allowlisted` (when `LAUNCH_MODE` is not `live`) -> 8 `template_not_allowlisted` | `empty_text` / `text_too_long` / `blocked_24h_window_closed_use_allowlisted_template` -> 9 idempotency: `ok:true idempotent_replay` / `previous_attempt_failed_definitively_use_new_idempotency_key` / `uncertain_previous_send_held_for_review` -> 10 `rate_limited_conversation` (5 per 10 min) -> 11 `not_configured_access_token_missing` -> 12 `concurrent_send_same_key` -> 13 `rate_limited_global` (60 per UTC hour) -> 14 lease + unseen re-checked atomically while reserving the slot -> 15 Meta 4xx (not 408/429): `send_rejected_http_{status}` (+ `meta_error_code`) -> 16 timeout (15 s) / 5xx / 408 / 429 / 2xx without wamid: `send_uncertain_held_for_review` (conversation becomes `held_for_review`, **never resent**).

## Configuration (names only; see `.env.example`)

Secrets (`wrangler secret put`, **or** self-provisioned through `POST /api/setup`, see [SELF-PROVISIONING.md](SELF-PROVISIONING.md); a real binding wins over a stored value): `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `MCP_TOKEN`, `ADMIN_TOKEN`, `CRON_SECRET`, `WAKE_KEY`, `XAI_API_KEY` (voice calling), and `WAKE_URL` if it embeds a key. `ADMIN_MCP_TOKEN` is a secret too but is **not** self-provisionable: set it yourself ([mcp.md](mcp.md)). Plain settings may go in `[vars]` in `wrangler.toml`.

| Name | Purpose |
|---|---|
| `WA_PHONE_NUMBER_IDS` | accepted phone number ids (empty = any id on the app; the signature is still required). Recommended |
| `WA_TEMPLATE_ALLOWLIST` | approved template names the agent may send (empty = none) |
| `GRAPH_VERSION` | default `v25.0` |
| `LAUNCH_MODE`, `TEST_RECIPIENTS` | `live` or test (default test); numbers allowed in test mode |
| `WAKE_URL` (**https only**, `http://localhost` for dev), `WAKE_KEY`, `WAKE_HEADER`, `WAKE_AUTH` (`bearer`/`header`) | where the content-free wake goes |
| `WAKE_DEBOUNCE_MS` (0-25000, default 8000), `WAKE_TYPES` | wake timing and which inbound types wake |
| `LEASE_MS`, `RATE_CONV_MAX`, `RATE_CONV_WINDOW_MS`, `RATE_GLOBAL_PER_HOUR`, `SEND_TIMEOUT_MS`, `MAX_MESSAGES`, `STALE_WAKE_MS` | tuning (defaults in `lib/config.ts`) |
| `SETUP_NONCE` (plain-text var, not a secret) | one-time key for `POST /api/setup`; >= 32 chars; unset or short = setup disabled |
| `META_SETUP_ENABLED`, `META_SETUP_DRY_RUN` | meta-setup route gate (default off) and its offline stub |

### Admin MCP and voice calling (bindings and vars; none of the gate settings can be set through any route or tool)

| Name | Purpose |
|---|---|
| `ADMIN_MCP_TOKEN` (secret) | enables `/admin/mcp`; >= 32 chars; unset = route is 404 |
| `XAI_API_KEY` (secret) | your own xAI key; calling only |
| `CALLING_MODE` | **owner gate.** `off` (default), `test` (answers only `CALL_ALLOWED_CALLERS`), `live` (needs the next two) |
| `CALLING_BV_DONE` | live only: `1` = you attest Meta Business Verification is complete |
| `CALLING_GO_NUMBER` | live only: digits of the one number you approve for calling |
| `CALLING_PHONE_NUMBER_ID` | which WhatsApp phone number id to arm (default: first of `WA_PHONE_NUMBER_IDS`) |
| `CALL_ALLOWED_CALLERS` | caller numbers (digits, comma separated) the agent answers; required in test mode |
| `CALL_MAX_SECONDS` (10-600, default 120 seconds per call), `CALL_BUDGET_SECONDS` (default 1200 seconds per UTC month) | spend caps; about $0.08 per minute at xAI, paid by you |
| `CALL_VOICE`, `CALL_LANGUAGE_HINT`, `CALL_DISCLOSE_AI` (default off), `CALL_RECORDING_LINE` (default off), `CALL_SIP_WEBHOOKS` (default off; test aid: SIP call webhooks on, logged by type and call id only), `CALL_BUSINESS_NAME`, `CALL_GREETING`, `CALL_INSTRUCTIONS` | the voice agent's persona and disclosure ([VOICE-CALLS.md](VOICE-CALLS.md)) |
| `CALL_TRANSCRIPTS` (default **on**; `0`/`false`/`no`/`off` = off), `CALL_TRANSCRIPT_RETENTION_DAYS` (1-365, default 30) | keep a text transcript of each call in your own Durable Object, expiring after the retention days. Never audio ([VOICE-CALLS.md](VOICE-CALLS.md#what-is-logged-and-stored)) |

Arm window limits (fixed in code): 1 to 60 minutes, 1 to 5 calls. The Worker also needs the `CALLS` Durable Object binding and migration `v2`, which `wrangler.toml` already declares; a Worker deployed before calling existed needs `--migrate-from v1` on `scripts/cf-api-deploy.mjs deploy` ([DEPLOY.md](DEPLOY.md)).
