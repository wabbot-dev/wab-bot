/**
 * Wording for replies that will be SPOKEN (voice-note replies, docs/VOICE-REPLIES.md#arabic-wording-lebanese-dialect). The bridge does
 * not write replies; the agent does. These lines reach the agent in get_history (`voice_reply.arabic_style`) whenever its reply will go
 * out as a voice note, and the send_reply tool description points to them. Text replies are not affected.
 *
 * ARABIC_REPLY_DIALECT=lebanese (default): colloquial Beiruti Lebanese, in Arabic script. A voice reads exactly what is written, so
 * formal Arabic or another dialect's words come out sounding foreign. `none` turns the hint off.
 */
import type { ArabicReplyDialect } from "./config";

export const LEBANESE_VOICE_STYLE = [
  "If this reply is in Arabic it will be SPOKEN as a voice note, so write it the way people TALK in Beirut: colloquial Beiruti Lebanese, in Arabic script, warm and casual, like a friendly person in a Beirut shop.",
  "Never formal or written Arabic (no فصحى), and not Syrian, Egyptian, Gulf or generic Levantine phrasing.",
  "Use these Lebanese forms: أهلين فيك، كيفك، نحنا هون كرميلك، هلّق، شو بتحب، بدّك، عنّا، فيك، رح، منيح، بزبّطلك ياها، تكرم عينك، لكان، يسلملي قلبك، ولا يهمّك.",
  "Spell spoken words the way the approved Lebanese script does: put shadda (ّ) on doubled letters, as in هلّق، بدّك، عنّا، قدّيش، قلّي، كلّ، نصّ، مرّة، يلّا، ستّة، بزبّطلك، تجرّب؛ add no other vowel marks (no fatha, kasra or damma).",
  "Swap formal words for spoken ones: الآن → هلّق، ماذا → شو، نحن → نحنا، لدينا → عنّا، يمكنك → فيك، سوف → رح، جداً → كتير، شكراً → يسلملي قلبك، نعم → إيه؛ drop هل in questions.",
  "Negation is مش, never مو. Write كرميلك exactly like this (said kirmelak); never كرمالك, never منشان or مشان. Not Syrian شلونك or Egyptian عايز / إزيك.",
  "Write times and numbers as spoken Lebanese words, not digits: تمانة، تلاتة، عشرة، نصّ ساعة.",
  "Keep it short and natural (one to three short sentences, under the spoken length cap); no lists, links, emojis, markdown or [brackets], because a voice reads them out.",
].join(" ");

/** The style hint for a reply that will be spoken, or null when no hint applies. */
export function spokenStyle(dialect: ArabicReplyDialect): string | null {
  return dialect === "lebanese" ? LEBANESE_VOICE_STYLE : null;
}

/**
 * Inline delivery direction that ElevenLabs' tag-aware models (eleven_v3, eleven_v4) read as an instruction, not as words. In the A/B
 * run of 2026-10-20 it moved the owner's Lebanese voice closer to its approved studio sample than the bare text did, while forcing
 * language_code "ar" pushed it toward standard Arabic. Only for Arabic, only with the Lebanese dialect on, only for those models.
 */
export const LEBANESE_ACCENT_TAG = "[casual Beiruti Lebanese accent]";
export const supportsAudioTags = (modelId: string): boolean => /^eleven_v[34](_|$)/.test(modelId);

/** Remove any square-bracket text from the reply before speaking, so neither the agent nor quoted customer text can inject tags. */
export const stripAudioTags = (text: string): string => text.replace(/\[[^\]\n]{0,200}\]/g, " ").replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
