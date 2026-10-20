/**
 * xAI text-to-speech for optional voice-note replies (docs/VOICE-REPLIES.md#xai-provider). Used when the owner sets
 * VOICE_REPLY_PROVIDER=xai: Arabic (ar-EG / ar-SA / ar-AE) and every language the Workers AI model cannot speak. It reuses the xAI key
 * the owner already holds for voice calls (XAI_API_KEY); no second account.
 *
 * One POST per reply to api.x.ai/v1/tts asking for a small MP3 (24 kHz, 64 kbps); the in-Worker encoder (lib/voice-encode.ts) turns it
 * into the mono Ogg Opus file WhatsApp shows as a voice note. Both run in the voice Durable Object (src/call-do.ts) for the CPU budget.
 * The key goes only to api.x.ai in the Authorization header; it is never logged, returned or stored. Errors come back as short codes,
 * never as the provider's body. Nothing is retried. The owner's pronunciation list goes along in xAI's own `replace` field.
 */
import type { ArabicReplyDialect } from "./config";
import { oggOpusSeconds } from "./media";
import { speakable, type SpeakResult, type VoiceEncoder } from "./voice-reply";
import { stripAudioTags } from "./voice-style";

export const XAI_TTS_URL = "https://api.x.ai/v1/tts";
/** largest MP3 accepted back before encoding (45 s at 64 kbps is ~360 KB) */
const MAX_MP3_BYTES = 2_000_000;
/** languages xAI lists as supported (docs.x.ai, text-to-speech); others go as `auto` */
const XAI_LANGS: Record<string, string> = {
  en: "en", bn: "bn", zh: "zh", fr: "fr", de: "de", hi: "hi", id: "id", it: "it", ja: "ja", ko: "ko", pt: "pt-BR", ru: "ru", es: "es-ES", tr: "tr", vi: "vi",
};

/** The language code xAI gets. Arabic follows the dialect preset (Egyptian, Gulf) or XAI_TTS_ARABIC_LOCALE; default ar-SA. */
export function xaiLanguage(lang: string, dialect: ArabicReplyDialect, arabicLocale?: string): string {
  if (lang === "ar") {
    if (arabicLocale) return arabicLocale;
    return dialect === "egyptian" ? "ar-EG" : dialect === "gulf" ? "ar-AE" : "ar-SA";
  }
  return XAI_LANGS[lang] ?? "auto";
}

export interface XaiTtsArgs {
  text: string;
  apiKey: string;
  voice: string;
  language: string;
  maxChars: number;
  maxSeconds: number;
  timeoutMs: number;
  replace?: Record<string, string>;
}

export function xaiErrorCode(status: number): string {
  if (status === 401 || status === 403) return "voice_tts_xai_auth";
  if (status === 429) return "voice_tts_xai_rate_limited";
  if (status === 402) return "voice_tts_xai_credits";
  return `voice_tts_xai_http_${status}`;
}

/** Speak `text` with xAI, then encode to Ogg Opus. Every failure is a short code; the caller then sends the text instead. */
export async function speakXai(fetcher: typeof fetch, encode: VoiceEncoder, a: XaiTtsArgs): Promise<SpeakResult> {
  if (!a.apiKey) return { ok: false, code: "voice_tts_xai_key_missing", count: { voice_language_unsupported: 1 } };
  const spoken = stripAudioTags(speakable(a.text));
  if (!spoken) return { ok: false, code: "voice_empty_text", count: {} };
  if (spoken.length > a.maxChars) return { ok: false, code: "voice_too_long", count: {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), a.timeoutMs);
  let mp3: Uint8Array;
  try {
    const res = await fetcher(XAI_TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spoken, voice_id: a.voice, language: a.language,
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 },
        ...(a.replace && Object.keys(a.replace).length ? { replace: a.replace } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok) { void res.body?.cancel().catch(() => {}); return { ok: false, code: xaiErrorCode(res.status), count: { voice_tts_failed: 1 } }; }
    mp3 = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    const code = ac.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "voice_tts_xai_timeout" : "voice_tts_xai_network";
    return { ok: false, code, count: { voice_tts_failed: 1 } };
  } finally {
    clearTimeout(timer);
  }
  if (mp3.length < 64) return { ok: false, code: "voice_tts_empty", count: { voice_tts_failed: 1 } };
  if (mp3.length > MAX_MP3_BYTES) return { ok: false, code: "voice_too_long", count: {} };
  let r: Awaited<ReturnType<VoiceEncoder>>;
  try {
    r = await encode(mp3, { maxSeconds: a.maxSeconds });
  } catch {
    r = { ok: false, code: "encode_failed" };
  }
  if (!r.ok) return r.code === "encode_too_long" ? { ok: false, code: "voice_too_long", count: {} } : { ok: false, code: `voice_${r.code}`.slice(0, 40), count: { voice_encode_failed: 1 } };
  return { ok: true, ogg: r.ogg, seconds: r.seconds || (oggOpusSeconds(r.ogg) ?? 0), ttsBytes: mp3.length, provider: "xai" };
}
