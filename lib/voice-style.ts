/**
 * Wording for replies that will be SPOKEN (voice-note replies, docs/VOICE-REPLIES.md#arabic-dialect-presets). The bridge does not write
 * replies; the agent does. A preset's lines reach the agent in get_history (`voice_reply.arabic_style`) whenever its reply will go out
 * as a voice note, and the send_reply tool description points to them. Text replies are not affected.
 *
 * ARABIC_REPLY_DIALECT selects the preset: `none` (default: no hint, the agent writes as it would for text), `msa` (Modern Standard
 * Arabic), `lebanese`, `gulf`, `egyptian`. A voice reads exactly what is written, so a dialect reply must be WRITTEN in that dialect.
 * Presets are generic language guidance only: no business words, no voice ids, no studio scripts.
 */
import type { ArabicReplyDialect } from "./config";

const COMMON =
  "Keep it short and natural (one to three short sentences, under the spoken length cap); no lists, links, emojis, markdown or [brackets], because a voice reads them out. Write numbers and times as words.";

export const DIALECT_STYLES: Record<Exclude<ArabicReplyDialect, "none">, string> = {
  msa: [
    "If this reply is in Arabic it will be SPOKEN as a voice note: write clear, simple Modern Standard Arabic (فصحى مبسطة), polite and warm, in Arabic script.",
    "Avoid rare words and long sentences; add no vowel marks except where a word would be misread.",
    COMMON,
  ].join(" "),
  lebanese: [
    "If this reply is in Arabic it will be SPOKEN as a voice note, so write it the way people TALK in Lebanon: colloquial Lebanese Arabic, in Arabic script, warm and natural.",
    "Not formal Arabic (no فصحى) and not another dialect's phrasing.",
    "Typical spoken forms: أهلا فيك، كيفك، هلّق، شو، بدّك، عنّا، فيك، رح، منيح، كتير، إيه؛ negation with مش.",
    "Swap formal words for spoken ones: الآن → هلّق، ماذا → شو، نحن → نحنا، لدينا → عنّا، يمكنك → فيك، سوف → رح، جداً → كتير، نعم → إيه؛ drop هل in questions.",
    "Put shadda (ّ) on doubled letters (هلّق، بدّك، عنّا، كلّ، مرّة) and no other vowel marks.",
    COMMON,
  ].join(" "),
  gulf: [
    "If this reply is in Arabic it will be SPOKEN as a voice note, so write it in natural Gulf Arabic (Khaleeji), in Arabic script, polite and warm.",
    "Not formal Arabic (no فصحى) and not another dialect's phrasing. Typical spoken forms: هلا والله، شلونك، الحين، وش، أبي، عندنا، تقدر، إن شاء الله؛ negation with مو or ما.",
    COMMON,
  ].join(" "),
  egyptian: [
    "If this reply is in Arabic it will be SPOKEN as a voice note, so write it in natural Egyptian Arabic, in Arabic script, friendly and polite.",
    "Not formal Arabic (no فصحى) and not another dialect's phrasing. Typical spoken forms: أهلاً بيك، إزيك، دلوقتي، إيه، عايز، عندنا، تقدر، حاضر؛ negation with مش.",
    COMMON,
  ].join(" "),
};

/** The style hint for a reply that will be spoken, or null when no preset is selected. */
export function spokenStyle(dialect: ArabicReplyDialect): string | null {
  return dialect === "none" ? null : DIALECT_STYLES[dialect];
}

/** ElevenLabs' tag-aware models (eleven_v3, eleven_v4) read a leading [direction] as an instruction, not as words. */
export const supportsAudioTags = (modelId: string): boolean => /^eleven_v[34](_|$)/.test(modelId);

/** Remove any square-bracket text from the reply before speaking, so neither the agent nor quoted customer text can inject tags. */
export const stripAudioTags = (text: string): string => text.replace(/\[[^\]\n]{0,200}\]/g, " ").replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();

/** VOICE_STYLE_TAG: the owner's own delivery direction, e.g. "[warm, friendly]" or an accent. Brackets added if missing; null if unsafe. */
export function styleTagOf(v: string | undefined): string | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  const inner = t.replace(/^\[|\]$/g, "").trim();
  if (!inner || inner.length > 80 || /[[\]<>\n]/.test(inner)) return undefined;
  return `[${inner}]`;
}
