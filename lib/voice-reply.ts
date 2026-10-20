/**
 * Optional voice-note replies (docs/VOICE-REPLIES.md), OFF by default (VOICE_REPLIES).
 *
 * send_reply decides here whether a text reply should ALSO be spoken: Workers AI text-to-speech (MP3), then the in-Worker
 * encoder turns it into Ogg Opus (lib/voice-encode.ts); both run in a Durable Object (ctx.speakVoice) for the CPU budget. Then the file is
 * uploaded to this number's Meta media store and sent as an audio message with voice: true. The reply text is always stored in
 * history. Any failure on the way (unsupported language, cap, model error, encoder, upload) sends the plain text instead and is
 * counted in get_overview's media block. Nothing is retried, nothing is logged but short codes, and no audio is persisted.
 *
 * VOICE_REPLY_PROVIDER=elevenlabs (lib/tts-elevenlabs.ts) speaks Arabic, and every language the Workers AI model lacks, with the
 * owner's ElevenLabs voice instead; ElevenLabs returns Ogg Opus directly, so that path needs no encoder and no Durable Object.
 */
import { fetchTimeout, type Ctx } from "./ctx";
import { aiErrorCode, oggOpusSeconds, recordCounts, type AiRunner, type MediaCounts } from "./media";
import type { Config } from "./config";
import { speakElevenLabs } from "./tts-elevenlabs";
import { lebaneseSpoken } from "./voice-pronounce";
import { LEBANESE_ACCENT_TAG, spokenStyle, supportsAudioTags } from "./voice-style";
import type { Conv, Msg } from "./types";

export type ReplyAs = "auto" | "text" | "voice";

/** What the encoder hands back (it runs in a Durable Object in production, so errors come back as codes, not exceptions). */
export type VoiceEncodeResult = { ok: true; ogg: Uint8Array; seconds: number } | { ok: false; code: string };
export type VoiceEncoder = (input: Uint8Array, opts: { maxSeconds: number }) => Promise<VoiceEncodeResult>;

const GRAPH_UPLOAD_TIMEOUT_MS = 10_000;
/** WhatsApp shows the play button only for voice notes up to 512 KB (a download arrow above that). */
export const VOICE_MAX_OGG_BYTES = 500_000;
export const VOICE_MIME = "audio/ogg; codecs=opus";

/**
 * Languages each supported text-to-speech model can speak, as ISO 639-1 codes, mapped to the code the model expects.
 * MeloTTS (MyShell, MIT): English, French, Spanish, Chinese, Japanese, Korean. Deepgram Aura: English (aura-2-es: Spanish).
 * No Workers AI text-to-speech model speaks Arabic today, so Arabic replies always go as text.
 */
export function ttsLanguages(model: string): Record<string, string> {
  if (/\/melotts$/.test(model)) return { en: "en", fr: "fr", es: "es", zh: "zh", ja: "jp", ko: "kr" };
  if (/\/aura-2-es$/.test(model)) return { es: "es" };
  if (/\/deepgram\/aura-(1|2-en)$/.test(model)) return { en: "en" };
  return {};
}

export const isVoiceNote = (m: Msg | undefined): boolean => !!m && m.dir === "in" && m.type === "audio" && /^\[voice note\b/.test(m.text);
const lastInbound = (c: Conv): Msg | undefined => [...c.messages].reverse().find((m) => m.dir === "in" && m.type !== "reaction");

/** The writing system decides when it is not Latin (an Arabic-script reply is never read out by an English voice). */
export function scriptLanguage(text: string): string | null {
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return "ar";
  if (/[\u3040-\u30FF]/.test(text)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  return null;
}

/** Should this text reply go as a voice note? `reason` explains a no when the agent asked for voice (never counted as a failure). */
export function chooseVoice(cfg: Config, c: Conv, replyAs: ReplyAs | undefined): { voice: boolean; reason?: string } {
  const ask = replyAs ?? "auto";
  if (ask === "text") return { voice: false };
  const mirror = isVoiceNote(lastInbound(c));
  if (cfg.voiceReplies === "off") return ask === "voice" ? { voice: false, reason: "voice_replies_off" } : { voice: false };
  if (cfg.voiceReplies === "mirror") {
    if (mirror) return { voice: true };
    return ask === "voice" ? { voice: false, reason: "mirror_mode_customer_did_not_send_a_voice_note" } : { voice: false };
  }
  return { voice: ask === "voice" || mirror };
}

/** Language to speak: the script of the text wins, then the agent's voice_language, then the language of the customer's voice note. */
export function voiceLanguage(c: Conv, text: string, asked?: string): string | null {
  const s = scriptLanguage(text);
  if (s) return s;
  if (asked && /^[a-z]{2}$/.test(asked)) return asked;
  const last = lastInbound(c);
  return isVoiceNote(last) && last!.media?.lang ? last!.media.lang : null;
}

/** Strip what a voice should not read out (markdown marks, bare links). */
export function speakable(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/[*_~`#>|]/g, " ").replace(/\s+/g, " ").trim();
}

type Prep =
  | { ok: true; mediaId: string; seconds: number; bytes: number; provider: "workers-ai" | "elevenlabs" }
  | { ok: false; code: string; count: Partial<MediaCounts> };

async function bytesOf(out: unknown): Promise<Uint8Array | null> {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out && typeof (out as ReadableStream).getReader === "function") return new Uint8Array(await new Response(out as ReadableStream).arrayBuffer());
  const a = (out as { audio?: unknown } | null)?.audio;
  if (typeof a === "string" && a.length > 0) {
    const bin = atob(a);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  return null;
}

/** A mono Ogg Opus file (what Deepgram Aura returns when asked for opus/ogg) can be sent as it is. */
export function isMonoOggOpus(b: Uint8Array): boolean {
  if (b.length < 47 || b[0] !== 0x4f || b[1] !== 0x67 || b[2] !== 0x67 || b[3] !== 0x53) return false;
  const head = 27 + b[26]!;
  return String.fromCharCode(...b.subarray(head, head + 8)) === "OpusHead" && b[head + 9] === 1;
}

export interface SpeakArgs { text: string; lang: string; model: string; maxSeconds: number; timeoutMs: number }
export type SpeakResult = { ok: true; ogg: Uint8Array; seconds: number; ttsBytes: number; provider?: "workers-ai" | "elevenlabs" } | { ok: false; code: string; count: Partial<MediaCounts> };
/** Text-to-speech + encoding in one step. In production a Durable Object runs it (src/call-do.ts), so the model's large audio
 *  answer is decoded and encoded there (30 s CPU per invocation) and only the small Ogg file comes back to the request. */
export type VoiceSpeaker = (a: SpeakArgs) => Promise<SpeakResult>;

/** The work itself, given an AI runner and an encoder. `lang` must already be a language of the model (see ttsLanguages). */
export async function speak(ai: AiRunner, encode: VoiceEncoder, a: SpeakArgs): Promise<SpeakResult> {
  const code = ttsLanguages(a.model)[a.lang];
  if (!code) return { ok: false, code: `voice_language_unsupported_${a.lang}`.slice(0, 40), count: { voice_language_unsupported: 1 } };
  const spoken = speakable(a.text);
  if (!spoken) return { ok: false, code: "voice_empty_text", count: {} };
  let audio: Uint8Array | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = /\/deepgram\/aura/.test(a.model) ? { text: spoken, encoding: "opus", container: "ogg" } : { prompt: spoken, lang: code };
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), a.timeoutMs); });
    audio = await bytesOf(await Promise.race([ai.run(a.model, input), timeout]));
  } catch (e) {
    const t = e instanceof Error && e.message === "timeout" ? "ai_timeout" : aiErrorCode(e).code;
    return { ok: false, code: `voice_tts_${t}`.slice(0, 40), count: { voice_tts_failed: 1 } };
  } finally {
    clearTimeout(timer);
  }
  if (!audio || audio.length < 64) return { ok: false, code: "voice_tts_empty", count: { voice_tts_failed: 1 } };
  if (isMonoOggOpus(audio)) {
    const s = oggOpusSeconds(audio) ?? 0;
    if (s > a.maxSeconds) return { ok: false, code: "voice_too_long", count: {} };
    return { ok: true, ogg: audio, seconds: s, ttsBytes: audio.length };
  }
  let r: VoiceEncodeResult;
  try {
    r = await encode(audio, { maxSeconds: a.maxSeconds });
  } catch {
    r = { ok: false, code: "encode_failed" };
  }
  if (!r.ok) return r.code === "encode_too_long" ? { ok: false, code: "voice_too_long", count: {} } : { ok: false, code: `voice_${r.code}`.slice(0, 40), count: { voice_encode_failed: 1 } };
  return { ok: true, ogg: r.ogg, seconds: r.seconds, ttsBytes: audio.length };
}

export type TtsProvider = "workers-ai" | "elevenlabs";

/**
 * Which provider speaks `lang`. Workers AI (the default) keeps every language its model speaks. With VOICE_REPLY_PROVIDER=elevenlabs,
 * Arabic, and any language the Workers AI model lacks, go to ElevenLabs (its eleven_* models are multilingual). null = no voice.
 */
export function ttsProviderFor(cfg: Config, lang: string): TtsProvider | null {
  const workers = !!ttsLanguages(cfg.voiceTtsModel)[lang];
  if (cfg.voiceReplyProvider === "elevenlabs" && /^[a-z]{2}$/.test(lang) && (lang === "ar" || !workers)) return "elevenlabs";
  return workers ? "workers-ai" : null;
}

/** Languages the configured providers can speak, for get_overview ("*" = any other language, through ElevenLabs). */
export function voiceLanguagesOf(cfg: Config): string[] {
  const w = Object.keys(ttsLanguages(cfg.voiceTtsModel));
  return cfg.voiceReplyProvider === "elevenlabs" ? ["ar", ...w.filter((l) => l !== "ar"), "*"] : w;
}

/** Speak `text` in `lang` with the configured model: through ctx.speakVoice (the Durable Object), or `inline` in this request (self-test). */
export async function synthesize(ctx: Ctx, text: string, lang: string, where: "do" | "inline" = "do"): Promise<SpeakResult> {
  const cfg = ctx.cfg;
  const a: SpeakArgs = { text, lang, model: cfg.voiceTtsModel, maxSeconds: cfg.voiceMaxSeconds, timeoutMs: cfg.voiceTimeoutMs };
  const provider = ttsProviderFor(cfg, lang);
  if (!provider) return { ok: false, code: `voice_language_unsupported_${lang}`.slice(0, 40), count: { voice_language_unsupported: 1 } };
  if (provider === "elevenlabs") {
    // a network call, not CPU work: it runs in this request (no Durable Object needed); the key goes to api.elevenlabs.io only
    const lebanese = lang === "ar" && cfg.arabicReplyDialect === "lebanese";
    // pronunciation layer: the SPOKEN copy only (approved-script shadda + verified respellings); the stored reply text is untouched
    const p = lebanese ? lebaneseSpoken(text, { voiceId: cfg.elevenlabsVoiceId }) : { text, changes: 0 };
    if (p.changes) ctx.log("voice_pronounce", { lang, changes: p.changes });
    try {
      return await speakElevenLabs(ctx.fetch, {
        text: p.text, apiKey: cfg.elevenlabsApiKey ?? "", voiceId: cfg.elevenlabsVoiceId ?? "", modelId: cfg.elevenlabsModelId,
        maxChars: cfg.elevenlabsMaxChars, maxSeconds: cfg.voiceMaxSeconds, timeoutMs: cfg.voiceTimeoutMs,
        accentTag: lebanese && cfg.elevenlabsAccentTag && supportsAudioTags(cfg.elevenlabsModelId) ? LEBANESE_ACCENT_TAG : undefined,
      });
    } catch {
      return { ok: false, code: "voice_tts_el_error", count: { voice_tts_failed: 1 } };
    }
  }
  try {
    if (where === "inline") {
      if (!ctx.ai || !ctx.encodeVoiceInline) return { ok: false, code: "voice_unavailable", count: {} };
      return await speak(ctx.ai, ctx.encodeVoiceInline, a);
    }
    if (!ctx.speakVoice) return { ok: false, code: "voice_unavailable", count: {} };
    return await ctx.speakVoice(a);
  } catch {
    return { ok: false, code: "voice_speaker_error", count: { voice_tts_failed: 1 } };
  }
}

/** Upload to this number's Meta media store (the token goes to graph.facebook.com only). Returns the media id or a short code. */
export async function uploadVoice(ctx: Ctx, pn: string, ogg: Uint8Array): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", VOICE_MIME);
  form.set("file", new Blob([ogg as unknown as ArrayBuffer], { type: VOICE_MIME }), "voice.ogg");
  let res: Response;
  try {
    res = await fetchTimeout(ctx, `https://graph.facebook.com/${ctx.cfg.graphVersion}/${encodeURIComponent(pn)}/media`, {
      method: "POST", headers: { Authorization: `Bearer ${ctx.cfg.waAccessToken}` }, body: form,
    }, GRAPH_UPLOAD_TIMEOUT_MS);
  } catch {
    return { ok: false, code: "voice_upload_network" };
  }
  const j = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (!res.ok || typeof j.id !== "string" || !/^[0-9]{5,30}$/.test(j.id)) return { ok: false, code: `voice_upload_http_${res.status}` };
  return { ok: true, id: j.id };
}

/** Everything before the send: caps, language, speech, encoding, upload. On any failure the caller sends the text. */
export async function prepareVoice(ctx: Ctx, c: Conv, text: string, askedLang?: string): Promise<Prep> {
  const cfg = ctx.cfg;
  if (text.length > cfg.voiceMaxChars) return { ok: false, code: "voice_too_long", count: {} };
  const lang = voiceLanguage(c, text, askedLang);
  if (!lang) return { ok: false, code: "voice_language_unknown", count: { voice_language_unsupported: 1 } };
  const s = await synthesize(ctx, text, lang);
  if (!s.ok) return s;
  if (s.ogg.length > VOICE_MAX_OGG_BYTES) return { ok: false, code: "voice_too_long", count: {} };
  const up = await uploadVoice(ctx, c.phone_number_id, s.ogg);
  if (!up.ok) return { ok: false, code: up.code, count: { voice_upload_failed: 1 } };
  ctx.log("voice_prepared", { conv: c.id, provider: s.provider ?? "workers-ai", ogg_bytes: s.ogg.length, seconds: Math.round(s.seconds * 10) / 10, upload: "ok" });
  return { ok: true, mediaId: up.id, seconds: s.seconds, bytes: s.ogg.length, provider: s.provider ?? "workers-ai" };
}

/** Counters only; never fails the send. */
export async function recordVoice(ctx: Ctx, count: Partial<MediaCounts>, failure?: string): Promise<void> {
  try { await recordCounts(ctx, count, failure); } catch { /* counters only */ }
}

/**
 * What get_history tells the agent about a coming voice reply (absent while VOICE_REPLIES is off): whether the reply will be spoken
 * (`expected`, mirror of a customer voice note) or may be (`on` mode with reply_as "voice"), and the wording to use when it is Arabic.
 */
export function voiceReplyHint(cfg: Config, c: Conv): Record<string, unknown> | null {
  if (cfg.voiceReplies === "off") return null;
  const expected = chooseVoice(cfg, c, "auto").voice;
  const style = spokenStyle(cfg.arabicReplyDialect);
  return {
    mode: cfg.voiceReplies,
    expected,
    provider: cfg.voiceReplyProvider,
    max_chars: cfg.voiceReplyProvider === "elevenlabs" ? Math.min(cfg.voiceMaxChars, cfg.elevenlabsMaxChars) : cfg.voiceMaxChars,
    ...(style && (expected || cfg.voiceReplies === "on") ? { arabic_style: style } : {}),
  };
}
