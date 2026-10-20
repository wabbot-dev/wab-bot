# Privacy and data retention (WAB bot)

This describes what WAB bot stores in **your** deployment. It is not legal advice. You are the data controller for your customers' data and must comply with the laws and platform terms that apply to you, including Meta's terms, which restrict using WhatsApp Business message data to train AI models.

## What is stored, and where

All state lives in one SQLite-backed Durable Object in your own Cloudflare account, one row per key:

| Data | Contains personal data? |
|---|---|
| Conversations (`conv/<id>`): customer WhatsApp number (`wa_id`), profile name if Meta sends it, message text (up to `MAX_MESSAGES`, default 50 per conversation), outbound reply records, wake log | **Yes** |
| De-duplication ids (hashed, last 200 per conversation), rate counters, controls (pause, mode) | No customer content |
| Rejected-webhook counter | No |
| Self-provisioned secrets and the setup lock, if you used `POST /api/setup` ([SELF-PROVISIONING.md](SELF-PROVISIONING.md)) | Credentials, not customer data. Kept in their own tables, apart from conversations |

Not stored: media files (raw audio, images, video and documents are never stored) and message bodies in logs. Voice notes and images are, by default, turned into text with Workers AI in your own Cloudflare account and that text (a transcript, or a description plus the caption) is stored on the message like typed text, and erased with the conversation; switch it off with `MEDIA_TRANSCRIBE=0` / `MEDIA_DESCRIBE=0` ([MEDIA.md](MEDIA.md#safety-and-privacy)). Video and documents arrive as type and caption only. Optional voice-note replies (off by default, [VOICE-REPLIES.md](VOICE-REPLIES.md)) speak the agent's reply text with Workers AI or, with `VOICE_REPLY_PROVIDER=elevenlabs`, ElevenLabs (the reply text, not the customer's message, is then sent to ElevenLabs; check its data policy); the audio is uploaded to Meta to be sent and is never stored by the bridge, and the reply text is stored as usual. The WhatsApp access token lives in your Worker secrets (or, if self-provisioned, in the Durable Object's secret table) and is never given to the agent.

Logs carry ids and counters only: no message text, names, phone numbers or tokens. `tests/extras.test.ts` includes a log-hygiene test. Workers Logs are enabled in `wrangler.toml` (ids and counters only); remove the `[observability]` block if you prefer no logs.

## Who can read it

- Anyone holding your `ADMIN_TOKEN` (the `/admin` console and `/api/admin`) or your `MCP_TOKEN` (the conversation tools return customer text), and anyone with access to your Cloudflare account, who can also deploy code that reads the storage.
- Your agent and its model provider see whatever the MCP tools return. Check that provider's data policy. History text is wrapped in `<untrusted_customer_text>` so the agent can tell it from instructions.
- Cloudflare hosts the data as your processor under its terms ([CLOUDFLARE.md](CLOUDFLARE.md)). Workers Free has no data-residency guarantee.

## Opt-out

A customer who sends STOP (or UNSUBSCRIBE, ARRET, ARRÊT, إيقاف) is marked opted out on their conversation; START clears it. While opted out, the bot can still answer a message the customer sends, but it cannot start a conversation (reminders, follow-ups). Staff can set or clear the flag in the team inbox. Details: [CONFIGURATION.md](CONFIGURATION.md#opt-out-stop--start).

## Retention

- *Replied* conversations idle for 14 days keep only the last 10 messages (de-dup ids and outbound records are dropped). **Any** conversation idle for 180 days is dropped, whatever its state.
- Compaction happens when a row is written; idle conversations are handled by a daily pass (Cron Trigger, `0 5 * * *` by default) that examines up to 100 least-recently-written conversations per run.
- Cloudflare keeps Durable Object point-in-time-recovery copies for a period that Cloudflare controls (up to 30 days at the time of writing). Erased or expired data can persist in those copies; this template cannot shorten that.

## Deleting data

- **One conversation:** `DELETE /api/admin/conversations/<id>` with `Authorization: Bearer <ADMIN_TOKEN>`, or the "Delete data" button in `/admin`, or the admin action `delete_conversation`. It removes the customer number, profile name, message text, reply records, wake log and lease in one commit. It answers 200 `{ok:true,deleted:true}`, 400 for a malformed id, 401 without the token and 404 for an unknown id (including a second call). It is covered by tests ([STATUS.md](STATUS.md)); it has not been run against a live deployment.
  - It does **not** touch global controls, the bad-signature counter, Workers Logs (ids and counters only) or Durable Object recovery copies.
  - If Meta redelivers an old message after the erase, the de-dup ids are gone too, so the conversation can be recreated with that message.
  - Ask the customer to be identified by conversation id; list ids in `/admin`.
- **Everything:** `bash scripts/teardown-cloudflare.sh` (asks you to type the Worker name) deletes the Worker and every stored conversation. It deletes nothing else.
- Do not delete the Durable Object by hand while the bridge is live.

## Calls

Voice calling ([VOICE-CALLS.md](VOICE-CALLS.md)) is off by default. When you use it, the call log keeps metadata (time, duration, outcome, who ended the call, turn counts, the last two digits of the caller's number) for 90 days, and **by default a text transcript of each call** (what the caller and the agent said) for 30 days, in your own Durable Object only. Set `CALL_TRANSCRIPTS=0` to keep no transcripts, and `CALL_TRANSCRIPT_RETENTION_DAYS` (1 to 365) to change the 30 days. No audio is ever stored by this code (it cannot see the caller's audio; see [VOICE-CALLS.md](VOICE-CALLS.md#audio-recording-researched-not-supported)), and the xAI call id is not kept. A transcript can contain whatever the caller says, including names, numbers and health or payment details they volunteer. **Recording consent:** many places require telling callers before a call is recorded or transcribed, and some require consent; use `CALL_RECORDING_LINE=1` or your own greeting, and follow the rules of your country, which are yours. The audio itself goes through xAI under xAI's terms. The owner can read a transcript through the admin MCP (`get_call_log` with `include_transcript`, contact details masked by default) and erase a call and its transcript with `erase_call_log`; erased data can still exist in Cloudflare's point-in-time-recovery copies for the platform's recovery window. The admin MCP ([mcp.md](mcp.md)) shows conversation metadata with numbers masked to two digits and never customer message text.
