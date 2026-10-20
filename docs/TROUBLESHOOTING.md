# Troubleshooting

Every symptom below comes from behaviour the code and tests implement or that was seen during the live runs listed in [STATUS.md](STATUS.md). Anything marked *unverified* has not been observed.

| Symptom | Cause | What to do |
|---|---|---|
| Meta cannot verify the webhook (403 on `GET /api/webhook`) | `hub.verify_token` differs from `WA_VERIFY_TOKEN` | Use the exact value. After a self-provisioned setup the stored value is the one Meta must send |
| Meta cannot reach the webhook, or the URL answers 404 right after a deploy | A new workers.dev route can take a short while to propagate (one transient `error code: 1042` was seen after a first deploy) | Wait a minute and re-run `bash scripts/smoke.sh <url>` (it already retries for up to 5 minutes by default) |
| `POST /api/webhook` returns 401 `invalid signature` | `WA_APP_SECRET` is missing, a placeholder, or not the app secret of the app that sends | Set the real app secret ([META-SETUP.md](META-SETUP.md)). Until it is set every real Meta webhook is rejected by design and nothing is stored. A Worker that holds the literal text `[REDACTED]` as its secret (a deploy tool that redacts values) is the same problem: use [SELF-PROVISIONING.md](SELF-PROVISIONING.md) |
| Setup stops with `new_app_required` (`app_in_use` or `webhook_app_level` FAIL) | The Meta app you used already serves another bot: its webhook callback points to another deployment. Default: one bot per Meta app | Nothing was changed. Create a new Meta app in the same business portfolio for this bot (its own webhook, app secret and system-user token) and re-run with its token ([META-SETUP.md](META-SETUP.md#one-bot-per-meta-app-a-second-bot-gets-a-new-meta-app)). Per-number override (`webhook_scope: "phone"`, `--phone-override`) only when one bot should answer several numbers |
| `POST /api/webhook` returns 503 `busy, retry` | The row stayed contended for the whole ~8 s retry budget; nothing was applied | Meta redelivers and de-duplication makes it idempotent. Frequent only for many simultaneous messages in the same conversation ([STATE-STORE.md](STATE-STORE.md)) |
| `POST /api/webhook` returns 500 `retry` | A real storage or configuration error | Check Workers Logs for the event name; check that the Durable Object binding and migration in `wrangler.toml` deployed |
| MCP tool returns `{"ok":false,"error":"store_busy","retryable":true}` | Same contention as above for an MCP call | Call it again; nothing was applied |
| `send_reply` returns `blocked_auto_reply_paused` | Auto-reply is paused (the default) | Activate it in `/admin` after a test round trip |
| `send_reply` returns `blocked_test_mode_recipient_not_allowlisted` | `LAUNCH_MODE` is not `live` and the number is not in `TEST_RECIPIENTS` | Add the test number, or go live deliberately |
| `send_reply` returns `blocked_24h_window_closed_use_allowlisted_template` | More than 24 h since the customer's last message | Send an approved template listed in `WA_TEMPLATE_ALLOWLIST` |
| `send_reply` returns `not_configured_access_token_missing` | `WA_ACCESS_TOKEN` is unset | Set it (secret or self-provisioned) |
| `send_uncertain_held_for_review` | Timeout, 5xx, 408/429 or a 2xx without a message id from Meta: the outcome is unknown | The conversation is held and the message is **never resent automatically**. Check `/admin` and Meta before replying by hand |
| The agent is never woken; conversations stay `pending` with a failed wake | `WAKE_URL` unset (seen live: `wake code=-1`), rejected (401/403), or the conversation is claimed, escalated, taken over or held | Test with `/admin` > Wake and read [WAKE-ROUTINE.md](WAKE-ROUTINE.md). Failed wakes back off from 1 minute up to 6 hours |
| A wake to a Worker on your own `workers.dev` fails with `error code: 1042` | A Worker cannot `fetch` another Worker on the same zone without the `global_fetch_strictly_public` compatibility flag | The flag is set in `wrangler.toml`; redeploy if you removed it |
| Many wake attempts in the logs while your agent URL is down | Each further inbound message for that conversation attempts another wake | Fix or remove `WAKE_URL`; this is a known limit |
| `/api/admin/meta-setup` answers 404 | It is off unless `META_SETUP_ENABLED` is exactly `1` | Prefer `scripts/meta-setup.mjs` on your own computer |
| `/api/admin/meta-setup` answers 401 | No or wrong `ADMIN_TOKEN` | The route makes no Meta call without a valid admin token |
| `POST /api/setup` answers 403 | Setup already ran (`setup_locked`), or the nonce is wrong | There is no unlock; tear down and redeploy to start over ([SELF-PROVISIONING.md](SELF-PROVISIONING.md)) |
| `DELETE /api/admin/conversations/<id>` answers 404 | Unknown id, or already erased | List ids in `/admin` |
| Past a Cloudflare Free daily limit, requests fail until 00:00 UTC | Free quota used up (error 1027 for Worker requests) | No automatic charge. Wait, reduce traffic, or move to Workers Paid yourself ([CLOUDFLARE.md](CLOUDFLARE.md)) |
| Voice notes show `[voice note, not transcribed]` / images `[image, not described]` | `get_overview` `media.last_failure_code`: `ai_3036` = the Workers AI free daily allowance is used up (until 00:00 UTC; nothing is billed on Free); `ai_5035` = the model needs Workers Paid (pick a Free model); `download_http_401` = the WhatsApp token expired or is wrong; `download_http_404` = the media id expired; `ai_timeout`; `media.ai_binding_present: false` = the Worker was deployed without the `[ai]` binding | Wait for the reset, fix the token or redeploy with the binding. The agent should ask the customer to type, as before. Nothing is retried ([MEDIA.md](MEDIA.md#fallbacks-and-counters)) |
| Voice notes show `[..., not transcribed: longer than 120 s]` or `file too large` | A cap was hit (`MEDIA_MAX_AUDIO_SECONDS`, `MEDIA_MAX_AUDIO_BYTES`, `MEDIA_MAX_IMAGE_BYTES`) | Raise the cap if you want; longer audio costs more of the daily allowance |
| `/api/admin/media-selftest` answers 404 | It is off unless `MEDIA_SELFTEST` is exactly `1` | Set it only while testing, then remove it |
| Voice replies arrive as text (`sent_as: "text"`, `voice_fallback`) | `voice_replies_off` / `mirror_mode_...`: the mode (`VOICE_REPLIES`); `voice_language_unsupported_ar`: no Workers AI voice speaks Arabic (set `VOICE_REPLY_PROVIDER=elevenlabs`); `voice_tts_el_quota` / `voice_tts_el_rate_limited`: ElevenLabs credits or rate limit; `voice_tts_el_auth`: `ELEVENLABS_API_KEY`; `voice_language_unknown`: pass `voice_language`; `voice_tts_ai_3036`: free allowance used up until 00:00 UTC; `voice_upload_http_401`: WhatsApp token | Expected fallbacks; see [VOICE-REPLIES.md](VOICE-REPLIES.md#fallbacks-and-counters) |
| A voice reply failed with `send_rejected_http_400` and `sent_as: "voice"` | Meta refused the voice note itself (counter `voice_send_rejected`) | Resend the same text with `reply_as: "text"` and a new `idempotency_key` |
| Calls: xAI answers 401/403 with `team_blocked` | The xAI team has no credits or hit its spending limit | Add credits in the xAI console yourself; do not retry in a loop ([VOICE-CALLS.md](VOICE-CALLS.md)) |
| `/admin/mcp` answers 404 | `ADMIN_MCP_TOKEN` is not set, or is shorter than 32 characters | Set it as a Worker secret yourself ([mcp.md](mcp.md)) |
| `/admin/mcp` answers 429 | Too many failed attempts from your address, or more than 60 calls in a minute | Wait for `Retry-After`; check the token |
| `arm_calling` answers `calling_gate_closed` | The owner gate is closed (`CALLING_MODE` off, or live without `CALLING_BV_DONE` and `CALLING_GO_NUMBER`) | Only you can change those Worker settings ([VOICE-CALLS.md](VOICE-CALLS.md)) |
| `arm_calling` answers `calling_already_enabled_on_number` or `number_already_registered_at_xai` | Meta calling or an xAI number registration was left over from earlier | Run `disarm_calling`, or clean up in the Meta and xAI consoles yourself |
| A call rings but nobody answers | Not armed, the caller is not in `CALL_ALLOWED_CALLERS`, the budget is spent, or xAI refused the source address | `calling_status`, `list_call_logs` (outcomes `rejected_*`); the Meta address list is a snapshot ([VOICE-CALLS.md](VOICE-CALLS.md)) |

## Common questions

**A call stays open after the assistant says goodbye.** The caller can end it with the normal end-call button; the transcript is saved either way.

**There is no transcript for a call.** Transcripts are on by default and kept for 30 days (`CALL_TRANSCRIPTS`, `CALL_TRANSCRIPT_RETENTION_DAYS`); check that `CALL_TRANSCRIPTS` is not `0`, `false`, `no` or `off`. Read one with `get_call_log` and `include_transcript` through the admin MCP. A call in which nobody spoke has no lines, and an expired transcript is removed by design.

**Messages are not arriving.** Meta must call `https://<your-worker>/api/webhook` with the same verify token as `WA_VERIFY_TOKEN`, and the app must be subscribed to `messages` ([META-SETUP.md](META-SETUP.md)). `bash scripts/smoke.sh <url>` checks the handshake and the signature rules from outside.

**Calls are not arriving.** The call webhook (`/api/xai-sip`) exists only while calling is armed: `arm_calling` registers your number at xAI for that window. Run `calling_status`, then `list_call_logs` to see whether a call was rejected and why (`rejected_not_armed`, `rejected_caller`, `rejected_budget`).

**`arm_calling` is refused or calling is not armed.** Calling is off until you set it. For a business number you set `CALLING_MODE=live`, `CALLING_BV_DONE=1` and `CALLING_GO_NUMBER`, and `arm_calling` must name that number. In test mode only numbers in `CALL_ALLOWED_CALLERS` are answered. A window lasts 1 to 60 minutes and 1 to 5 calls, then calling switches itself off ([VOICE-CALLS.md](VOICE-CALLS.md)).

**What does it cost?** The Cloudflare Free plan has no automatic charge ([CLOUDFLARE.md](CLOUDFLARE.md)). Voice calls use your own xAI credits, about $0.08 per minute when last read. Meta's own pricing applies to your WhatsApp use. `CALL_MAX_SECONDS` caps each call, `CALL_BUDGET_SECONDS` caps the month, and `get_usage_summary` and `calling_status` show usage.

Still stuck: open an issue with the release, the area and **redacted** logs. Never include tokens, app secrets, phone numbers or message text.
