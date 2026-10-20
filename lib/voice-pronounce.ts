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
 *    - Imala (Beiruti ā → e after plain consonants), A/B-tested on the Nick voice (VsqtGXzc5Y1q5G3RuCrZ, eleven_v4, 2026-10-20) with
 *      short clips, a formant check (F1/F2 of the vowel) and a Whisper read-back; the bare spelling was said with a plain "a"
 *      (F1 ≈ 600-700 Hz, F2 ≈ 1300-1600 Hz). Chosen spellings and their vowel:
 *        دوام → دويم ("dawem"; read back الدويم), فاتحين → فيتحين ("fet7in"; F1 ≈ 520, F2 ≈ 1750-2000),
 *        لازم → ليزم ("lezem"; F1 ≈ 490, F2 ≈ 1830), ياها / ياه → ييها / ييه ("yeha", "yeh"; F1 ≈ 450-510, F2 ≈ 1800-2050),
 *        ولاد → وليد ("wled"), تلاتين → تليتين ("tletin"; F1 ≈ 380, F2 ≈ 1950), بلاش → بلَيْش ("blesh"; F1 ≈ 450, F2 ≈ 1950;
 *        plain بليش overshot to "ii"), تاني → تِني ("tene"; F1 ≈ 425, F2 ≈ 1890; تيني overshot to "tiini"),
 *        شبّاك → شبّيك ("shebbek"; the voice leans to "ii" here, still nearer than "a").
 *      Left as written because the voice already says e: تمانة (F1 ≈ 540, F2 ≈ 1860), منستنّاك (read back نستنيك).
 *      Not respelled: ā next to emphatic, guttural or r consonants, where Beiruti keeps "a" (طاولة، شغّال، عايشة، رسالة، بياخد).
 *      Applied only for the voices in IMALA_VOICES: the approved Mimi voice already says these with "e" and the respellings made it "ii".
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

/** Voices that say a plain "a" where Beiruti has imala, and so get IMALA_RESPELL. The approved Mimi voice (NQyF5U0t336unYhQXcuv)
 *  already says these words with "e" (A/B 2026-10-20: F2 ≈ 2300-2500 Hz on the bare spelling); the respellings pushed it to "ii"
 *  (F2 ≈ 2800-3000 Hz), so it is not listed. */
export const IMALA_VOICES: readonly string[] = ["VsqtGXzc5Y1q5G3RuCrZ"]; // Nick

/** Imala respellings (see the header), for IMALA_VOICES only. Keys are bare stems; values replace them, clitics kept. */
export const IMALA_RESPELL: Record<string, string> = {
  "دوام": "دويم",
  "فاتحين": "فيتحين",
  "لازم": "ليزم",
  "ياها": "ييها",
  "ياه": "ييه",
  "ولاد": "وليد",
  "تلاتين": "تليتين",
  "بلاش": "بلَيْش",
  "تاني": "تِني",
  "شباك": "شبّيك",
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
const IMALA_RULES: Rule[] = Object.entries(IMALA_RESPELL).map(([k, v]) => rule(k, v));

/** The spoken copy of an Arabic reply, respelled for a Beiruti voice. `changes` counts the words touched (for logs; no text).
 *  `voiceId` (the ElevenLabs voice) turns on the imala respellings for the voices in IMALA_VOICES. */
export function lebaneseSpoken(text: string, opts: { voiceId?: string } = {}): { text: string; changes: number } {
  let out = text;
  let changes = 0;
  const imala = opts.voiceId !== undefined && IMALA_VOICES.includes(opts.voiceId);
  for (const r of imala ? [...IMALA_RULES, ...RULES] : RULES) {
    out = out.replace(r.re, (m: string, lead: string, pre: string) => {
      const next = `${lead}${pre}${r.to}`;
      if (next !== m) changes++;
      return next;
    });
  }
  return { text: out, changes };
}
