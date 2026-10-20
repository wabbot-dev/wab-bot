# Voice-note replies (optional, off by default)

**Status: released in 0.3.0 (preview); the xAI and ElevenLabs providers, dialect presets and pronunciation list were added in 0.4.0; every language through xAI or ElevenLabs, a voice per language and gender-neutral presets in 0.5.0. Off unless the owner sets `VOICE_REPLIES`.** Evidence is listed at the end of this page; read
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

**Arabic needs the xAI or ElevenLabs provider:** no Workers AI text-to-speech model speaks Arabic today, so with the default provider
Arabic replies go as text (`voice_fallback: "voice_language_unsupported_ar"`). Set `VOICE_REPLY_PROVIDER=xai` (your xAI key, the same one
as voice calls) or `VOICE_REPLY_PROVIDER=elevenlabs` (your own ElevenLabs voices) to speak them, and every other language, with that
provider ([below](#arabic-and-other-languages-xai-or-elevenlabs)). Sources:
[melotts](https://developers.cloudflare.com/workers-ai/models/melotts/), [aura-2-en](https://developers.cloudflare.com/workers-ai/models/aura-2-en/),
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

**Cost.** With MeloTTS a 10-second reply is about 3 Neurons. The free 10,000 Neurons per day (reset 00:00 UTC) are shared with
transcription and image descriptions; on the Workers Free plan, use past the allowance fails (error 3036) and the text is sent instead. It
is never billed. On Workers Paid, use past the allowance is billed at $0.011 per 1,000 Neurons.

## Arabic and other languages: xAI or ElevenLabs

Optional. Off unless the owner sets `VOICE_REPLY_PROVIDER`; voice replies themselves still need `VOICE_REPLIES` (`mirror` recommended).
With `xai` or `elevenlabs` set, **every language is spoken by that provider** (both are multilingual), so a customer hears the same
voice quality, and with ElevenLabs the voice you picked for that language, whatever they write in.

| Language of the reply | `VOICE_REPLY_ROUTING=all` (default) | `VOICE_REPLY_ROUTING=non-workers-ai` (the 0.4.x behaviour) |
| --- | --- | --- |
| Arabic (`ar`, from the Arabic script) | xAI or ElevenLabs | xAI or ElevenLabs |
| A language the Workers AI model speaks (MeloTTS: `en`, `fr`, `es`, `zh`, `ja`, `ko`) | xAI or ElevenLabs | Workers AI |
| Any other two-letter language (for example `de`, `it`, `tr`) | xAI or ElevenLabs | xAI or ElevenLabs |

**Behaviour change in 0.5.0.** Before 0.5.0 the Workers AI languages always stayed on Workers AI. A deployment that already had
`VOICE_REPLY_PROVIDER=elevenlabs` (or `xai`) and upgrades now speaks English, French, Spanish, Chinese, Japanese and Korean voice replies
with that provider too, which uses its characters (ElevenLabs) or credits (xAI) instead of free Workers AI Neurons. To keep the old split,
set `VOICE_REPLY_ROUTING=non-workers-ai`. With ElevenLabs, a Workers AI language that has no ElevenLabs voice at all (no entry in
`ELEVENLABS_VOICE_IDS` and no `ELEVENLABS_VOICE_ID`) stays on Workers AI. `get_overview` → `media.voice_routing` shows the provider for each
language.

### xAI provider

- `VOICE_REPLY_PROVIDER=xai` reuses `XAI_API_KEY`, the key already used for voice calls; nothing else to sign up for.
- **One request per reply:** `POST https://api.x.ai/v1/tts` with `{"text", "voice_id", "language", "output_format": {"codec": "mp3",
  "sample_rate": 24000, "bit_rate": 64000}}` and the key as a Bearer header. The MP3 is encoded to Ogg Opus by the bundled encoder in the
  `voice-note-encoder` Durable Object, which reads the key itself from the deployment's own settings (the key is never passed between
  objects). Source: [docs.x.ai text-to-speech](https://docs.x.ai/docs/guides/text-to-speech).
- **Voice:** `XAI_TTS_VOICE` (default `eve`; any built-in voice name such as `ara` or `rex`, or your own custom voice id).
- **Arabic locale:** from the dialect preset (`egyptian` → `ar-EG`, `gulf` → `ar-AE`, otherwise `ar-SA`), or set `XAI_TTS_ARABIC_LOCALE`
  (`ar-EG`, `ar-SA` or `ar-AE`). Other languages are passed when xAI lists them, else `auto`.
- **Pronunciations:** the owner's list ([below](#pronunciation-list)) goes along in xAI's own `replace` field.
- **Errors:** `voice_tts_xai_auth`, `voice_tts_xai_rate_limited`, `voice_tts_xai_credits`, `voice_tts_xai_http_xxx`, `voice_tts_xai_timeout`,
  `voice_tts_xai_network`, `voice_tts_xai_key_missing`. Any of them sends the text instead, once, with no retry. The provider's error text is never echoed.
- **Cost:** billed to your xAI account per character. **Privacy:** the reply text is sent to xAI to be spoken.

### ElevenLabs provider

- `VOICE_REPLY_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` (secret) and `ELEVENLABS_VOICE_ID` (the voice you picked or cloned, used for
  every language), and optionally a voice per language ([below](#a-voice-per-language)).
- **One request per reply:** `POST https://api.elevenlabs.io/v1/text-to-speech/<voice id>?output_format=opus_48000_64` with
  `{"text": ..., "model_id": ELEVENLABS_MODEL_ID}` and the key in the `xi-api-key` header. The answer is already a mono Ogg Opus file
  (48 kHz, 64 kbit/s), which WhatsApp shows as a voice note, so it is uploaded as `audio/ogg` and sent as `type: "audio"` with `voice: true`
  through the same upload and send code as Workers AI replies. Nothing is decoded or re-encoded, so no Durable Object is involved.
- **Model:** `eleven_v4` (default) was accepted by the public API on 2026-10-20; `eleven_v3` also works.
- **Same request as the ElevenLabs studio:** only `text` and `model_id` are sent (plus your [pronunciation dictionaries](#pronunciation-dictionaries-elevenlabs), if set). No `voice_settings`, so the voice's own saved settings
  apply, and no `language_code`: forcing `"ar"` pushed a dialect voice toward standard Arabic in an A/B run on 2026-10-20.
- **Style tag (optional):** `VOICE_STYLE_TAG`, for example `warm, friendly` or an accent direction that suits your voice, is put in front
  of the text as `[warm, friendly] <reply>` on tag-aware models (`eleven_v3`, `eleven_v4`) only. The model reads the bracket as direction,
  not as words. Empty by default. Any square brackets in the reply itself are removed before speaking, so neither the agent nor quoted
  customer text can add directions.
- **Caps:** a reply longer than `ELEVENLABS_MAX_CHARS` (default 600) or `VOICE_MAX_CHARS` goes as text without any ElevenLabs call;
  audio over `VOICE_MAX_SECONDS` or 500 KB goes as text.
- **Errors and quota:** any ElevenLabs error sends the text instead, once, with no retry. Codes: `voice_tts_el_quota` (quota or credits
  used up), `voice_tts_el_rate_limited` (429 or too many concurrent requests), `voice_tts_el_auth` / `voice_tts_el_permission` (key),
  `voice_tts_el_voice_not_found`, `voice_tts_el_model`, `voice_tts_el_dictionary`, `voice_tts_el_http_xxx`, `voice_tts_el_timeout`, `voice_tts_el_network`,
  `voice_tts_el_not_ogg_opus`, `voice_tts_el_key_missing`, `voice_tts_el_voice_missing`. Only ElevenLabs' short `detail.status` word is
  read from an error; its message is never echoed or logged.
- **Key:** `ELEVENLABS_API_KEY` is a Worker secret (stdin only: `wrangler secret put ELEVENLABS_API_KEY < key-file`) or self-provisioned.
  It goes only to `api.elevenlabs.io`, is never logged, returned or stored by the bridge, and is scrubbed from MCP results. Make a
  **restricted key** for the bot ([below](#a-restricted-elevenlabs-key)).
- **Cost:** billed to your own ElevenLabs account per character (a style tag counts too); no Workers AI Neurons are used. `get_overview` →
  `media` shows `voice_reply_provider`, `voice_routing`, an `elevenlabs` block (`key_present`, `voice_id_set`, `model_id`, `max_chars`,
  `style_tag_set`, `voices` (the voice id per language, `*` = the fallback), `model_ids`, `style_tag_languages`, `ignored_entries`; never
  the key) and the counters `voice_el_sent`, `voice_el_seconds`, `voice_el_chars` and `voice_el_quota`.
- **Privacy:** the reply text (not the customer's message) is sent to ElevenLabs to be spoken. Check its data policy before you turn this on.

### A voice per language

`ELEVENLABS_VOICE_IDS` gives each language its own ElevenLabs voice, for example an Arabic voice with the accent your customers speak and
an English voice for English replies. The language is the reply's own (the Arabic script, else `voice_language`, else the language of the
customer's voice note). A language without an entry uses `ELEVENLABS_VOICE_ID`.

```bash
ELEVENLABS_VOICE_ID=<fallback voice id>                     # every language without its own voice
ELEVENLABS_VOICE_IDS='ar=<voice id>,en=<voice id>,fr=<voice id>'
# or JSON: ELEVENLABS_VOICE_IDS='{"ar":"<voice id>","en":"<voice id>"}'
ELEVENLABS_MODEL_IDS='ar=eleven_v3'                         # optional: a model per language (ELEVENLABS_MODEL_ID for the rest)
VOICE_STYLE_TAGS='ar=[warm, slow]; en=[calm, friendly]'     # optional: a style tag per language (; or new lines between entries)
```

- Pick each voice in the ElevenLabs voice library (in the ElevenLabs app, or through the ElevenLabs plugin of your assistant) by the
  language and accent you want, then copy its voice id. Voice ids are not secrets; they are plain variables.
- Keys are two-letter language codes (`ar`, `en`, `fr`, ...); values are voice ids (letters and digits), model ids (`eleven_v4`) or style
  tags. Entries are separated by commas, semicolons or new lines (style tags: semicolons or new lines, since a tag may contain commas).
- A malformed entry (a bad language code or id, broken JSON) is skipped and never stops voice replies: the language falls back to the
  single setting. The skipped count is logged as `voice_map_ignored` (counts only, never the value) and shown in `get_overview` →
  `media.elevenlabs.ignored_entries`.
- The owner self-test (below) returns `voice_id`, `voice_from` (`language` or `default`) and `chars_sent` for an ElevenLabs reply.

### Pronunciation dictionaries (ElevenLabs)

Optional. If you keep a [pronunciation dictionary](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) in your own
ElevenLabs account (alias or phoneme rules for brand names, places or dialect words), the bot can use it for every voice reply:

```bash
ELEVENLABS_PRONUNCIATION_DICTIONARIES='<dictionary id>:<version id>'                 # every language
ELEVENLABS_PRONUNCIATION_DICTIONARIES='ar=<dictionary id>:<version id>,<dictionary id>'  # one for Arabic, one for every language
```

- Entries are `<dictionary id>:<version id>`, separated by commas, semicolons or new lines. The version is optional (without it ElevenLabs
  uses the latest version); pin one so an edit in the ElevenLabs app does not change replies before you have listened to it. An entry with
  a language in front (`ar=...`) applies to that language only.
- They go to ElevenLabs as `pronunciation_dictionary_locators` in the same request (the language's own first, then the ones for every
  language; **at most three**, ElevenLabs' limit). Unset = the request is exactly as before.
- **Order:** the bot's own respelling ([pronunciation list](#pronunciation-list) and the preset's marks) is applied to the spoken copy
  first; ElevenLabs then applies your dictionaries to the text it receives, whole words, in order. The two do not conflict, but a word your
  list already respelled no longer matches a dictionary rule for its original spelling, so keep each word in one place.
- A malformed entry is skipped and counted (`voice_map_ignored`, `get_overview` → `media.elevenlabs.ignored_entries`); `get_overview`
  shows the dictionary ids and versions per language (`pronunciation_dictionaries`, never the key).
- **Key permission:** the Worker's ElevenLabs key needs **Pronunciation Dictionaries** (read; write also works) besides Text to Speech and
  Voices read. Without it ElevenLabs refuses the request (`voice_tts_el_permission`) and the text is sent instead. A dictionary that does
  not exist gives `voice_tts_el_dictionary` (or `voice_tts_el_http_xxx`).

### A restricted ElevenLabs key

Make a key just for the bot in the ElevenLabs app (**Developers** in the left sidebar → **API Keys** → create a key). Keep **Restrict Key**
on (the default), enable only **Text to Speech** and **Voices** (read), plus **Pronunciation Dictionaries** (read) if you use
[dictionaries](#pronunciation-dictionaries-elevenlabs), and set a **credit limit** (a monthly cap you can afford). Then the
key can only speak with your voices; it cannot change voices, agents or your account, and a leak or a loop costs at most the limit
(ElevenLabs' [key guide](https://elevenlabs.io/blog/api-authentication-and-key-management)). Store it with
`wrangler secret put ELEVENLABS_API_KEY` (stdin only). Signing in to ElevenLabs in your assistant's plugin (to browse the voice library and
choose voices) is **separate** from this Worker key: the plugin sign-in never reaches the Worker, and the Worker key is never given to the
plugin or the agent.

## Arabic dialect presets

A voice reads exactly what the agent wrote, so formal Arabic or another dialect's words can sound foreign: the wording matters as much as
the voice. While voice replies are on, `get_history` returns a `voice_reply` block: `expected` (true when the reply will be spoken),
`provider`, `max_chars`, `dialect` and, when the owner picked a preset with `ARABIC_REPLY_DIALECT`, `arabic_style`: a short instruction for
how to write a spoken Arabic reply. The `send_reply` tool description tells the agent to follow it.

| `ARABIC_REPLY_DIALECT` | Wording hint |
| --- | --- |
| `none` (default) | No hint; the agent writes Arabic as it normally would |
| `msa` | Clear, simple Modern Standard Arabic |
| `lebanese` | Colloquial Lebanese Arabic in Arabic script; shadda on doubled letters |
| `gulf` | Natural Gulf (Khaleeji) Arabic |
| `egyptian` | Natural Egyptian Arabic |

Every preset addresses the customer **without assuming their gender**: in the plural (إنتو with `-كن` endings in Lebanese, `-كم` in Gulf
and Modern Standard Arabic, `-كو` in Egyptian), never a masculine or feminine singular. Every preset also asks for a short, natural reply
with no lists, links, emojis, markdown or brackets, and numbers as spoken words. Typed replies are not affected by the preset, but the
`send_reply` tool description gives the agent the same gender-neutral rule for every reply (Arabic plural address; neutral wording in
other gendered languages), and so do the default call instructions ([VOICE-CALLS.md](VOICE-CALLS.md)). The hint is advice to the agent; the bridge does not rewrite the stored text. The preset texts live in
[lib/voice-style.ts](../lib/voice-style.ts); with xAI the preset also picks the Arabic locale.

## Pronunciation list

Right before a reply goes to xAI or ElevenLabs, the bridge can respell the **spoken copy** ([lib/voice-pronounce.ts](../lib/voice-pronounce.ts)).
The reply text that is stored, shown in history and sent as a text fallback is never changed. Both parts are optional and off by default.

- **Your list (`VOICE_PRONUNCIATIONS`):** pairs of `written => spoken`, separated by `;` or new lines, or a JSON object
  (`{"Acme":"Akmee"}`). Use it for a brand or product name the voice says wrong, or for respellings that make your chosen voice sound
  closer to your dialect. Whole words only, any case; for Arabic the common clitics in front (و ف ب ل ع ك ال لل عال بال) are kept and vowel
  marks already present are ignored. At most 100 pairs, 60 characters each; malformed pairs are skipped. What works is voice-specific, so
  test each pair on your own voice (the owner self-test below) before relying on it.
- **The `lebanese` preset's marks:** shadda (ّ) on common doubled-consonant words of spoken Lebanese (هلق → هلّق، بدك → بدّك، عنا → عنّا،
  كل → كلّ ...), which helps most Arabic voices read them as the dialect. Ambiguous bare words (هم, أي, حد, جد) are left alone. Other presets
  have no marks.

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
| `VOICE_REPLY_PROVIDER` | `workers-ai` | `xai` or `elevenlabs`: that provider speaks every language ([above](#arabic-and-other-languages-xai-or-elevenlabs)) |
| `VOICE_REPLY_ROUTING` | `all` | With `xai` / `elevenlabs`: `all` languages, or `non-workers-ai` to keep Workers AI for its own languages (the 0.4.x behaviour) |
| `XAI_TTS_VOICE` | `eve` | xAI voice: a built-in name or your custom voice id (uses `XAI_API_KEY`) |
| `XAI_TTS_ARABIC_LOCALE` | (from the preset) | `ar-EG`, `ar-SA` or `ar-AE` |
| `ELEVENLABS_API_KEY` | (secret, unset) | ElevenLabs key (Text to Speech, plus Voices read); stdin only |
| `ELEVENLABS_VOICE_ID` | (unset) | The ElevenLabs voice to speak with; the fallback for every language without its own voice |
| `ELEVENLABS_VOICE_IDS` | (unset) | Optional voice per language, e.g. `ar=<id>,en=<id>` or JSON ([above](#a-voice-per-language)) |
| `ELEVENLABS_MODEL_IDS` | (unset) | Optional model per language, e.g. `ar=eleven_v3` |
| `ELEVENLABS_MODEL_ID` | `eleven_v4` | ElevenLabs model (`eleven_v3` also works) |
| `ELEVENLABS_MAX_CHARS` | 600 (20 to 1500) | Longer replies go as text, with no ElevenLabs call |
| `VOICE_STYLE_TAG` | (unset) | Optional direction for tag-aware ElevenLabs models, e.g. `warm, friendly` |
| `VOICE_STYLE_TAGS` | (unset) | Optional style tag per language, e.g. `ar=[warm]; en=[calm]` |
| `ELEVENLABS_PRONUNCIATION_DICTIONARIES` | (unset) | Optional: your ElevenLabs dictionaries, `<id>:<version>` or `ar=<id>:<version>`, at most 3 per reply ([above](#pronunciation-dictionaries-elevenlabs)) |
| `VOICE_PRONUNCIATIONS` | (unset) | Optional `written => spoken` list for the spoken copy ([above](#pronunciation-list)) |
| `ARABIC_REPLY_DIALECT` | `none` | Optional preset: `msa`, `lebanese`, `gulf` or `egyptian` ([above](#arabic-dialect-presets)) |

`send_reply` takes two optional fields: `reply_as` (`auto` by default, `text` or `voice`) and `voice_language` (two letters, for
example `en`).

## Fallbacks and counters

The send result carries `sent_as` (`voice` or `text`) and, when a wanted voice note went as text, `voice_fallback` with a short code.
`get_overview` → `media` shows `voice_replies`, `voice_tts_model`, `voice_languages`, `voice_speaker_present`, the caps, and the counters
`voice_sent`, `voice_fallback` (with `voice_tts_failed`, `voice_encode_failed`, `voice_upload_failed`, `voice_language_unsupported`),
`voice_send_rejected`, `voice_seconds` and `voice_chars`. The speech cost is included in `estimated_neurons_today`.

| Code | Meaning | What happens |
| --- | --- | --- |
| `voice_language_unsupported_xx` | No voice for that language (Arabic with the default provider: `_ar`) | Text sent |
| `voice_tts_el_*`, `voice_tts_xai_*` | ElevenLabs or xAI error, quota or rate limit ([lists](#arabic-and-other-languages-xai-or-elevenlabs)) | Text sent |
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
- **xAI and ElevenLabs providers**: tested locally in `tests/voice-providers.test.ts` (provider choice, each request, error and quota codes,
  the text fallback, caps, counters, the dialect presets, the pronunciation list on the spoken copy only, the keys never in logs or results).
  ElevenLabs was run on a test Worker on 2026-10-20 (see [STATUS.md](STATUS.md)). xAI text-to-speech is tested locally only (it is paid).
- **Routing and a voice per language (0.5.0)**: tested locally in `tests/voice-routing.test.ts` (routing default and opt-out, the per-language
  voice, model and tag with fallbacks, malformed entries skipped and counted, `get_overview`, gender-neutral guidance). Run on a test Worker
  on 2026-10-21: see [STATUS.md](STATUS.md).
- **Not yet verified**: the bubble on the phone (whether it plays as a voice note) and the delivery status. The test Worker cannot receive
  Meta's signed status webhooks until its app secret is set.
