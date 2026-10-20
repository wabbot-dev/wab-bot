/**
 * Spoken-copy pronunciation layer for voice-note replies (docs/VOICE-REPLIES.md#pronunciation). It runs right before text-to-speech,
 * on the SPOKEN copy only: the reply text that is stored, shown in the inbox and sent as the text fallback is never changed.
 *
 * Two sources, both optional and both off unless the owner turns them on:
 *  1. The owner's own pronunciation list (VOICE_PRONUNCIATIONS): "written => spoken" pairs, e.g. a brand name the voice says wrong,
 *     or a respelling that makes a chosen voice sound like the local dialect. Whole words only; for Arabic the common clitics in front
 *     (و ف ب ل ع ك ال لل عال بال) are kept and vowel marks already present are ignored. The list is data, never code: what works is
 *     voice-specific, so each owner tests it on their own voice.
 *  2. The dialect preset's spelling marks (ARABIC_REPLY_DIALECT, lib/voice-style.ts). Only the `lebanese` preset has any today: shadda
 *     (ّ) on common doubled-consonant words of spoken Lebanese (هلّق، بدّك، عنّا ...), which helps most Arabic voices read them as the
 *     dialect, not as formal Arabic. No business words, no voice-specific respellings.
 * xAI text-to-speech also accepts the owner's list natively (its `replace` field); lib/tts-xai.ts passes it there as well.
 */
import type { ArabicReplyDialect } from "./config";

const AR_LETTER = "\u0621-\u064A\u066E-\u06D3";
const MARKS = "\u064B-\u0652\u0670";
const MARKS_RE = new RegExp(`[${MARKS}]`, "g");
const AR_RE = new RegExp(`[${AR_LETTER}]`);
const PREFIX = "(?:و|ف)?(?:بال|عال|لل|ال|ب|ل|ع|ك)?";

/** Lebanese preset: spoken-Lebanese function words whose usual spelling differs only by shadda. Ambiguous bare forms are left out
 *  (هم they / همّ worry, أي yes / أيّ any, حد someone / حدّ, جد / جدّ). */
export const LEBANESE_SHADDA = [
  "هلّق", "بدّك", "بدّي", "بدّكن", "بدّو", "بدّا", "عنّا", "قدّيش", "قلّي", "قلّك", "قلّو", "ستّة", "كلّ", "نصّ", "مرّة", "أوّل", "إلّا",
  "يلّا", "جوّا", "قدّام", "يهمّك", "تجرّب", "بتحبّ", "بتفضّل",
];

/** Most pairs accepted from VOICE_PRONUNCIATIONS (a request stays small; xAI's `replace` gets the same list). */
export const MAX_PRONUNCIATIONS = 100;

/**
 * Parse VOICE_PRONUNCIATIONS: a JSON object {"written":"spoken"} or lines/semicolon-separated `written => spoken` (or `written=spoken`).
 * Anything malformed is skipped, never thrown: a typo must not stop voice replies. Keys and values are 1..60 characters.
 */
export function parsePronunciations(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = v?.trim();
  if (!raw) return out;
  const put = (k: unknown, val: unknown) => {
    if (typeof k !== "string" || typeof val !== "string") return;
    const a = k.trim(), b = val.trim();
    if (!a || !b || a.length > 60 || b.length > 60 || /[[\]<>\n]/.test(a + b)) return;
    if (Object.keys(out).length < MAX_PRONUNCIATIONS) out[a] = b;
  };
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, val] of Object.entries(o)) put(k, val);
    } catch { /* malformed: nothing */ }
    return out;
  }
  for (const part of raw.split(/[;\n]/)) {
    const m = /^(.+?)\s*(?:=>|=)\s*(.+)$/.exec(part.trim());
    if (m) put(m[1], m[2]);
  }
  return out;
}

type Rule = { re: RegExp; to: string };
const bare = (w: string) => w.replace(MARKS_RE, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** a stem whose letters may each carry vowel marks already */
const loose = (stem: string) => [...stem].map((ch) => `${escape(ch)}[${MARKS}]*`).join("");

function rule(from: string, to: string): Rule {
  if (AR_RE.test(from)) {
    return { re: new RegExp(`(^|[^${AR_LETTER}${MARKS}])(${PREFIX})${loose(bare(from))}(?![${AR_LETTER}${MARKS}])`, "g"), to };
  }
  // Latin and other scripts: whole word, case-insensitive
  return { re: new RegExp(`(^|[^\\p{L}\\p{N}])()${escape(from)}(?![\\p{L}\\p{N}])`, "giu"), to };
}

const PRESET_RULES: Partial<Record<ArabicReplyDialect, Rule[]>> = {
  lebanese: LEBANESE_SHADDA.map((w) => rule(bare(w), w)),
};

/**
 * The spoken copy of a reply. `dialect` adds the preset's marks (Arabic only), `pronunciations` the owner's own list (applied first,
 * so an owner entry wins). `changes` counts the words touched (for logs; never the text).
 */
export function spokenCopy(text: string, opts: { lang: string; dialect?: ArabicReplyDialect; pronunciations?: Record<string, string> }): { text: string; changes: number } {
  let out = text;
  let changes = 0;
  const own = Object.entries(opts.pronunciations ?? {}).map(([k, v]) => rule(k, v));
  const preset = opts.lang === "ar" && opts.dialect ? PRESET_RULES[opts.dialect] ?? [] : [];
  for (const r of [...own, ...preset]) {
    out = out.replace(r.re, (m: string, lead: string, pre: string) => {
      const next = `${lead}${pre}${r.to}`;
      if (next !== m) changes++;
      return next;
    });
  }
  return { text: out, changes };
}
