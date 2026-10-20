/**
 * Wording for replies that will be SPOKEN (voice-note replies, docs/VOICE-REPLIES.md#arabic-wording-lebanese-dialect). The bridge does
 * not write replies; the agent does. These lines reach the agent in get_history (`voice_reply.style`) whenever its reply will go
 * out as a voice note, and the send_reply tool description points to them. Text replies are not affected.
 *
 * ARABIC_REPLY_DIALECT=lebanese (default): Beiruti Lebanese, in Arabic script. A voice reads exactly what is written, so formal
 * Arabic or another dialect's forms come out sounding foreign. `none` turns the hint off.
 */
import type { ArabicReplyDialect } from "./config";

export const LEBANESE_VOICE_STYLE = [
  "If this reply is in Arabic it will be spoken as a voice note: write it in Beiruti Lebanese dialect, in Arabic script, the way a friendly person in a Beirut shop talks.",
  "Not formal Arabic (no فصحى) and not Syrian, Egyptian or Gulf forms.",
  "Use Lebanese forms: هلّق (now), شو (what), كيفك (how are you), منيح (good), بدّك (you want), عنّا (we have), مش (not; never مو), لكان (then / of course).",
  "Write كرميلك exactly like this (said kirmelak, for your sake); never كرمالك and never منشان.",
  "Friendly Lebanese phrases: بزبّطلك (I'll sort it for you), تكرم عينك (with pleasure), يسلملي قلبك (thank you, warmly).",
  "Keep it short and natural (one or two sentences, well under the spoken length cap); no lists, links, emojis or markdown, because a voice reads them out.",
].join(" ");

/** The style hint for a reply that will be spoken, or null when no hint applies. */
export function spokenStyle(dialect: ArabicReplyDialect): string | null {
  return dialect === "lebanese" ? LEBANESE_VOICE_STYLE : null;
}
