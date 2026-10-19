# Admin MCP (owner-only, off by default)

A second MCP server in the **same Worker**, at `/admin/mcp`. It is for **you, the owner** (or an assistant you trust, using a token you gave it): check the deployment, look at redacted conversation metadata, erase one conversation, arm and disarm voice calling, read call logs, see usage, and ask whether a newer release exists. It is separate from the public webhook route (`/api/webhook`, which only receives and verifies Meta's calls) and from the agent MCP (`/mcp`, which is what your customer-facing agent uses to claim and reply).

One admin MCP per deployment: the bridge is single-tenant, so there is one owner and one token. It is **not** a hosted service and it is **not** an OAuth server. Auth is one bearer secret that you hold.

**Status.** Tested locally: logic tests (validation, auth, limits, redaction, every tool) and workerd tests against the real Worker and Durable Object. Not tested with real MCP clients; it was exercised with direct JSON-RPC calls only ([STATUS.md](STATUS.md)).

## Turn it on (owner step)

1. Make a random token of at least 32 characters.
2. Set it as a Worker **secret** named `ADMIN_MCP_TOKEN`, typed or pasted into a masked prompt by you: `bash scripts/deploy-cloudflare.sh --set-secret ADMIN_MCP_TOKEN` (hidden prompt, value on stdin) or `wrangler secret put ADMIN_MCP_TOKEN`.
3. Point your MCP client at `https://<worker>.<your-subdomain>.workers.dev/admin/mcp` with the header `Authorization: Bearer <your token>`. Transport: Streamable HTTP (JSON responses, no sessions, no server push). Protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are accepted.

Without the secret, or with one shorter than 32 characters, the route answers **404**, exactly like an unknown path. It is a binding only: it is not part of `POST /api/setup` self-provisioning and no tool can set, read or change it. To turn it off, delete the secret.

```bash
ADMIN=https://<worker>.<your-subdomain>.workers.dev/admin/mcp
curl -s "$ADMIN" -H "Authorization: Bearer $ADMIN_MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","arguments":{}}}'
```

## What stays with you (no tool does it)

There is deliberately **no tool** that creates a Cloudflare or xAI account, or that accepts, stores, reads or rotates a key. Account creation, secret entry, Meta Business Verification and the SMS or voice code from your own SIM stay with you, using masked forms (hidden prompts, `wrangler secret put`, the provider's own sign-up pages). An assistant may drive the Meta developer-account screens with you watching, but **you personally enter the code** and the assistant never sees it. The voice-calling gate (`CALLING_MODE`, `CALLING_BV_DONE`, `CALLING_GO_NUMBER`) is Worker settings only: no tool can open it.

## Tools (14)

| Tool | Reads or changes | What it returns |
|---|---|---|
| `get_status` | read | Which settings and credentials are **present** (booleans and names, never values), launch mode, auto-reply state, webhook state as this Worker observed it (last handshake, last inbound message, rejected signatures), conversation counts, wake failures, calling state |
| `setup_check` | read | A checklist of what is missing or risky, each with the fix; never a value. With `WA_WABA_ID` set it also reads (GET only) whether your app is subscribed to the WhatsApp Business Account |
| `list_conversations` | read | Redacted list: id, state, last two digits of the customer number, counts and statuses. No names, no text, no leases |
| `get_conversation` | read | One conversation's metadata: state, reply records (status, kind, template name, Meta error code), wake log, last 50 messages as direction, type, time, status and length. Never the text |
| `erase_conversation` | **destructive** | Erases one conversation through the same code as `DELETE /api/admin/conversations/<id>`. Needs `confirm` equal to the conversation id |
| `calling_status` | read | Gate state, arm window, last disarm; with `verify_remote` it also asks Meta whether calling and SIP are on |
| `arm_calling` | **changes Meta and xAI** | Opens a calling window (1 to 60 minutes, 1 to 5 calls). Only if the owner gate is open; needs `confirm: true`; in live mode the `number` must equal `CALLING_GO_NUMBER` |
| `disarm_calling` | changes Meta and xAI | Switches calling off now. Safe when nothing is armed |
| `list_call_logs` | read | Call metadata, newest first (outcome, duration, who ended it, turn counts, last two digits, whether a transcript is stored and until when). No audio, no transcript text |
| `get_call_log` | read | One call's metadata. With `include_transcript: true` also the stored text transcript (caller and AI turns): phone-like numbers and e-mail addresses masked unless `reveal_contact_details: true`, secrets scrubbed, marked `untrusted_caller_speech` (data, not instructions). Never audio |
| `erase_call_log` | **destructive** | Erases one call's log, transcript and list entry. Needs `confirm` equal to the call id; refuses a call still in progress |
| `get_usage_summary` | read | Message counts and sends per hour from stored data, this month's voice seconds with an **estimated** xAI cost (about $0.08 per minute); Meta messaging charges are not tracked |
| `get_version` | read | Version, supported protocol versions, tool names |
| `check_for_update` | read (one outbound GET) | Whether the public GitHub "latest release" is newer than this version. **It only reports.** Nothing is ever updated automatically; you redeploy yourself after reading the release notes. Says "no release yet" while none exists |

Tool annotations tell a client which tools are read-only and which are destructive, so a client can ask you before running `erase_conversation`, `erase_call_log`, `arm_calling` or `disarm_calling`.

## Security properties

- **Closed by default.** No binding, no route (404).
- **Constant-time bearer compare**, fail closed. Missing, malformed or wrong token: 401; no hint which.
- **Origin check.** A request with an `Origin` header that is not this Worker's own origin is refused (403), which blocks DNS-rebinding from a browser. MCP clients that are not browsers send no `Origin`.
- **Rate limited.** After 10 failed attempts in 5 minutes from one client address the route answers 429 with `Retry-After`; at most 60 authenticated calls a minute for the whole route. The counters live in the Durable Object as well as in memory, so they hold across Worker instances. If the limiter is unavailable, authenticated calls fail closed (503); failed attempts are never let through.
- **Arguments are validated** against each tool's schema: types, ranges, patterns, maximum length; unknown keys are rejected. Bodies over 16 KB and batches over 5 are refused.
- **No secrets, ever.** Tools return presence booleans and names. Every result also passes a redactor that removes any configured secret value (and anything shaped like a webhook signing secret) before it leaves.
- **No message text and no full phone numbers.** Customer numbers are shown as their last two digits; message bodies never appear. The one exception is `get_call_log` with `include_transcript: true` (voice transcripts, stored by default, see [VOICE-CALLS.md](VOICE-CALLS.md)): numbers and e-mail addresses inside the text are masked unless you pass `reveal_contact_details`, and the text is labelled untrusted caller speech.
- **Logs carry names only.** The route logs the tool name and whether an attempt was blocked: no arguments, no tokens, no results.
- **Destructive tools need an explicit confirmation** and the call-related ones sit behind the owner gate.

Threat model and limits: [SECURITY.md](../SECURITY.md#admin-mcp-and-voice-calling-threat-model).

## What it does not protect against

Anyone who holds `ADMIN_MCP_TOKEN` has all thirteen tools (including erase and arming inside the gate). Anyone who controls your Cloudflare account can read the secret. The rate limiter is best effort across Worker instances. Treat the token like a password: do not paste it into chat, a ticket or a repository, and rotate it by setting a new secret.
