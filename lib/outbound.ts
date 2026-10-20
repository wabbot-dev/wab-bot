/**
 * Rich outbound messages (docs/OUTBOUND.md): a document or image by https URL or Meta media id, reply buttons, a list, and template
 * header / button parameters. Pure validation + Meta payload building; every guard of send_reply / start_conversation / staff
 * reply (window, test mode, allowlists, rate limits, idempotency) still applies around it. Validation happens before any Meta call.
 */

type Json = Record<string, unknown>;

export interface MediaRef { type: "image" | "document"; url?: string; id?: string; filename?: string }
export interface Button { id: string; title: string }
export interface ListRow { id: string; title: string; description?: string }
export interface ListSpec { button: string; sections: { title?: string; rows: ListRow[] }[] }
export interface TemplateHeader { type: "text" | "image" | "document"; text?: string; url?: string; id?: string; filename?: string }
export interface TemplateButton { index: number; sub_type: "quick_reply" | "url"; param: string }

export interface RichArgs {
  media?: unknown;
  buttons?: unknown;
  list?: unknown;
  template_header?: unknown;
  template_buttons?: unknown;
}
export interface Rich {
  media?: MediaRef;
  buttons?: Button[];
  list?: ListSpec;
  header?: TemplateHeader;
  tbuttons?: TemplateButton[];
}

const bad = (error: string) => ({ ok: false, error });
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const s = (x: unknown, max: number, min = 1): string | null => (typeof x === "string" && x.trim().length >= min && x.length <= max ? x : null);

/** https only, no credentials, no private hosts, optional host allowlist (OUTBOUND_MEDIA_HOSTS). Meta fetches the URL itself. */
export function mediaUrlOk(url: string, hosts: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || url.length > 2000) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || /^(\d+\.){3}\d+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return hosts.length === 0 || hosts.some((a) => h === a || h.endsWith(`.${a}`));
}

function mediaOf(x: unknown, hosts: string[], kinds: readonly string[]): MediaRef | string {
  if (!isObj(x)) return "media_invalid";
  const type = x.type;
  if (typeof type !== "string" || !kinds.includes(type)) return "media_type_unsupported";
  const url = x.url === undefined ? undefined : s(x.url, 2000);
  const id = x.id === undefined ? undefined : s(x.id, 100);
  if (url === null || id === null || !!url === !!id) return "media_give_url_or_id";
  if (url && !mediaUrlOk(url, hosts)) return "media_url_not_allowed";
  if (id && !/^[0-9]{5,30}$/.test(id)) return "media_id_invalid";
  let filename: string | undefined;
  if (x.filename !== undefined) {
    const f = s(x.filename, 120);
    if (!f || /[\\/\u0000-\u001f]/.test(f)) return "media_filename_invalid";
    filename = f;
  }
  return { type: type as MediaRef["type"], ...(url ? { url } : {}), ...(id ? { id } : {}), ...(filename && type === "document" ? { filename } : {}) };
}

/** Validate the rich parts. `isTemplate` decides which parts are allowed. */
export function richOf(a: RichArgs, opts: { isTemplate: boolean; text: string; hosts: string[] }): Rich | Json | undefined {
  const { media, buttons, list, template_header, template_buttons } = a;
  if (media === undefined && buttons === undefined && list === undefined && template_header === undefined && template_buttons === undefined) return undefined;
  const r: Rich = {};
  if (opts.isTemplate) {
    if (media !== undefined || buttons !== undefined || list !== undefined) return bad("template_use_template_header_and_template_buttons");
    if (template_header !== undefined) {
      if (!isObj(template_header)) return bad("template_header_invalid");
      if (template_header.type === "text") {
        const t = s(template_header.text, 60);
        if (!t) return bad("template_header_text_invalid");
        r.header = { type: "text", text: t };
      } else {
        const m = mediaOf(template_header, opts.hosts, ["image", "document"]);
        if (typeof m === "string") return bad(`template_header_${m}`);
        r.header = m;
      }
    }
    if (template_buttons !== undefined) {
      if (!Array.isArray(template_buttons) || template_buttons.length === 0 || template_buttons.length > 10) return bad("template_buttons_invalid");
      const out: TemplateButton[] = [];
      for (const b of template_buttons) {
        if (!isObj(b) || !Number.isInteger(b.index) || (b.index as number) < 0 || (b.index as number) > 9) return bad("template_buttons_invalid");
        if (b.sub_type !== "quick_reply" && b.sub_type !== "url") return bad("template_buttons_invalid");
        const p = s(b.param, b.sub_type === "url" ? 2000 : 128);
        if (!p) return bad("template_buttons_invalid");
        out.push({ index: b.index as number, sub_type: b.sub_type, param: p });
      }
      r.tbuttons = out;
    }
    return r;
  }
  if (template_header !== undefined || template_buttons !== undefined) return bad("template_parts_need_template_name");
  const n = [media, buttons, list].filter((x) => x !== undefined).length;
  if (n > 1) return bad("give_one_of_media_buttons_list");
  if (media !== undefined) {
    const m = mediaOf(media, opts.hosts, ["image", "document"]);
    if (typeof m === "string") return bad(m);
    if (opts.text.length > 1024) return bad("caption_too_long");
    r.media = m;
    return r;
  }
  if (opts.text.trim() === "") return bad("interactive_needs_text");
  if (opts.text.length > 1024) return bad("interactive_text_too_long");
  const ids = new Set<string>();
  const idOk = (id: unknown) => { const v = s(id, 200); if (!v || ids.has(v)) return null; ids.add(v); return v; };
  if (buttons !== undefined) {
    if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) return bad("buttons_one_to_three");
    const out: Button[] = [];
    for (const b of buttons) {
      if (!isObj(b)) return bad("buttons_invalid");
      const id = idOk(b.id); const title = s(b.title, 20);
      if (!id || !title) return bad("buttons_invalid_id_or_title_max_20");
      out.push({ id, title });
    }
    r.buttons = out;
    return r;
  }
  if (!isObj(list)) return bad("list_invalid");
  const button = s(list.button, 20);
  if (!button) return bad("list_button_max_20");
  if (!Array.isArray(list.sections) || list.sections.length < 1 || list.sections.length > 10) return bad("list_sections_invalid");
  const sections: ListSpec["sections"] = [];
  let rows = 0;
  for (const sec of list.sections) {
    if (!isObj(sec) || !Array.isArray(sec.rows) || sec.rows.length < 1) return bad("list_sections_invalid");
    const title = sec.title === undefined ? undefined : s(sec.title, 24);
    if (title === null || (list.sections.length > 1 && !title)) return bad("list_section_title_max_24");
    const out: ListRow[] = [];
    for (const row of sec.rows) {
      if (!isObj(row)) return bad("list_rows_invalid");
      const id = idOk(row.id); const t = s(row.title, 24);
      const d = row.description === undefined ? undefined : s(row.description, 72);
      if (!id || !t || d === null) return bad("list_rows_invalid_title_24_description_72");
      out.push({ id, title: t, ...(d ? { description: d } : {}) });
      rows++;
    }
    sections.push({ ...(title ? { title } : {}), rows: out });
  }
  if (rows > 10) return bad("list_max_10_rows");
  r.list = { button, sections };
  return r;
}

const mediaObj = (m: { url?: string; id?: string; filename?: string }, caption?: string): Json => ({
  ...(m.id ? { id: m.id } : { link: m.url }),
  ...(m.filename ? { filename: m.filename } : {}),
  ...(caption ? { caption } : {}),
});

/** Meta payload fields (type + body) for a non-template rich message. */
export function richPayload(r: Rich, text: string): Json {
  if (r.media) return { type: r.media.type, [r.media.type]: mediaObj(r.media, text.trim() ? text : undefined) };
  if (r.buttons) {
    return { type: "interactive", interactive: { type: "button", body: { text }, action: { buttons: r.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } } };
  }
  if (r.list) return { type: "interactive", interactive: { type: "list", body: { text }, action: { button: r.list.button, sections: r.list.sections } } };
  return { type: "text", text: { preview_url: false, body: text } };
}

/** Template components: header, body parameters, buttons. */
export function templateComponents(params: string[] | undefined, r: Rich | undefined): Json[] {
  const out: Json[] = [];
  const h = r?.header;
  if (h) {
    out.push({ type: "header", parameters: [h.type === "text" ? { type: "text", text: h.text } : { type: h.type, [h.type]: mediaObj(h) }] });
  }
  if (params?.length) out.push({ type: "body", parameters: params.map((t) => ({ type: "text", text: t })) });
  for (const b of r?.tbuttons ?? []) {
    out.push({ type: "button", sub_type: b.sub_type, index: String(b.index), parameters: [b.sub_type === "url" ? { type: "text", text: b.param } : { type: "payload", payload: b.param }] });
  }
  return out;
}

/** How a rich message is stored in history (the text the staff and the agent see later). */
export function richStoredText(r: Rich | undefined, text: string): { type: string; text: string } | null {
  if (!r) return null;
  if (r.media) return { type: r.media.type, text: `[${r.media.type}${r.media.filename ? ` ${r.media.filename}` : ""}]${text.trim() ? ` ${text}` : ""}` };
  if (r.buttons) return { type: "interactive", text: `${text}\n[buttons: ${r.buttons.map((b) => b.title).join(" | ")}]` };
  if (r.list) return { type: "interactive", text: `${text}\n[list "${r.list.button}": ${r.list.sections.flatMap((x) => x.rows.map((y) => y.title)).join(" | ")}]` };
  return null;
}
