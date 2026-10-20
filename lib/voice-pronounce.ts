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
 *    - Imala (Beiruti ā → a short or mid "e", never a long "ii"), for the Nick voice only (VsqtGXzc5Y1q5G3RuCrZ, eleven_v4).
 *      Round 2 (2026-10-20, after the owner heard "see3a" and "shebbiik"): short clips with character timestamps, every 5 ms of the
 *      vowel classed from F1/F2 as "ii" (F1 < 420 Hz, F2 > 1950 Hz), "e" (F1 420-610, F2 > 1700) or "a", and the longest run of each
 *      measured; a respelling that gives a long "ii" run fails, and "a" is preferred to "ii". Kept (2-6 takes each, no long "ii"):
 *        ساعة → سَيْعة (so الساعة → السَيْعة; "se3a": an "e" of 50-85 ms in 4 of 6 takes, otherwise "a"; السيعة and السَيعة
 *          start with 25-70 ms of "ii", the "see3a" the owner heard), دوام → دَويم (the owner's own spelling, 2026-10-20: الدوِم
 *          came out "doom"; with الدَويم Nick says a short open "da" (~55 ms, F1 ≈ 550-610 Hz), a consonant w, then a front
 *          vowel of ~100-110 ms at F1 ≈ 380-470, F2 ≈ 1950-2250, close to "ee"; kept as the owner chose it),
 *        فاتحين → فِتحين ("fet7in"; "e" 80-90 ms; فيتحين was "ii" 95 ms), لازم → ليزم ("lezem"; "e" 75 ms, no "ii"),
 *        ياها → يَها ("yeha"; "e" 50-90 ms; ييها was "ii" 110 ms), بلاش → بلَيْش ("blesh"; "e" 65-75 ms),
 *        تاني → تِني ("tene"; a short "e" 20-35 ms; تيني was "ii").
 *      Left as written (no form reached a short "e" without "ii", or the voice already says "e"): شبّاك (شبّيك / شبَّيْك / شبَّيك
 *      were "ii" 65-150 ms, شِبّاك / شبَّاك stay "a", شبّك / شبِّك a short schwa), ياه (يَه / ييه start with 55-135 ms of "ii"),
 *      ولاد (وليد and وَلَيْد were "ii"; the bare spelling is already near "e"), تلاتين (تليتين was "ii" 125-150 ms; the bare
 *      spelling already gives "e"), تمانة and منستنّاك (already "e").
 *      Not respelled: ā next to emphatic, guttural or r consonants, where Beiruti keeps "a" (طاولة، شغّال، عايشة، رسالة، بياخد).
 *      The approved Mimi voice already says these words with "e" and keeps السيعة; it gets none of this.
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

/** Imala respellings (see the header), for IMALA_VOICES only; they run before RESPELL. Keys are bare stems; values replace them,
 *  clitics kept. */
export const IMALA_RESPELL: Record<string, string> = {
  "ساعة": "سَيْعة", // overrides RESPELL's سيعة for these voices (said "see3a")
  "ساعه": "سَيْعة",
  "دوام": "دَويم", // the owner's spelling (الدَويم)
  "فاتحين": "فِتحين",
  "لازم": "ليزم",
  "ياها": "يَها",
  "بلاش": "بلَيْش",
  "تاني": "تِني",
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
