/**
 * ElevenLabs text-to-speech for optional voice-note replies (docs/VOICE-REPLIES.md#elevenlabs-provider). Used when the owner sets
 * VOICE_REPLY_PROVIDER=elevenlabs: Arabic replies always, and any other language that the Workers AI model cannot speak.
 *
 * One POST per reply to api.elevenlabs.io with output_format=opus_48000_64: the answer is already a mono Ogg Opus file (48 kHz), which
 * WhatsApp shows as a voice note, so nothing is decoded or re-encoded and the call runs in the request itself (network wait, not CPU).
 * The key (ELEVENLABS_API_KEY) goes only to api.elevenlabs.io in the xi-api-key header. It is never logged, returned or stored by the
 * bridge; errors come back as short codes, never as the provider's response body. Nothing is retried.
 */
import { oggOpusSeconds, type MediaCounts } from "./media";
import { isMonoOggOpus, speakable, type SpeakResult } from "./voice-reply";

export const ELEVENLABS_HOST = "https://api.elevenlabs.io";
export const ELEVENLABS_OUTPUT_FORMAT = "opus_48000_64";
/** largest audio file accepted back (WhatsApp shows the play button only up to 512 KB) */
const MAX_AUDIO_BYTES = 500_000;

export interface ElevenLabsArgs {
  text: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  maxChars: number;
  maxSeconds: number;
  timeoutMs: number;
}

const fail = (code: string, count: Partial<MediaCounts> = { voice_tts_failed: 1 }): SpeakResult => ({ ok: false, code: code.slice(0, 40), count });

/**
 * Map an ElevenLabs error answer to a short code. Quota and plan limits (`quota_exceeded`, a 401 with that status, or 429
 * `too_many_concurrent_requests` / rate limits) get their own codes so the owner can tell them apart in get_overview.
 * Only the documented `detail.status` word is read from the body; the body itself is never echoed or logged.
 */
export function elevenLabsErrorCode(status: number, body: unknown): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  const word = typeof d === "object" && d !== null && typeof (d as { status?: unknown }).status === "string" ? (d as { status: string }).status : "";
  const w = /^[a-z_]{3,40}$/.test(word) ? word : "";
  if (w === "quota_exceeded" || /quota|credit/.test(w)) return "voice_tts_el_quota";
  if (status === 429 || /concurrent|rate_limit/.test(w)) return "voice_tts_el_rate_limited";
  if (status === 401 || status === 403) return w === "missing_permissions" ? "voice_tts_el_permission" : "voice_tts_el_auth";
  if (w === "voice_not_found" || (status === 404 && !w)) return "voice_tts_el_voice_not_found";
  if (/model/.test(w)) return "voice_tts_el_model";
  return `voice_tts_el_http_${status}`;
}

/** Speak `text` with ElevenLabs. Every failure is a short code; the caller then sends the text instead. */
export async function speakElevenLabs(fetcher: typeof fetch, a: ElevenLabsArgs): Promise<SpeakResult> {
  if (!a.apiKey) return fail("voice_tts_el_key_missing", { voice_language_unsupported: 1 });
  if (!a.voiceId) return fail("voice_tts_el_voice_missing", { voice_language_unsupported: 1 });
  const spoken = speakable(a.text);
  if (!spoken) return { ok: false, code: "voice_empty_text", count: {} };
  if (spoken.length > a.maxChars) return { ok: false, code: "voice_too_long", count: {} };
  const url = `${ELEVENLABS_HOST}/v1/text-to-speech/${encodeURIComponent(a.voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), a.timeoutMs);
  let res: Response;
  let audio: Uint8Array;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "xi-api-key": a.apiKey, "content-type": "application/json", accept: "audio/ogg" },
      body: JSON.stringify({ text: spoken, model_id: a.modelId }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const code = elevenLabsErrorCode(res.status, body);
      return fail(code, code === "voice_tts_el_quota" || code === "voice_tts_el_rate_limited" ? { voice_tts_failed: 1, voice_el_quota: 1 } : { voice_tts_failed: 1 });
    }
    audio = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return fail(ac.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "voice_tts_el_timeout" : "voice_tts_el_network");
  } finally {
    clearTimeout(timer);
  }
  if (audio.length < 64) return fail("voice_tts_empty");
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, code: "voice_too_long", count: {} };
  if (!isMonoOggOpus(audio)) return fail("voice_tts_el_not_ogg_opus");
  const seconds = oggOpusSeconds(audio) ?? 0;
  if (seconds > a.maxSeconds) return { ok: false, code: "voice_too_long", count: {} };
  return { ok: true, ogg: audio, seconds, ttsBytes: audio.length, provider: "elevenlabs" };
}
