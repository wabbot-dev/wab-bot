# Roadmap

This page lists what is deliberately not in v0.1.0 and what is planned. Nothing here is a promise or a date. Order may change.

| Item | State | Notes |
|---|---|---|
| Run the calling code on a verified business number | Open | The code in this repository was run live on Meta's test number on 2026-10-17; a business-verified production number has not been tested ([VOICE-CALLS.md](VOICE-CALLS.md)) |
| Test the admin MCP with real MCP clients | Open | Tested with direct JSON-RPC calls only ([mcp.md](mcp.md)) |
| Outbound calls | Not supported, not promised | Needs Meta call permission handling and a provider path nobody has verified |
| Audio recording on the SIP path | Not supported, not promised | Researched 2026-10-17: xAI documents no recording or audio-download option for API SIP calls, and the caller's audio never reaches the Worker ([VOICE-CALLS.md](VOICE-CALLS.md#audio-recording-researched-not-supported)) |
| Call transcripts (text) | In the code; run live on Meta's test number on 2026-10-17 (both sides stored) | On by default (`CALL_TRANSCRIPTS`), 30 days, own Durable Object, readable and erasable through the admin MCP. The event shapes were checked against xAI's real realtime socket with a non-SIP probe, not on a SIP call |
| Voice providers other than xAI Grok Voice | Not planned | The voice architecture is Grok Voice (xAI) only for now |
| Custom (cloned) voices | Possible future option | An xAI console feature; creating one through the API needs xAI's Enterprise plan; not available in this project |
| Settings page for importer options (disclosure, recording line, voice, language) | Deferred to a later version | Options are configuration values today |
| Preset routines (ready-made flows by business type) | Planned with a later marketplace version | Not included |
| First live run with a business-owned number, a template and a woken agent | Open | The gate for dropping the preview label |
| Run the wrangler login deploy path live | Open | Only dry-run so far |
| Retention pass over more than 100 conversations per run | Open | Known limitation |
| Media download | Not planned for v0.1 | Type and caption only |

Want something here sooner, or something that is not listed? Open a [design discussion](https://github.com/wabbot-dev/wab-bot/issues/new?template=design_discussion.yml) or a feature request, starting from the problem. Read the [contribution scope](../CONTRIBUTING.md#contribution-scope) first.
