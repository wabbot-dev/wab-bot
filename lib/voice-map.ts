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

/** ElevenLabs allows at most this many pronunciation dictionaries per text-to-speech request. */
export const MAX_PRONUNCIATION_DICTIONARIES = 3;
export interface DictLocator { pronunciation_dictionary_id: string; version_id?: string }
const DICT_ID_RE = /^[A-Za-z0-9]{8,40}$/;

/**
 * ELEVENLABS_PRONUNCIATION_DICTIONARIES: the owner's own ElevenLabs pronunciation dictionaries, as `<dictionary_id>:<version_id>`
 * entries (the version is optional: without it ElevenLabs uses the latest), separated by commas, semicolons or new lines. An entry with
 * a language in front (`ar=<dictionary_id>:<version_id>`) applies to that language only; one without applies to every language. At most
 * three per language and three for all. Malformed entries are skipped and counted, never thrown. Ids are not secrets.
 */
export function parseDictionaries(v: string | undefined): { all: DictLocator[]; byLang: Readonly<Record<string, DictLocator[]>>; ignored: number } {
  const all: DictLocator[] = [];
  const byLang: Record<string, DictLocator[]> = {};
  let ignored = 0;
  for (const part of (v ?? "").split(/[,;\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(?:([A-Za-z]{2})\s*=\s*)?([^:=\s]+)(?:\s*:\s*([^:=\s]+))?$/.exec(p);
    const lang = m?.[1]?.toLowerCase();
    const id = m?.[2] ?? "";
    const ver = m?.[3];
    if (!m || !DICT_ID_RE.test(id) || (ver !== undefined && !DICT_ID_RE.test(ver))) { ignored++; continue; }
    const list = lang ? (byLang[lang] ??= []) : all;
    if (list.length >= MAX_PRONUNCIATION_DICTIONARIES || list.some((d) => d.pronunciation_dictionary_id === id)) { ignored++; continue; }
    list.push(ver ? { pronunciation_dictionary_id: id, version_id: ver } : { pronunciation_dictionary_id: id });
  }
  return { all, byLang, ignored };
}

/** The dictionaries for one request: the language's own first, then the ones for every language; at most three (ElevenLabs' limit). */
export function dictionariesFor(d: { all: DictLocator[]; byLang: Readonly<Record<string, DictLocator[]>> }, lang: string): DictLocator[] {
  const out: DictLocator[] = [];
  for (const x of [...(d.byLang[lang] ?? []), ...d.all]) {
    if (out.length < MAX_PRONUNCIATION_DICTIONARIES && !out.some((o) => o.pronunciation_dictionary_id === x.pronunciation_dictionary_id)) out.push(x);
  }
  return out;
}
