# Voice-note replies (optional, off by default)

**Status: released in 0.3.0 (preview), off unless the owner sets `VOICE_REPLIES`.** Evidence is listed at the end of this page; read
[STATUS.md](STATUS.md) for the overall picture.

With voice replies on, the agent's text reply can also go out as a **WhatsApp voice note** (the bubble with a play button and waveform),
spoken by [Workers AI](https://developers.cloudflare.com/workers-ai/) text-to-speech in **your own Cloudflare account**. The text is always
stored in history, and **any** problem sends the plain text instead. Inbound voice notes and images are covered in [MEDIA.md](MEDIA.md).

## Modes

| `VOICE_REPLIES` | What happens |
| --- | --- |
| `off` (default) | Text only. A `reply_as: "voice"` request is answered with the text and `voice_fallback: "voice_replies_off"`. |
| `mirror` (recommended) | A reply is spoken **only when the customer's latest message was a voice note**. Customers who type get text. |
| `on` | Like `mirror`, and the agent may also ask for a voice note on a typed conversation with `reply_as: "voice"`. |

The agent can always force text with `reply_as: "text"`. Templates are never spoken. `mirror` recognises a voice note by its stored marker (`[voice note, ...]`), so it needs `MEDIA_TRANSCRIBE` on (the default); with transcription off, inbound voice notes are stored as `[audio without text]` and replies stay text.

## How it works

1. `send_reply` runs every guard first, exactly as for text: lease, unseen messages, human takeover, held for review, auto-reply paused,
   the test-mode recipient list, the 24-hour window, the idempotency key and both rate limits. A refused send never reaches text-to-speech.
2. The language is chosen: the writing system of the text wins when it is not Latin (an Arabic reply is never read by an English voice),
   then the agent's `voice_language`, then the language Whisper detected on the customer's voice note.
3. A Durable Object (`voice-note-encoder`, an instance of the existing call class that holds no call and no storage) asks the model for
   speech and encodes it to **Ogg Opus, mono, 16 kHz, 24 kbit/s, 20 ms frames**: the only format WhatsApp shows as a voice-note bubble
   (`audio/ogg; codecs=opus`). Workers cannot run ffmpeg, so the bridge carries a small WebAssembly encoder (below).
4. The file is uploaded to this number's own Meta media store with the stored token, then sent as `type: "audio"` with `voice: true`.
5. History keeps the reply as `type: "audio"` with the **full text**; the send result says `sent_as: "voice"`.

Nothing is retried. Audio is never written to storage or logs; only short codes and counts are logged.

## Models and languages

| Model | Languages | Cost (Neurons) | Notes |
| --- | --- | --- | --- |
| `@cf/myshell-ai/melotts` (default) | English, French, Spanish, Chinese, Japanese, Korean | 18.63 per audio minute | Returns 16-bit PCM WAV (observed; documented as MP3, both are handled) |
| `@cf/deepgram/aura-1` | English | 1,363.64 per 1,000 characters | Can return Ogg Opus directly (no encoding) |
| `@cf/deepgram/aura-2-en` / `aura-2-es` | English / Spanish | 2,727.27 per 1,000 characters | Same |

**Arabic is not supported:** no Workers AI text-to-speech model speaks Arabic today, so Arabic replies always go as text
(`voice_fallback: "voice_language_unsupported_ar"`). The same holds for any language a model lacks. Sources:
[melotts](https://developers.cloudflare.com/workers-ai/models/melotts/), [aura-2-en](https://developers.cloudflare.com/workers-ai/models/aura-2-en/),
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

**Cost.** With MeloTTS a 10-second reply is about 3 Neurons. The free 10,000 Neurons per day (reset 00:00 UTC) are shared with
transcription and image descriptions; on the Workers Free plan, use past the allowance fails (error 3036) and the text is sent instead. It
is never billed. On Workers Paid, use past the allowance is billed at $0.011 per 1,000 Neurons.

## The encoder and the CPU budget

- `lib/wasm/voice-opus.wasm` (about 410 KB, about 190 KB gzipped) is built from **libopus 1.5.2** (BSD-3-Clause), the **speexdsp 1.2.1**
  resampler (BSD-3-Clause) and **minimp3** (CC0), with wasi-sdk. It decodes WAV or MP3, mixes down to mono, resamples to 16 kHz and
  Opus-encodes. `lib/voice-encode.ts` writes the Ogg container. Notices: `lib/wasm/THIRD-PARTY-NOTICES.txt`. Rebuild from pinned,
  checksummed sources with `bash scripts/build-voice-wasm.sh` (source: `native/voice-opus/voice.c`).
- The Worker bundle grows from about 305 KiB to about 730 KiB (274 KiB gzipped). Workers allow 64 MiB on every plan.
- **CPU.** Encoding costs about 5.5 ms of CPU per second of audio (Opus complexity 0). A Workers Free request gets 10 ms of CPU, which is
  too little, so speech and encoding run in a Durable Object invocation, which gets 30 s of CPU per invocation. Measured live on a Free-plan
  test Worker: the Durable Object used 43 to 49 ms for a 5-second reply and 175 ms for a 21-second reply. The Worker request around it used
  5 to 7 ms (14 ms in one run that also read back Meta's metadata). Replies are capped at 45 s of audio (`VOICE_MAX_SECONDS`).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `VOICE_REPLIES` | `off` | `off`, `mirror` (recommended) or `on` |
| `VOICE_TTS_MODEL` | `@cf/myshell-ai/melotts` | A model from the table above |
| `VOICE_MAX_CHARS` | 400 (20 to 1500) | Longer replies go as text |
| `VOICE_MAX_SECONDS` | 45 (5 to 120) | Longer audio goes as text; WhatsApp shows the play button only up to 512 KB |
| `VOICE_TIMEOUT_MS` | 15000 (2000 to 20000) | Text-to-speech timeout |

`send_reply` takes two optional fields: `reply_as` (`auto` by default, `text` or `voice`) and `voice_language` (two letters, for
example `en`).

## Fallbacks and counters

The send result carries `sent_as` (`voice` or `text`) and, when a wanted voice note went as text, `voice_fallback` with a short code.
`get_overview` → `media` shows `voice_replies`, `voice_tts_model`, `voice_languages`, `voice_speaker_present`, the caps, and the counters
`voice_sent`, `voice_fallback` (with `voice_tts_failed`, `voice_encode_failed`, `voice_upload_failed`, `voice_language_unsupported`),
`voice_send_rejected`, `voice_seconds` and `voice_chars`. The speech cost is included in `estimated_neurons_today`.

| Code | Meaning | What happens |
| --- | --- | --- |
| `voice_language_unsupported_xx` | No voice for that language (Arabic: `_ar`) | Text sent |
| `voice_language_unknown` | Latin text, no `voice_language`, and no detected language | Text sent; pass `voice_language` |
| `voice_too_long` | Over `VOICE_MAX_CHARS`, `VOICE_MAX_SECONDS` or 500 KB | Text sent |
| `voice_tts_ai_3036` | Daily free allowance used up | Text sent until 00:00 UTC |
| `voice_tts_ai_timeout`, `voice_tts_ai_xxxx`, `voice_tts_empty` | Model error | Text sent |
| `voice_encode_*` | Encoder error | Text sent |
| `voice_upload_http_xxx` | Meta refused the upload (401: token) | Text sent |
| `voice_send_rejected` (counter) | Meta refused the voice-note message itself | **Nothing** sent; the result says so, and the agent resends as text with a new key |

## Safety

- Every send guard runs before any text-to-speech call; replays with the same idempotency key never speak again.
- The text spoken is the agent's own reply; markdown marks and links are stripped before speaking (links stay in the stored text).
- The WhatsApp token goes only to `graph.facebook.com`. The uploaded file stays in Meta's media store like any WhatsApp media (Meta keeps
  uploads for 30 days).
- No audio is stored or logged by the bridge.

## Owner self-test route

`POST /api/admin/voice-selftest` answers 404 unless `MEDIA_SELFTEST=1` (the same switch as the media self-test) and needs the owner
token (`ADMIN_TOKEN`). The body is the reply text.

```bash
curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary 'Your order is ready.' \
  "https://<worker>/api/admin/voice-selftest?lang=en&upload=1"      # speak, encode, upload; nothing is sent
```

Options: `where=worker` encodes in the request itself (to see the per-request CPU limit), `audio=1` returns the Ogg file, and
`send=1&to=<digits>` sends **one** real voice reply through the full `send_reply` path to a `TEST_RECIPIENTS` number, in test mode only, on a
self-test conversation that is erased afterwards. Remove `MEDIA_SELFTEST` when done.

## Evidence

- **Tested locally**: `tests/voice.test.ts`: the real WebAssembly encoder on WAV (four rates, mono and stereo) and MP3, the caps and junk
  input, Ogg page checksums and end trimming, modes, language choice, Arabic fallback, model, upload and length fallbacks with counters, guards
  before any model call, replays, Meta refusing the voice note, and the self-test route gating. The workerd test covers the route answering 404 and 405.
- **Run live** on a Free-plan test Worker on 2026-10-20: English, French, Spanish, Chinese, Japanese and Korean replies spoken and encoded
  (each 0.7 to 2 s end to end); each file transcribed back by Whisper in the same language. Uploads accepted by Meta (`audio/ogg`, sizes
  matching). CPU measured with `wrangler tail` (figures above). One voice reply sent through the full `send_reply` path to the allowlisted
  test phone. Meta accepted it and returned a message id.
- **Not yet verified**: the bubble on the phone (whether it plays as a voice note) and the delivery status. The test Worker cannot receive
  Meta's signed status webhooks until its app secret is set.
