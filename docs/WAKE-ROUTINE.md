# Waking your agent: the webhook routine (`WAKE_URL` / `WAKE_KEY`)

The bridge never talks to your agent directly. When a customer message arrives it sends ONE content-free POST (debounced, default 8 s):

```json
{"event":"whatsapp_conversation_pending","conversation_id":"…","pending_messages":2,"wake_at":"2026-10-15T18:00:00.000Z",
 "note":"Use the WAB bot MCP: list_pending / claim_conversation. No message content in this payload."}
```

to `WAKE_URL`, with `Authorization: Bearer <WAKE_KEY>` (default; `WAKE_AUTH=header` + `WAKE_HEADER=<name>` changes the header; the key may
also simply be part of `WAKE_URL`). Any 2xx counts as delivered; anything else is retried with backoff (see [STATE-STORE.md](STATE-STORE.md), "Wake / debounce").
The payload carries no message text: the agent reads the chat through the MCP tools.

## Setting it up (any agent platform that can be woken by a webhook)

1. Create a webhook-triggered automation in your agent platform with a prompt like:
   > A WhatsApp customer message is waiting in the bridge. Use the WAB bot MCP: list pending conversations, claim the one named in the
   > webhook event (or the oldest pending), read its history, answer according to the business policy using send_reply, then finish the
   > conversation. If anything is outside policy or sensitive, escalate it instead of answering. If the event names no pending conversation,
   > do nothing. The reply goes to the WhatsApp customer through the bridge; nobody else is messaged, and when nothing is pending there is no output.
2. Copy that automation's **webhook URL** and any **sender key** it shows. Treat both as secrets: never paste them in chat.
3. Store them in your Worker: `WAKE_URL` as a plain variable or secret (it must be `https://`; anything else is ignored and wakes are disabled), `WAKE_KEY` as a secret:
   `bash scripts/deploy-cloudflare.sh --set-secret WAKE_KEY` (hidden prompt, stdin only).
4. Point the agent's MCP configuration at `https://<worker>/mcp` with `Authorization: Bearer <MCP_TOKEN>`.
5. Test with `/admin` -> "Wake" on a test conversation (auto-reply stays paused and `LAUNCH_MODE=test`, so nothing is sent to customers) and confirm the automation run shows the event `whatsapp_conversation_pending`.
6. Only after Meta setup is complete and a test message round-trips: set `LAUNCH_MODE=live` and switch auto-reply to active in `/admin`.

Health and escalation routines (a morning check, an escalation sweep) do not need the admin token: the MCP tool `get_overview` (Bearer `MCP_TOKEN`, read-only) returns counts by conversation state (including held, escalated and taken over), the oldest pending age, failed wake counts, the launch mode and auto-reply state, and which credential names are present. It cannot change anything.

Any agent platform with a webhook trigger fits this shape: copy the URL and sender key the platform shows and store them as above.

## What is NOT known (unverified)

- **A real agent platform being woken by the bridge has not been observed.** The wake POST (content-free, bearer key, debounce, retry) was verified live against a stand-in receiver on a test Worker; in the Meta test round trip no `WAKE_URL` was configured, so the wake failed as expected and the operator drove MCP by hand ([STATUS.md](STATUS.md)).

- Which header your platform's webhook expects for the sender key varies. The bridge covers the common shapes
  (`Authorization: Bearer`, raw `Authorization`, custom header via `WAKE_HEADER`, or a key embedded in the URL). If a test wake returns 401/403, switch
  `WAKE_AUTH` / `WAKE_HEADER` to what your platform shows.
- Whether your platform's webhook accepts a body this size/shape and how it renders the JSON inside the event.
- Delivery semantics (retries, duplicates): the bridge already assumes wakes can arrive twice and the claim/lease logic is idempotent per conversation.
