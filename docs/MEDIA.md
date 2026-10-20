# Voice notes, images, documents and other inbound types (Workers AI)

**Status: released in 0.3.0 (preview).** Evidence is listed at the end of this page; read [STATUS.md](STATUS.md) for the overall picture.

When a customer sends a **voice note** (or another audio file) or an **image**, the bridge turns it into text with
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) in **your own Cloudflare account** and stores that text on the
message. The agent then reads it through `get_history` like any other customer message, wrapped as untrusted customer text. The
message keeps its WhatsApp type (`audio` or `image`). Nothing changes for text messages.

```
[voice note, transcribed, language: ar] مرحبا، هل أنتم مفتوحون اليوم؟
[image] description: A white cup of coffee on a saucer with a spoon. There is no text in the image. | caption: Do you have this?
[voice note, not transcribed]                      <- anything went wrong: the agent asks the customer to type, as before
[document "Price list.pdf", text extracted] # Price list ...
[location: 33.8938, 35.5018; name: Main office; address: 1 Example St; map: https://maps.google.com/?q=33.8938,35.5018]
[shared contact: Sam Example (Acme); phone: +1 555 0100 (WhatsApp 15550100); email: sam@example.test]
[video, not watched: ask the customer to describe it if it matters] caption: ...
```

**Documents** (PDF, Word `.docx`, Excel `.xlsx`/`.xls`, OpenDocument, CSV, plain text, HTML, XML) are downloaded from Meta like images and
converted to text with Workers AI [Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
(`env.AI.toMarkdown`), which converts these file types without a model and is free; image files are never sent to it. The first
`MEDIA_MAX_DOC_CHARS` characters reach the agent. A scanned PDF (only images) gives "no text found". Other types (zip, audio files sent
as documents, ...) get `[document "name", not read: ...]`. The file name is shown without any path. **Video** is not processed (no free
video model): the agent sees a marker and the caption. **Shared contacts**, **locations** (coordinates, name, address and a map link)
and **stickers** are turned into text directly from the webhook, with no download and no model.

## How it works

1. Meta posts the webhook. The bridge verifies the signature, stores the message with a placeholder (`[voice note, transcription pending]`) and answers **200 at once**. No media work happens before the answer.
2. In the background (`ctx.waitUntil`, which may run up to 30 seconds after the response), one job per **new** message id:
   asks Graph for the media URL with the stored WhatsApp token, downloads the bytes (the token is only ever sent to Meta hosts), checks the caps,
   runs the model through the `AI` binding, and writes the text onto the message. Raw media is held in memory for that one job only: it is never stored and never logged.
3. The agent's wake for that conversation waits for the job (at most 25 seconds) and is fired as soon as the text is stored, so the agent reads the transcript rather than the placeholder.

A redelivered webhook (same message id) is de-duplicated before any job is created, and a job only writes a message whose media status is
still `pending`, so the model never runs twice for one message. There is **no retry**: one attempt per message, ever.

## Models and languages

| Kind | Default model | Notes |
|---|---|---|
| Speech to text | `@cf/openai/whisper-large-v3-turbo` | Multilingual Whisper (about 100 languages, including Arabic, French and English); the language is detected automatically and stored (`language: ar`). Input: the Ogg/Opus voice note as sent by WhatsApp, no conversion. [model page](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) |
| Image understanding | `@cf/meta/llama-4-scout-17b-16e-instruct` | Natively multimodal; asked for at most three sentences and the important visible text (menus, receipts, screenshots) copied exactly. No license-acceptance request is needed for this model, unlike `@cf/meta/llama-3.2-11b-vision-instruct`, which requires one `"prompt": "agree"` call per account first. [model page](https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/) |

Both can be changed with `MEDIA_STT_MODEL` and `MEDIA_VISION_MODEL` (a `@cf/...` model name). A different vision model must accept chat messages with `image_url` parts.

## Cost: the free daily allowance

Workers AI is included in the Workers **Free** plan with **10,000 Neurons per day**, reset at 00:00 UTC. On the Free plan, usage past the
allowance is **not billed**: requests fail with error 3036 ("you have used up your daily free allocation") until the reset. Only the Workers Paid
plan bills past the allowance ($0.011 per 1,000 Neurons). A few large models are Paid-only (error 5035); the defaults above are not.
Sources: [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [errors](https://developers.cloudflare.com/workers-ai/platform/errors/),
[models that need Workers Paid](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/).

| | Published rate | Per item | Fits in 10,000 Neurons/day |
|---|---|---|---|
| Voice note (Whisper large-v3-turbo) | 46.63 Neurons per audio minute | about 19 Neurons for 25 s | about **214 minutes** of audio |
| Image (Llama 4 Scout) | 24,545 Neurons per M input tokens, 77,273 per M output tokens | about 2,000 input + 35 output tokens, about **52 Neurons** (measured on a 1280x960 photo) | about **190 images** |

The two share one allowance: for example 100 one-minute voice notes and 100 images a day is about 9,900 Neurons. `get_overview` reports
`media.estimated_neurons_today` (from the published rates and the measured audio seconds and tokens; the authoritative figure is the Workers AI
dashboard) next to `media.free_neurons_per_day`. Rates are Cloudflare's and can change: check the pricing page.

The allowance belongs to the Cloudflare **account**: several bots (Workers) in one account share it ([DEPLOY.md](DEPLOY.md#one-worker-per-bot-a-second-bot-in-the-same-account)).

The bridge itself never changes a plan or enables billing. If you are on Workers Paid, usage past the allowance **is** billed by Cloudflare; turn
the features off (below) if you do not want that.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_TRANSCRIBE` | on | `0`/`off` switches voice-note transcription off (the old behaviour: `[audio without text]`) |
| `MEDIA_DESCRIBE` | on | `0`/`off` switches image description off (the old behaviour: the caption, or `[image without text]`) |
| `MEDIA_MAX_AUDIO_SECONDS` | 120 (5 to 600) | longer voice notes are not transcribed; the duration is read from the Ogg/Opus file itself |
| `MEDIA_MAX_AUDIO_BYTES` | 2000000 (up to 16 MB) | larger audio files are not downloaded (other audio formats rely on this cap) |
| `MEDIA_MAX_IMAGE_BYTES` | 3000000 (up to 5 MB) | larger images are not downloaded |
| `MEDIA_READ_DOCUMENTS` | on | `0`/`off` switches document reading off (`[document "name", not read]` plus the caption) |
| `MEDIA_MAX_DOC_BYTES` | 2000000 (up to 10 MB) | larger documents are not downloaded |
| `MEDIA_MAX_DOC_CHARS` | 3000 (200 to 3800) | how much of a document's text the agent gets |
| `MEDIA_TIMEOUT_MS` | 18000 (2000 to 20000) | Workers AI call timeout; each Graph request has its own 5 seconds |
| `MEDIA_STT_MODEL`, `MEDIA_VISION_MODEL` | see above | model names |
| `MEDIA_SELFTEST` | off | `1` mounts the owner-only test route (below); leave it off |

The `AI` binding comes from `[ai] binding = "AI"` in `wrangler.toml` (and `scripts/cf-api-deploy.mjs`). A Worker deployed without it keeps
working: voice notes and images get the fallback marker and `get_overview` shows `media.ai_binding_present: false`.

## Fallbacks and counters

| What the agent sees | When |
|---|---|
| `[voice note, transcribed, language: xx] ...` / `[image] description: ... \| caption: ...` | success |
| `[voice note, transcribed: no speech detected]` | the audio had no speech |
| `[voice note, not transcribed: longer than 120 s]`, `[..., not transcribed: file too large]`, `[image, not described: file too large]` | a cap was hit (the model was not called) |
| `[voice note, not transcribed]`, `[image, not described]` (plus `caption: ...` when there was one) | download failed, Workers AI error, free allowance used up, timeout, or no `AI` binding |
| `[audio, ...]` instead of `[voice note, ...]` | an audio file that was not recorded as a voice note |

`get_overview` (MCP) has a `media` block with counters only, never content: `transcribed`, `described`, `too_large`, `download_failed`,
`ai_failed` (of which `ai_quota_exhausted` for error 3036 and `ai_paid_only` for 5035), `unavailable`, `audio_seconds`, `vision_input_tokens`,
`vision_output_tokens`, for today (UTC) and in total, plus `last_failure_at` and a short `last_failure_code` such as `ai_3036`, `download_http_404` or `too_long`.
`get_history` adds `media: {status, language}` to such messages (`status`: pending, done, skipped or failed).

## Safety and privacy

- Transcripts and descriptions are **customer content**: stored like message text, shown to the agent inside `<untrusted_customer_text>`, erased with the conversation, never logged. Treat them exactly like typed text: an image or a voice note can contain instructions, and the agent must not follow them.
- Machine transcription and description can be wrong. Whisper sometimes adds a short phrase that was not said at the end of a clip (seen live: a stray subtitle credit after a French sample). The agent should confirm order details, amounts, dates and names with the customer.
- Media goes from Meta to your Worker to Workers AI, all inside your own Cloudflare account. Cloudflare's terms for Workers AI apply.
- Video, documents and stickers are still stored as type only.

## Owner self-test route

With `MEDIA_SELFTEST=1` (a plain Worker variable; off by default, 404 otherwise) the owner can check the whole path without a phone:

```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: audio/ogg" --data-binary @sample.ogg \
  "https://<worker>/api/admin/media-selftest?kind=audio&voice=1"            # add &via=graph to go through Meta's media store
```

The body is a sample file. It runs the same caps, model, fallback and counters and stores the result as an inbound message in a self-test
conversation with a fake reserved number (`15550100099`), **without** waking the agent, and answers status codes only (never the transcript). With `via=graph`
the sample is first uploaded to the number's own Meta media store (no message is sent; Meta keeps uploads 30 days) and then fetched back by
media id with the stored token, exactly like a customer's file. Read the result with `get_history` or the inbox, erase it with
`delete_conversation`, then remove `MEDIA_SELFTEST`.

## Voice replies

Answering with a voice note is a separate, optional feature, **off by default**: see [VOICE-REPLIES.md](VOICE-REPLIES.md).

## Evidence

- **Tested locally**: `tests/media.test.ts` (async after the 200, one model run per message id across redeliveries, 3036 fallback with counters and no retry, caps without a model call, image with caption, download failure, token sent to Meta hosts only, flags off, no binding, hostile transcript stays wrapped, Ogg/Opus duration, self-test route gating) and the workerd route test.
- **Run live** on a test Worker (Workers Free plan) on 2026-10-20 through the self-test route, then read back with MCP `get_history`: an Arabic, an English and a French voice note (25 s / 25 s / 20 s Ogg/Opus samples from Wikimedia Commons spoken articles) transcribed with the right language detected; a 178 s voice note skipped by the 120 s cap without a model call; a photo described with its caption kept; the same English sample and photo also through `via=graph` (real upload to and download from Meta's media store with the Worker's stored token). Each took 3 to 7 seconds. Measured: about 2,000 input tokens per 1280x960 photo.
- **Not yet verified**: a voice note or image sent from a real phone through a signed Meta webhook, and the free allowance actually running out (the 3036 fallback is tested locally only).
