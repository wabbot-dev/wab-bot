/**
 * Lebanese pronunciation layer for SPOKEN Arabic replies (docs/VOICE-REPLIES.md#pronunciation-layer). It runs right before ElevenLabs
 * text-to-speech, on the spoken copy only: the reply text that is stored and shown is never changed.
 *
 * 1. Shadda spellings from the owner's approved studio script (Mimi, 2026-10-20). That script used no fatha, kasra or damma at all,
 *    only shadda (ّ) on doubled consonants (هلّق، بدّك، عنّا، قدّيش، كلّ، نصّ، مرّة، يلّا ...). When a reply writes one of those words
 *    without it, the shadda is added back, so the voice gets the same spelling it was approved with.
 * 2. Respellings that change how the voice says a word, each A/B-tested on the voice before it is added:
 *    - الساعة / ساعة → السيعة / سيعة: Beiruti "se3a" (imala), not "sa3a" (A/B 2026-10-20: the vowel after the s moved from
 *      F1 ≈ 790 Hz to ≈ 610 Hz with F2 ≈ 2400 Hz, an "e"; the transcript read it back as السيعة).
 *    - كرمالك → كرميلك (said "kirmelak"), the approved script's own spelling.
 * Words are matched whole, with the common clitics in front (و ف ب ل ع ك ال لل عال بال), ignoring any vowel marks already present.
 */

const AR_LETTER = "\u0621-\u064A\u066E-\u06D3";
const MARKS = "\u064B-\u0652\u0670";
const MARKS_RE = new RegExp(`[${MARKS}]`, "g");
const PREFIX = "(?:و|ف)?(?:بال|عال|لل|ال|ب|ل|ع|ك)?";

/** Approved spellings (from the studio script) that differ from a bare spelling only by shadda. Ambiguous bare forms are left out
 *  (هم they / همّ worry, أي yes / أيّ any, حد someone / حدّ next to, جد grandfather / جدّ, منك, نية, حرة). */
export const APPROVED_SHADDA = [
  "هلّق", "بدّك", "بدّي", "بدّكن", "بدّو", "بدّا", "عنّا", "قدّيش", "قلّي", "قلّك", "قلّو", "ستّة", "كلّ", "نصّ", "مرّة", "أوّل", "إلّا",
  "يلّا", "جوّا", "قدّام", "بزبّطلك", "بزبّطلكن", "يهمّك", "تجرّب", "بتحبّ", "بتفضّل", "بتطلّ", "بتبلّش", "مسكّرين", "منحضّرلكن",
  "منغنّيلكن", "منطفّي", "جوّ", "حمّص", "فتّوش", "كبّة", "شبّاك", "خطّة",
];

/** Respellings verified on the voice (see the header). Keys are bare stems; values replace them, clitics kept. */
export const RESPELL: Record<string, string> = {
  "ساعة": "سيعة",
  "ساعه": "سيعة",
  "كرمالك": "كرميلك",
  "كرمالكن": "كرميلكن",
};

type Rule = { re: RegExp; to: string };
const bare = (w: string) => w.replace(MARKS_RE, "");
/** a stem whose letters may each carry vowel marks already */
const loose = (stem: string) => [...stem].map((ch) => `${ch}[${MARKS}]*`).join("");
const rule = (stem: string, to: string): Rule => ({
  re: new RegExp(`(^|[^${AR_LETTER}${MARKS}])(${PREFIX})${loose(stem)}(?![${AR_LETTER}${MARKS}])`, "g"),
  to,
});

const RULES: Rule[] = [
  ...Object.entries(RESPELL).map(([k, v]) => rule(k, v)),
  ...APPROVED_SHADDA.map((w) => rule(bare(w), w)),
];

/** The spoken copy of an Arabic reply, respelled for a Beiruti voice. `changes` counts the words touched (for logs; no text). */
export function lebaneseSpoken(text: string): { text: string; changes: number } {
  let out = text;
  let changes = 0;
  for (const r of RULES) {
    out = out.replace(r.re, (m: string, lead: string, pre: string) => {
      const next = `${lead}${pre}${r.to}`;
      if (next !== m) changes++;
      return next;
    });
  }
  return { text: out, changes };
}
