/**
 * Per-language settings for voice-note replies (docs/VOICE-REPLIES.md#a-voice-per-language): ELEVENLABS_VOICE_IDS, ELEVENLABS_MODEL_IDS
 * and VOICE_STYLE_TAGS. Each is a JSON object ({"ar":"<id>","en":"<id>"}) or `lang=value` entries separated by commas, semicolons or new
 * lines (style tags: semicolons or new lines only, because a tag may contain commas). Keys are two-letter ISO 639-1 codes.
 *
 * A malformed entry (bad language code, bad value, broken JSON) is skipped and counted, never thrown: a typo must not stop voice replies,
 * and the language falls back to the single setting (ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, VOICE_STYLE_TAG). The count is logged as
 * `voice_map_ignored` and shown in get_overview. Voice and model ids are not secrets; no key is ever part of these settings.
 */
export type LangMap = Readonly<Record<string, string>>;

/** At most this many languages per map (a deployment speaks a handful; the rest is a typo or junk). */
export const MAX_LANG_ENTRIES = 40;
const LANG_RE = /^[a-z]{2}$/;

export function parseLangMap(
  v: string | undefined,
  valid: (value: string) => string | undefined,
  opts: { commas?: boolean } = {},
): { map: LangMap; ignored: number } {
  const map: Record<string, string> = {};
  let ignored = 0;
  const raw = v?.trim();
  if (!raw) return { map, ignored };
  const put = (k: unknown, val: unknown) => {
    const lang = typeof k === "string" ? k.trim().toLowerCase() : "";
    const ok = typeof val === "string" ? valid(val.trim()) : undefined;
    if (!LANG_RE.test(lang) || !ok || Object.keys(map).length >= MAX_LANG_ENTRIES) { ignored++; return; }
    map[lang] = ok;
  };
  if (raw.startsWith("{")) {
    let o: unknown;
    try { o = JSON.parse(raw); } catch { return { map, ignored: 1 }; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return { map, ignored: 1 };
    for (const [k, val] of Object.entries(o)) put(k, val);
    return { map, ignored };
  }
  for (const part of raw.split(opts.commas === false ? /[;\n]/ : /[,;\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const i = p.search(/[=:]/);
    if (i < 1) { ignored++; continue; }
    put(p.slice(0, i), p.slice(i + 1));
  }
  return { map, ignored };
}
