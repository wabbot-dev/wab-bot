# Security Policy (WAB bot)

## Supported versions

Security fixes are provided for the latest tagged release. Upgrade before reporting a problem that may already be fixed.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

Use **Report a vulnerability** in this repository's **Security** tab (GitHub private vulnerability reporting).
Include the release/commit, what you did, the impact, and a minimal reproduction.

Never include real tokens, app secrets, customer phone numbers or message content in a report. Redact them first. Remove local paths and unrelated account details too.

The maintainer will acknowledge the report, assess its scope and coordinate remediation and disclosure timing with you. Please allow time to reproduce safely.

## Security boundary (what WAB bot is designed to guarantee)

- One deployment per business: its own Meta app, number, tokens and its own Cloudflare account (Worker + Durable Object). Nothing is shared.
- Webhook POSTs are accepted only with a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time compare).
- `/mcp`, `/api/admin*` and the cron route require their own bearer secrets (min 16 chars, constant-time compare, fail closed when unset).
- `POST /api/setup` (self-provisioning) works once: constant-time nonce check, validation before the atomic claim in the Durable Object, then 403 forever; values are stored in Durable Object SQLite (no extra application-level encryption: the Cloudflare account is the trust boundary), never logged or returned. A real Worker binding always wins over a stored value. Details and limits: [docs/SELF-PROVISIONING.md](docs/SELF-PROVISIONING.md).
- `GET /api/health` is unauthenticated and static: it returns only `{ok, version}` (the package version, which is public in this repository), reads no storage and no secret, and carries no counts or message data.
- The agent's MCP token can call `get_overview`, a read-only health snapshot (counts, ages, secret NAMES and sources, never values, message text, numbers or leases); no MCP tool can change controls or delete data.
- The agent never receives the WhatsApp access token; the bridge sends on its behalf and enforces every send guard server-side.
- Logs carry IDs and counters only: no message bodies, names, phone numbers or tokens.
- Secret values are never returned. Tools report only whether a secret is set; every MCP tool result, error message and log line also passes a key-shape filter (API keys, bearer tokens, webhook secrets) as a backstop, and tests fail if any output carries one. Secrets go in only through masked input fields or environment bindings, never into chat, logs or tool output. If a secret is ever exposed, rotate it.
- `/api/admin/meta-setup` can mint a non-expiring token, so it is off (404) unless the deployment variable `META_SETUP_ENABLED` is exactly `1`; secrets management cannot turn it on.
- `/admin/mcp` is an owner-only MCP server, 404 unless the secret binding `ADMIN_MCP_TOKEN` is set; it returns metadata only and no secrets. Voice calling is off unless the owner sets Worker variables no tool can change. Threat model below.
- One conversation can be erased on request (`DELETE /api/admin/conversations/<id>`, admin token). Erase does not reach Durable Object recovery copies ([docs/PRIVACY.md](docs/PRIVACY.md)).

This is not a sandbox and has not been independently audited. It does not protect against someone who controls your Cloudflare account (they can deploy code that reads every secret and conversation), and the MCP and admin tokens are bearer secrets: anyone who holds one has its full access. What has and has not been exercised live is in [docs/STATUS.md](docs/STATUS.md).

## Admin MCP and voice calling: threat model

What this adds: a second MCP server for the owner (`/admin/mcp`, [docs/mcp.md](docs/mcp.md)) and an inbound voice-calling path (`/api/xai-sip`, [docs/VOICE-CALLS.md](docs/VOICE-CALLS.md)). Both are off by default.

| Threat | Control | Residual risk |
|---|---|---|
| Someone finds `/admin/mcp` and guesses the token | Route is 404 unless the secret binding `ADMIN_MCP_TOKEN` is set (at least 32 chars); constant-time compare; fail closed; 10 failed attempts per client per 5 minutes then 429, counted in memory and in the Durable Object | The limit is per client address and best effort across Worker instances. A long random token makes guessing infeasible; a short or reused one does not |
| The token leaks (chat, ticket, logs) | The route never logs or returns it; every tool result passes a redactor for all configured secrets; the token is a binding only, not part of self-provisioning, so no tool can read or set it | Whoever holds the token has all 13 tools. Rotate by setting a new secret. No scopes, no per-tool tokens |
| A web page makes a visitor's browser call the route (DNS rebinding, CSRF) | A request with an `Origin` that is not the Worker's own origin gets 403; the bearer header is not sent by browsers on their own | None known for browsers; non-browser clients are not constrained by `Origin` |
| A compromised or confused agent uses the admin MCP to leak or destroy data | Read tools return metadata only: no message text, no names, numbers masked to two digits, no leases; erase needs `confirm` equal to the id and works on one conversation at a time; tool annotations mark destructive tools | An agent that holds the token can erase conversations one by one and can arm calling inside the owner gate. Give the admin token only to what you would give the admin page |
| Tool arguments carry injection or oversized input | One schema per tool drives validation and the published JSON schema: types, ranges, patterns, max lengths, unknown keys rejected, 16 KB body cap, batch cap 5 | Free text is limited to ids and short confirmations; there is no tool that evaluates input |
| An agent or script turns calling on without the owner | The gate is Worker variables only (`CALLING_MODE`, `CALLING_BV_DONE`, `CALLING_GO_NUMBER`); no route or tool reads them as input; webhook is 404 while off; live mode needs the owner-approved number named in `arm_calling` | Whoever controls the Cloudflare account can change the variables, as for every other secret |
| Calling is left open and a stranger rings the number | Arming opens a short window (1 to 60 minutes, 1 to 5 calls) that closes after the last call, by a Durable Object alarm, and by the daily cron; the xAI side checks Meta's source addresses and the digest password; the Worker verifies a Standard Webhooks signature with a secret that exists only inside the window; test mode answers only listed callers | A window is open for its length: callers can ring during it. Keep windows short and use `CALL_ALLOWED_CALLERS` |
| Cost abuse (long calls, many calls) | `CALL_MAX_SECONDS` per call (default 120 s), `CALL_BUDGET_SECONDS` per UTC month (default 1200 s), call-count limit per window; the importer's own xAI credit is the hard ceiling | The caps are enforced by this Worker; xAI bills what xAI measures. Set a spend limit in the xAI console |
| Fake webhook to `/api/xai-sip` | 404 while the gate is closed; signature checked over the raw body before parsing, 300 s replay window, per-call id de-duplication | The signing secret is stored in the Durable Object during the window and deleted on disarm |
| Call content leaks | No audio is stored and the Worker never touches audio; call logs hold metadata and the last two digits of the caller; xAI's call id is never stored or returned. **Transcripts (text) are stored by default** (`CALL_TRANSCRIPTS`, owner setting) in the importer's own Durable Object in a separate row that expires after `CALL_TRANSCRIPT_RETENTION_DAYS` (default 30); they are readable only through the owner-only admin MCP (`get_call_log` with `include_transcript`: contact details masked by default, secrets scrubbed, labelled untrusted caller speech), never listed, and removable with `erase_call_log` | xAI processes the audio under its own terms. A transcript holds whatever callers say; anyone with the admin MCP token or the Cloudflare account can read it. Recording and transcription consent is the importer's legal duty (`CALL_RECORDING_LINE`, own greeting). Platform point-in-time-recovery copies are not erased |
| A caller talks to the transcript reader (prompt injection through spoken words) | The transcript is returned inside a field labelled `untrusted_caller_speech`; the tool description tells the client to treat it as data; no tool can arm calling without `confirm`, and the gate is Worker settings only, so injected text cannot open it | An MCP client that ignores the label can still be misled; keep a human in the loop for destructive tools |
| Meta IP allowlist is stale | The snapshot is checked into the repository and documented as a snapshot | A stale list can make xAI refuse real Meta calls; it never admits non-Meta sources, because xAI still requires the digest password |

Not covered: someone who controls your Cloudflare account; xAI or Meta compromise; a stolen token before you rotate it; the safety of the voice model's answers (it follows the instructions you give it and can be wrong).

## Out of scope / your responsibility

Your Meta/WhatsApp policy compliance, your Cloudflare plan terms, and the secrets you put in your own Cloudflare Worker.
