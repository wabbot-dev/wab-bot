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

**Arabic needs the ElevenLabs provider:** no Workers AI text-to-speech model speaks Arabic today, so with the default provider Arabic
replies go as text (`voice_fallback: "voice_language_unsupported_ar"`). Set `VOICE_REPLY_PROVIDER=elevenlabs` to speak them with your own
ElevenLabs voice ([below](#elevenlabs-provider)). The same holds for any language a model lacks. Sources:
[melotts](https://developers.cloudflare.com/workers-ai/models/melotts/), [aura-2-en](https://developers.cloudflare.com/workers-ai/models/aura-2-en/),
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

**Cost.** With MeloTTS a 10-second reply is about 3 Neurons. The free 10,000 Neurons per day (reset 00:00 UTC) are shared with
transcription and image descriptions; on the Workers Free plan, use past the allowance fails (error 3036) and the text is sent instead. It
is never billed. On Workers Paid, use past the allowance is billed at $0.011 per 1,000 Neurons.

## ElevenLabs provider

Optional, for Arabic (and any language the Workers AI model lacks). Off unless the owner sets `VOICE_REPLY_PROVIDER=elevenlabs`;
voice replies themselves still need `VOICE_REPLIES` (`mirror` recommended).

| Language of the reply | Spoken by |
| --- | --- |
| Arabic (`ar`, from the Arabic script) | ElevenLabs |
| A language the Workers AI model speaks (MeloTTS: `en`, `fr`, `es`, `zh`, `ja`, `ko`) | Workers AI, exactly as before |
| Any other two-letter language (for example `de`, `it`, `tr`) | ElevenLabs (the `eleven_*` models are multilingual) |

- **One request per reply:** `POST https://api.elevenlabs.io/v1/text-to-speech/<ELEVENLABS_VOICE_ID>?output_format=opus_48000_64` with
  `{"text": ..., "model_id": ELEVENLABS_MODEL_ID}` and the key in the `xi-api-key` header. The answer is already a mono Ogg Opus file
  (48 kHz, 64 kbit/s), which WhatsApp shows as a voice note, so it is uploaded as `audio/ogg` and sent as `type: "audio"` with `voice: true`
  through the same upload and send code as Workers AI replies. Nothing is decoded or re-encoded, so no Durable Object is involved.
- **Model:** `eleven_v4` (default) was accepted by the public API on 2026-10-20; `eleven_v3` also works.
- **Same request as the ElevenLabs studio:** only `text` and `model_id` are sent. No `voice_settings`, so the voice's own saved settings
  apply (read them with `GET /v1/voices/<id>/settings`), and no `language_code`: forcing `"ar"` pushed a Lebanese voice toward standard
  Arabic in an A/B run on 2026-10-20.
- **Accent direction:** for an Arabic reply with `ARABIC_REPLY_DIALECT=lebanese` on a tag-aware model (`eleven_v3`, `eleven_v4`), the text
  is sent as `[casual Beiruti Lebanese accent] <reply>`. The model reads the bracket as direction, not as words. In the same A/B run it
  brought the voice closest to its approved studio sample. `ELEVENLABS_ACCENT_TAG=0` turns it off. Any square brackets in the reply
  itself are removed before speaking, so neither the agent nor quoted customer text can add directions.
- **Caps:** a reply longer than `ELEVENLABS_MAX_CHARS` (default 600) or `VOICE_MAX_CHARS` goes as text without any ElevenLabs call;
  audio over `VOICE_MAX_SECONDS` or 500 KB goes as text.
- **Errors and quota:** any ElevenLabs error sends the text instead, once, with no retry. Codes: `voice_tts_el_quota` (quota or credits
  used up), `voice_tts_el_rate_limited` (429 or too many concurrent requests), `voice_tts_el_auth` / `voice_tts_el_permission` (key),
  `voice_tts_el_voice_not_found`, `voice_tts_el_model`, `voice_tts_el_http_xxx`, `voice_tts_el_timeout`, `voice_tts_el_network`,
  `voice_tts_el_not_ogg_opus`, `voice_tts_el_key_missing`, `voice_tts_el_voice_missing`. Only ElevenLabs' short `detail.status` word is
  read from an error; its message is never echoed or logged.
- **Key:** `ELEVENLABS_API_KEY` is a Worker secret (stdin only:
  `wrangler secret put ELEVENLABS_API_KEY < key-file`) or self-provisioned. Give it the smallest scope: Text to Speech, plus Voices read.
  It goes only to `api.elevenlabs.io`, is never logged, returned or stored by the bridge, and is scrubbed from MCP results.
- **Cost:** ElevenLabs bills your own ElevenLabs account per character; no Workers AI Neurons are used for these replies.
  `get_overview` → `media` shows `voice_reply_provider`, an `elevenlabs` block (`key_present`, `voice_id_set`, `model_id`,
  `max_chars`; never the key) and the counters `voice_el_sent`, `voice_el_seconds`, `voice_el_chars` and `voice_el_quota`.
- **Privacy:** the reply text (not the customer's message) is sent to ElevenLabs to be spoken. Check its data policy before you turn this on.

## Arabic wording (Lebanese dialect)

A voice reads exactly what the agent wrote, so formal Arabic or another dialect's words come out sounding foreign: the wording matters as
much as the voice. While voice replies are on, `get_history` returns a `voice_reply` block: `expected` (true when the reply will be spoken),
`provider`, `max_chars` and, with `ARABIC_REPLY_DIALECT=lebanese` (the default), `arabic_style`, the instruction to write a spoken Arabic
reply **colloquially, the way people talk in Beirut, in Arabic script**: never formal written Arabic (فصحى), and not Syrian, Egyptian,
Gulf or generic Levantine phrasing. The `send_reply` tool description and the wake-routine prompt say the same. It asks for:

| Use | Meaning | Never |
| --- | --- | --- |
| أهلين فيك | welcome | |
| كيفك | how are you | شلونك |
| نحنا هون كرميلك (كرميلك said *kirmelak*) | we're here for you | كرمالك, منشان, مشان |
| هلّق | now | الآن |
| شو بتحب | what would you like | ماذا |
| بدّك، عنّا، فيك، رح | you want, we have, you can, will | لدينا، يمكنك، سوف |
| مش | not | مو |
| بزبّطلك ياها | I'll sort it for you | |
| تكرم عينك، ولا يهمك | with pleasure, no problem | |
| لكان | then / of course | |
| يسلملي قلبك | thank you (warm) | شكراً جزيلاً |
| تمانة، تلاتة، نصّ ساعة | numbers as spoken words | digits |

and a short, natural reply with no lists, links, emojis, markdown or brackets. `ARABIC_REPLY_DIALECT=none` turns the hint (and the
accent direction) off. Typed replies are not affected. The hint is advice to the agent; the bridge does not rewrite the text.

## Pronunciation layer

Right before an Arabic reply goes to ElevenLabs with the Lebanese dialect on (`ARABIC_REPLY_DIALECT=lebanese`), the bridge respells the **spoken copy** ([lib/voice-pronounce.ts](../lib/voice-pronounce.ts)). The reply text that is stored, shown in history and sent as a text fallback is never changed.

- **Approved spelling.** The owner's approved studio script for this voice marked doubled consonants with shadda (ّ) and used no other vowel marks. When a reply writes one of that script's words without the shadda, it is added back: هلق → هلّق، بدك → بدّك، عنا → عنّا، قديش → قدّيش، قلي → قلّي، كل → كلّ، نص → نصّ، مرة → مرّة، يلا → يلّا، ستة → ستّة، بزبطلك → بزبّطلك، تجرب → تجرّب، and the rest of the list in the file. Words whose bare spelling is ambiguous (هم، أي، حد، جد، منك) are left alone.
- **Respellings**, each A/B-tested on the voice first: الساعة / ساعة → السيعة / سيعة (Beiruti "se3a", not "sa3a"), كرمالك → كرميلك.
- **Imala respellings** (Beiruti ā → e), only for voices that say a plain "a" there (`IMALA_VOICES`: the Nick voice `VsqtGXzc5Y1q5G3RuCrZ`), A/B-tested on that voice with a formant check and a Whisper read-back: دوام → دويم، فاتحين → فيتحين، لازم → ليزم، ياها / ياه → ييها / ييه، ولاد → وليد، تلاتين → تليتين، بلاش → بلَيْش، تاني → تِني، شبّاك → شبّيك. تمانة and منستنّاك are left alone (the voice already says them with "e"); ā next to emphatic, guttural or r consonants (طاولة، شغّال، عايشة، رسالة) keeps "a". The approved Mimi voice already says these words with "e" and the respellings pushed it to "ii", so it does not get them.
- Words match whole, with clitics in front (و ف ب ل ع ك ال لل بال عال), whether or not they already carry marks: بالساعة → بالسيعة, but مساعدة and ساعات are untouched.
- `voice_pronounce` logs how many words changed, never the text. The spoken-length cap counts the respelled copy.
- The `arabic_style` hint also asks the agent to write the same shadda itself; the layer makes it hold either way.

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
| `VOICE_REPLY_PROVIDER` | `workers-ai` | `elevenlabs`: Arabic and languages Workers AI lacks are spoken by ElevenLabs ([above](#elevenlabs-provider)) |
| `ELEVENLABS_API_KEY` | (secret, unset) | ElevenLabs key (Text to Speech, plus Voices read); stdin only |
| `ELEVENLABS_VOICE_ID` | (unset) | The ElevenLabs voice to speak with |
| `ELEVENLABS_MODEL_ID` | `eleven_v4` | ElevenLabs model (`eleven_v3` also works) |
| `ELEVENLABS_MAX_CHARS` | 600 (20 to 1500) | Longer replies go as text, with no ElevenLabs call |
| `ELEVENLABS_ACCENT_TAG` | on | `0` turns off the `[casual Beiruti Lebanese accent]` direction for Arabic on `eleven_v3` / `eleven_v4` |
| `ARABIC_REPLY_DIALECT` | `lebanese` | Wording hint for spoken Arabic replies ([above](#arabic-wording-lebanese-dialect)); `none` turns it off |

`send_reply` takes two optional fields: `reply_as` (`auto` by default, `text` or `voice`) and `voice_language` (two letters, for
example `en`).

## Fallbacks and counters

The send result carries `sent_as` (`voice` or `text`) and, when a wanted voice note went as text, `voice_fallback` with a short code.
`get_overview` → `media` shows `voice_replies`, `voice_tts_model`, `voice_languages`, `voice_speaker_present`, the caps, and the counters
`voice_sent`, `voice_fallback` (with `voice_tts_failed`, `voice_encode_failed`, `voice_upload_failed`, `voice_language_unsupported`),
`voice_send_rejected`, `voice_seconds` and `voice_chars`. The speech cost is included in `estimated_neurons_today`.

| Code | Meaning | What happens |
| --- | --- | --- |
| `voice_language_unsupported_xx` | No voice for that language (Arabic without the ElevenLabs provider: `_ar`) | Text sent |
| `voice_tts_el_*` | ElevenLabs error, quota (`_quota`) or rate limit (`_rate_limited`) ([list](#elevenlabs-provider)) | Text sent |
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
- **ElevenLabs provider**: tested locally in `tests/elevenlabs.test.ts` (provider choice, the request, error and quota codes, the text
  fallback, caps, counters, the wording hint, the key never in logs or results). Run on a test Worker on 2026-10-20 (see
  [STATUS.md](STATUS.md)).
- **Not yet verified**: the bubble on the phone (whether it plays as a voice note) and the delivery status. The test Worker cannot receive
  Meta's signed status webhooks until its app secret is set.
