/**
 * /api/admin/meta-setup: the Graph API half of the "hybrid" Meta setup, executed INSIDE the importer's own deployment
 * (the Worker) so Meta only ever sees the importer's Cloudflare Worker (or the importer's own device), never a third-party host.
 *
 * Secrets handled here: the bootstrap user token (request body only), the app secret, the OTP, the registration PIN and the
 * system-user token we mint. NONE of them is logged, stored in the state document (this module never touches ctx.store) or
 * echoed: every outgoing string passes through a Redactor. The minted token is returned ONCE, in `secret_delivery`, only when the
 * caller asked for it with return_token=true (the response is not repeatable and carries Cache-Control: no-store).
 *
 * Every step reads before it writes (idempotent: a re-run finds the work done and says so) and reads back after it writes
 * (PASS means "Meta shows the state we wanted", not "the POST returned 200").
 * META_SETUP_DRY_RUN=1 swaps Meta for the in-memory stub in meta-fake.ts: no call leaves the process.
 */
import { createHash, createHmac, randomInt } from "node:crypto";
import { adminAuthorized } from "./admin";
import type { Ctx, VolatileState } from "./ctx";
import { FakeMeta, DRY_RUN_TOKEN } from "./meta-fake";
import { Redactor } from "./redact";
import { handleVerify } from "./webhook";

export type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
export interface StepResult { id: string; name: string; status: Status; detail?: string; facts?: Record<string, unknown> }

export const WA_MGMT = "whatsapp_business_management";
export const WA_MSG = "whatsapp_business_messaging";
export const BIZ_MGMT = "business_management";
export const ALL_SCOPES = [BIZ_MGMT, WA_MGMT, WA_MSG];

export const STEP_ORDER = [
  "businesses", "waba", "system_user", "phone_add", "phone_request_code", "phone_verify_code", "phone_register",
  "subscribed_apps", "webhook", "templates", "display_name", "test_send",
] as const;
export type StepId = (typeof STEP_ORDER)[number];
export const DEFAULT_RUN: StepId[] = ["businesses", "waba", "system_user", "subscribed_apps", "webhook"];
const NEEDS: Record<StepId, string[]> = {
  businesses: [BIZ_MGMT], waba: [WA_MGMT], system_user: ALL_SCOPES, phone_add: [WA_MGMT], phone_request_code: [WA_MGMT],
  phone_verify_code: [WA_MGMT], phone_register: [WA_MGMT], subscribed_apps: [WA_MGMT], webhook: [],
  templates: [WA_MGMT], display_name: [WA_MGMT], test_send: [WA_MGMT, WA_MSG],
};
/** Business.vertical enum (Meta Business SDK 26.0.2 / api_specs): anything else would be rejected by Graph, so fall back to OTHER. */
export const VERTICALS = ["ADVERTISING", "AUTOMOTIVE", "CONSUMER_PACKAGED_GOODS", "ECOMMERCE", "EDUCATION", "ENERGY_AND_UTILITIES", "ENTERTAINMENT_AND_MEDIA", "FINANCIAL_SERVICES", "GAMING", "GOVERNMENT_AND_POLITICS", "HEALTH", "LUXURY", "MARKETING", "NON_PROFIT", "NOT_SET", "ORGANIZATIONS_AND_ASSOCIATIONS", "OTHER", "PROFESSIONAL_SERVICES", "RESTAURANT", "RETAIL", "TECHNOLOGY", "TELECOM", "TRAVEL"];
export const TIME_BUDGET_MS = 50_000;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_BODY = 20_000;
const WEBHOOK_FIELDS_OK = ["messages", "message_template_status_update", "phone_number_name_update", "phone_number_quality_update", "account_update", "account_alerts", "business_capability_update"];

// ------------------------------------------------------------------------------------------------------------------------------
// request parsing (strict: unknown keys are rejected so a typo never silently drops a secret or a safety flag)
// ------------------------------------------------------------------------------------------------------------------------------
export interface Req {
  steps: StepId[]; continueOnFail: boolean; graphVersion?: string;
  token?: string; appSecret?: string;
  appId?: string; businessId?: string; wabaId?: string; phoneId?: string; systemUserId?: string;
  createBusiness?: { name: string; email?: string; vertical: string; timezoneId?: number };
  systemUserName: string; systemUserRole: "ADMIN" | "EMPLOYEE";
  mintToken: boolean; returnToken: boolean; forceMint: boolean;
  phone?: { cc: string; number: string; name: string };
  codeMethod: "SMS" | "VOICE"; language: string; code?: string;
  pin?: string; generatePin: boolean; forceRegister: boolean;
  templates: { name: string; category: string; language: string; components: unknown[] }[];
  newDisplayName?: string;
  testTo?: string; testTemplate: string; testLanguage: string; confirm: boolean;
  webhookUrl?: string; webhookFields: string[]; wabaOverride: boolean;
}
const KEYS = new Set([
  "action", "steps", "continue_on_fail", "graph_version", "bootstrap_token", "app_secret", "app_id", "business_id", "waba_id", "phone_number_id",
  "system_user_id", "create_business", "system_user_name", "system_user_role", "mint_token", "return_token", "force_mint", "phone", "code_method",
  "language", "code", "pin", "generate_pin", "force_register", "templates", "new_display_name", "to", "test_template", "test_language", "confirm",
  "webhook_url", "webhook_fields", "waba_override",
]);
class BadReq extends Error { constructor(public field: string, public reason: string) { super(reason); } }

export function parseReq(o: unknown): Req {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new BadReq("body", "must be a JSON object");
  const b = o as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!KEYS.has(k)) throw new BadReq(k, "unknown field");
  const str = (k: string, re: RegExp, max = 512): string | undefined => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || v.length > max || !re.test(v)) throw new BadReq(k, "invalid format");
    return v;
  };
  const bool = (k: string): boolean => {
    const v = b[k];
    if (v === undefined) return false;
    if (typeof v !== "boolean") throw new BadReq(k, "must be a boolean");
    return v;
  };
  const id = (k: string) => str(k, /^\d{5,25}$/, 25);
  const action = typeof b.action === "string" ? b.action : undefined;
  let steps: StepId[];
  if (b.steps !== undefined) {
    if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > 20) throw new BadReq("steps", "must be a non-empty array");
    const seen = new Set<string>();
    for (const s of b.steps) {
      if (typeof s !== "string" || (s !== "preflight" && !(STEP_ORDER as readonly string[]).includes(s))) throw new BadReq("steps", "unknown step");
      seen.add(s);
    }
    steps = STEP_ORDER.filter((s) => seen.has(s));
  } else if (action === undefined || action === "run") steps = [...DEFAULT_RUN];
  else if (action === "preflight") steps = [];
  else if ((STEP_ORDER as readonly string[]).includes(action)) steps = [action as StepId];
  else throw new BadReq("action", "unknown action");

  const req: Req = {
    steps, continueOnFail: bool("continue_on_fail"),
    graphVersion: str("graph_version", /^v\d+\.\d+$/, 12),
    token: str("bootstrap_token", /^[A-Za-z0-9_|.\-]{16,600}$/, 600),
    appSecret: str("app_secret", /^[A-Za-z0-9]{16,64}$/, 64),
    appId: id("app_id"), businessId: id("business_id"), wabaId: id("waba_id"), phoneId: id("phone_number_id"), systemUserId: id("system_user_id"),
    systemUserName: str("system_user_name", /^[A-Za-z0-9 _.\-]{3,60}$/, 60) ?? "wab-bot-system-user",
    systemUserRole: (str("system_user_role", /^(ADMIN|EMPLOYEE)$/, 8) as "ADMIN" | "EMPLOYEE" | undefined) ?? "ADMIN",
    mintToken: bool("mint_token"), returnToken: bool("return_token"), forceMint: bool("force_mint"),
    codeMethod: (str("code_method", /^(SMS|VOICE)$/, 5) as "SMS" | "VOICE" | undefined) ?? "SMS",
    language: str("language", /^[a-z]{2}_[A-Z]{2}$/, 5) ?? "en_US", // request_code: Meta wants a locale such as en_US
    code: str("code", /^[\d\s-]{6,9}$/, 9)?.replace(/\D/g, ""),
    pin: str("pin", /^\d{6}$/, 6), generatePin: bool("generate_pin"), forceRegister: bool("force_register"),
    templates: [], newDisplayName: str("new_display_name", /^[^\n\r<>]{3,100}$/, 100),
    testTo: str("to", /^\+?\d{7,15}$/, 16)?.replace(/\D/g, ""),
    testTemplate: str("test_template", /^[a-z0-9_]{1,512}$/, 512) ?? "hello_world",
    testLanguage: str("test_language", /^[a-z]{2}(_[A-Z]{2})?$/, 8) ?? "en_US",
    confirm: bool("confirm"),
    webhookUrl: str("webhook_url", /^https:\/\/[^\s]{3,300}$/, 320),
    webhookFields: ["messages"], wabaOverride: bool("waba_override"),
  };
  if (req.code && req.code.length !== 6) throw new BadReq("code", "must be 6 digits");
  if (b.create_business !== undefined) {
    const c = b.create_business as Record<string, unknown>;
    if (!c || typeof c !== "object" || typeof c.name !== "string" || c.name.length < 2 || c.name.length > 100) throw new BadReq("create_business", "needs a name (2-100 chars)");
    for (const k of Object.keys(c)) if (!["name", "email", "vertical", "timezone_id"].includes(k)) throw new BadReq("create_business", "unknown field");
    if (c.email !== undefined && (typeof c.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email))) throw new BadReq("create_business", "invalid email");
    if (c.timezone_id !== undefined && (!Number.isInteger(c.timezone_id) || (c.timezone_id as number) < 0 || (c.timezone_id as number) > 200)) throw new BadReq("create_business", "invalid timezone_id");
    req.createBusiness = { name: c.name.trim(), email: c.email as string | undefined, vertical: typeof c.vertical === "string" && VERTICALS.includes(c.vertical) ? c.vertical : "OTHER", timezoneId: c.timezone_id as number | undefined };
  }
  if (b.phone !== undefined) {
    const p = b.phone as Record<string, unknown>;
    if (!p || typeof p !== "object") throw new BadReq("phone", "must be an object");
    for (const k of Object.keys(p)) if (!["cc", "phone_number", "verified_name"].includes(k)) throw new BadReq("phone", "unknown field");
    if (typeof p.cc !== "string" || !/^\d{1,4}$/.test(p.cc)) throw new BadReq("phone.cc", "invalid format");
    if (typeof p.phone_number !== "string" || !/^\d{4,15}$/.test(p.phone_number)) throw new BadReq("phone.phone_number", "digits only, without the country code");
    if (typeof p.verified_name !== "string" || p.verified_name.length < 3 || p.verified_name.length > 100 || /[\n\r<>]/.test(p.verified_name)) throw new BadReq("phone.verified_name", "invalid display name");
    req.phone = { cc: p.cc, number: p.phone_number, name: p.verified_name };
  }
  if (b.templates !== undefined) {
    if (!Array.isArray(b.templates) || b.templates.length > 10) throw new BadReq("templates", "array of at most 10");
    req.templates = b.templates.map((t) => {
      const x = t as Record<string, unknown>;
      if (!x || typeof x.name !== "string" || !/^[a-z0-9_]{1,512}$/.test(x.name)) throw new BadReq("templates", "invalid name");
      if (typeof x.category !== "string" || !["MARKETING", "UTILITY", "AUTHENTICATION"].includes(x.category)) throw new BadReq("templates", "invalid category");
      if (typeof x.language !== "string" || !/^[a-z]{2}(_[A-Z]{2})?$/.test(x.language)) throw new BadReq("templates", "invalid language");
      if (!Array.isArray(x.components) || x.components.length === 0) throw new BadReq("templates", "components required");
      return { name: x.name, category: x.category, language: x.language, components: x.components };
    });
  }
  if (b.webhook_fields !== undefined) {
    if (!Array.isArray(b.webhook_fields) || !b.webhook_fields.length || b.webhook_fields.some((f) => typeof f !== "string" || !WEBHOOK_FIELDS_OK.includes(f))) throw new BadReq("webhook_fields", `allowed: ${WEBHOOK_FIELDS_OK.join(",")}`);
    req.webhookFields = [...new Set(b.webhook_fields as string[])];
  }
  if (req.mintToken && !req.returnToken) throw new BadReq("return_token", "mint_token requires return_token=true: a minted token cannot be fetched again and is never stored by the bridge");
  if (req.mintToken && !req.steps.includes("system_user")) throw new BadReq("mint_token", "only meaningful with the system_user step");
  return req;
}
export { BadReq };

// ------------------------------------------------------------------------------------------------------------------------------
// Graph client
// ------------------------------------------------------------------------------------------------------------------------------
interface GR { ok: boolean; status: number; body: any; error: string; code: number | null; message: string }

function describeError(body: any, status: number): { text: string; code: number | null; message: string } {
  const e = body && typeof body === "object" ? body.error : undefined;
  if (!e) return { text: `HTTP ${status}`, code: null, message: "" };
  const c = Number(e.code);
  let hint = "";
  if (c === 190) hint = " (token invalid, expired or revoked)";
  else if (c === 10 || c === 200 || c === 299) hint = " (permission missing: the token needs the scope AND access to this asset)";
  else if (c === 100) hint = " (invalid parameter, unsupported edge, or no access to that object)";
  else if (c === 4 || c === 17 || c === 32 || c === 613 || c === 80007) hint = " (rate limited: wait before retrying)";
  else if (c === 136024) hint = " (wrong or expired verification code)";
  else if (c === 133016) hint = " (register/deregister limit: 10 per number per 72h)";
  else if (c === 2200) hint = " (Meta could not verify the callback URL: check WA_VERIFY_TOKEN on this deployment and that the URL is public)";
  else if (c === 131030) hint = " (recipient not in the allowed list of the test number)";
  else if (c === 133010) hint = " (phone number not registered)";
  const message = String(e.message ?? "no message");
  return { text: `HTTP ${status} code ${e.code ?? "?"}${e.error_subcode ? "/" + e.error_subcode : ""}: ${message}${hint}`, code: Number.isFinite(c) ? c : null, message };
}

export class Graph {
  constructor(private f: typeof fetch, private version: string, private r: Redactor, private left: () => number) {}
  async call(method: "GET" | "POST", path: string, o: { token?: string; appToken?: string; query?: Record<string, string>; form?: Record<string, string> } = {}): Promise<GR> {
    const budget = this.left();
    if (budget < 1000) return { ok: false, status: 0, body: null, error: "time budget exhausted (re-run: completed steps are skipped)", code: null, message: "" };
    const q = new URLSearchParams(o.query ?? {});
    if (o.appToken) q.set("access_token", o.appToken);
    const qs = q.toString();
    const url = `https://graph.facebook.com/${this.version}${path}${qs ? "?" + qs : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(o.form).toString(); }
    try {
      const res = await this.f(url, { method, headers, body, signal: AbortSignal.timeout(Math.min(HTTP_TIMEOUT_MS, budget)) });
      const text = await res.text();
      let parsed: any;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
      if (!res.ok || (parsed && parsed.error)) {
        const d = describeError(parsed, res.status);
        return { ok: false, status: res.status, body: parsed, error: this.r.redact(d.text), code: d.code, message: this.r.redact(d.message) };
      }
      return { ok: true, status: res.status, body: parsed, error: "", code: null, message: "" };
    } catch (err) {
      const m = err instanceof Error && err.name === "TimeoutError" ? "timeout" : err instanceof Error ? err.message.slice(0, 100) : "unknown";
      return { ok: false, status: 0, body: null, error: this.r.redact(`network error: ${m}`), code: null, message: "" };
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------------------------------------
const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const maskTail = (s: string | null | undefined, n = 4) => { const d = String(s ?? "").replace(/\D/g, ""); return d ? `${"*".repeat(Math.max(0, d.length - n))}${d.slice(-n)}` : null; };
const isoSec = (sec: number) => new Date(sec * 1000).toISOString();
const list = (b: any): any[] => (b && Array.isArray(b.data) ? b.data : []);
const fieldErr = (r: GR) => r.code === 100 && /field/i.test(r.message);
function sameUrl(a: string, b: string): boolean { try { const x = new URL(a), y = new URL(b); return x.origin + x.pathname.replace(/\/+$/, "") === y.origin + y.pathname.replace(/\/+$/, ""); } catch { return false; } }

interface TokenFacts { valid: boolean; type: string | null; appId: string | null; userId: string | null; scopes: string[]; expiresAt: number | null; granular: any[]; error?: string }

const sendGuard = new WeakMap<VolatileState, Map<string, number[]>>();
function guardHit(ctx: Ctx, key: string, max: number, windowMs: number): boolean {
  let m = sendGuard.get(ctx.state);
  if (!m) { m = new Map(); sendGuard.set(ctx.state, m); }
  const now = ctx.now();
  const hits = (m.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { m.set(key, hits); return true; }
  hits.push(now); m.set(key, hits);
  return false;
}

// ------------------------------------------------------------------------------------------------------------------------------
// the engine
// ------------------------------------------------------------------------------------------------------------------------------
export class Setup {
  results: StepResult[] = [];
  ids: { app_id: string | null; user_id: string | null; business_id: string | null; waba_id: string | null; system_user_id: string | null; phone_number_id: string | null };
  tokenSource: "body" | "env" = "body";
  tok = "";
  appSecret?: string;
  tf: TokenFacts | null = null;
  secrets: { WA_ACCESS_TOKEN?: string; REGISTRATION_PIN?: string } = {};
  manual: Record<string, unknown> | null = null;
  next: string[] = [];

  constructor(public ctx: Ctx, public q: Req, public g: Graph, public r: Redactor) {
    this.ids = { app_id: q.appId ?? null, user_id: null, business_id: q.businessId ?? null, waba_id: q.wabaId ?? null, system_user_id: q.systemUserId ?? null, phone_number_id: q.phoneId ?? null };
  }

  add(id: string, name: string, status: Status, detail = "", facts?: Record<string, unknown>): Status {
    this.results.push({ id, name, status, ...(detail ? { detail: this.r.redact(detail) } : {}), ...(facts ? { facts } : {}) });
    return status;
  }

  async debug(input: string, bearer: string): Promise<TokenFacts> {
    const r = await this.g.call("GET", "/debug_token", { token: bearer, query: { input_token: input } });
    if (!r.ok) return { valid: false, type: null, appId: null, userId: null, scopes: [], expiresAt: null, granular: [], error: r.error };
    const d = r.body?.data ?? {};
    return {
      valid: d.is_valid === true, type: d.type ?? null, appId: d.app_id ? String(d.app_id) : null, userId: d.user_id ? String(d.user_id) : null,
      scopes: Array.isArray(d.scopes) ? d.scopes : [], expiresAt: d.expires_at === undefined ? null : Number(d.expires_at),
      granular: Array.isArray(d.granular_scopes) ? d.granular_scopes : [],
      error: d.is_valid === true ? undefined : `Meta says the token is not valid${d.error?.message ? ": " + d.error.message : ""}`,
    };
  }

  // ---- preflight ---------------------------------------------------------------------------------------------------------------
  /** returns false when nothing can proceed (invalid token / wrong app) */
  async preflight(): Promise<boolean> {
    const need = new Set<string>();
    for (const s of this.q.steps) for (const sc of NEEDS[s]) need.add(sc);
    const t = await this.debug(this.tok, this.tok);
    this.tf = t;
    if (!t.valid) {
      this.add("preflight", "Token check (debug_token)", "FAIL", t.error ?? "token invalid", { token_source: this.tokenSource, valid: false });
      return false;
    }
    const missing = [...need].filter((s) => !t.scopes.includes(s));
    const allMissing = ALL_SCOPES.filter((s) => !t.scopes.includes(s));
    const never = t.expiresAt === 0;
    const left = t.expiresAt && t.expiresAt > 0 ? Math.round((t.expiresAt * 1000 - this.ctx.now()) / 60000) : null;
    this.ids.app_id = this.ids.app_id ?? t.appId;
    this.ids.user_id = t.userId;
    const facts = {
      token_source: this.tokenSource, type: t.type, app_id: t.appId, scopes: t.scopes, missing_scopes_of_the_three: allMissing,
      expires: never ? "never" : t.expiresAt && t.expiresAt > 0 ? isoSec(t.expiresAt) : "unknown", expires_in_minutes: left,
    };
    if (this.q.appId && t.appId && this.q.appId !== t.appId) { this.add("preflight", "Token belongs to the expected app", "FAIL", `token is for app ${t.appId}, request says ${this.q.appId}`, facts); return false; }
    if (missing.length) { this.add("preflight", "Token has the scopes the requested steps need", "FAIL", `missing: ${missing.join(", ")}. Re-generate the token and tick ${allMissing.join(", ")}.`, facts); return true; } // each step re-checks its own scopes; steps that need none still run
    if (left !== null && left < 10) { this.add("preflight", "Token valid", "WARN", `valid but expires in ${left} min: finish quickly or generate a fresh token`, facts); return true; }
    this.add("preflight", "Token valid with the required scopes", "PASS", `${t.type ?? "?"} token, app ${t.appId ?? "?"}, expires ${facts.expires}`, facts);
    return true;
  }

  scopeOk(step: StepId): boolean {
    const missing = NEEDS[step].filter((s) => !this.tf?.scopes.includes(s));
    if (missing.length) { this.add(step, `Scopes for ${step}`, "FAIL", `scope_missing: ${missing.join(", ")} (no call was made to Meta for this step)`, { missing_scopes: missing }); return false; }
    return true;
  }

  // ---- businesses --------------------------------------------------------------------------------------------------------------
  async businesses(): Promise<void> {
    const S = "businesses", N = "Business portfolio";
    const r = await this.g.call("GET", "/me/businesses", { token: this.tok, query: { fields: "id,name,verification_status", limit: "50" } });
    if (!r.ok) { this.add(S, N, "FAIL", `GET /me/businesses: ${r.error}`); return; }
    const l = list(r.body).map((b) => ({ id: String(b.id), name: String(b.name ?? ""), verification_status: b.verification_status ?? null }));
    const facts = (id: string, extra: Record<string, unknown> = {}) => ({ business_id: id || null, businesses: l.map((b) => ({ id: b.id, name: b.name })), ...extra });
    if (this.ids.business_id) {
      const hit = l.find((b) => b.id === this.ids.business_id);
      if (hit) { this.add(S, N, "PASS", `using ${hit.name || hit.id} (given)`, facts(hit.id, { verification_status: hit.verification_status })); return; }
      const one = await this.g.call("GET", `/${this.ids.business_id}`, { token: this.tok, query: { fields: "id,name" } });
      if (one.ok && String(one.body?.id) === this.ids.business_id) { this.add(S, N, "PASS", `using ${one.body.name ?? this.ids.business_id} (given; not in /me/businesses)`, facts(this.ids.business_id)); return; }
      this.add(S, N, "FAIL", `business_id ${this.ids.business_id} is not accessible with this token`, facts(this.ids.business_id)); return;
    }
    const c = this.q.createBusiness;
    if (c) {
      const same = l.find((b) => b.name.toLowerCase() === c.name.toLowerCase());
      if (same) { this.ids.business_id = same.id; this.add(S, N, "PASS", `portfolio "${same.name}" already exists (create skipped)`, facts(same.id, { created: false })); return; }
      const form: Record<string, string> = { name: c.name, vertical: c.vertical };
      if (c.email) form.email = c.email;
      if (c.timezoneId !== undefined) form.timezone_id = String(c.timezoneId);
      const p = await this.g.call("POST", `/${this.ids.user_id ?? "me"}/businesses`, { token: this.tok, form });
      if (!p.ok || !p.body?.id) { this.add(S, N, "FAIL", `create portfolio: ${p.ok ? "no id in response" : p.error}. Create it in the dashboard instead (checklist step).`, facts("")); return; }
      const nid = String(p.body.id);
      const v = await this.g.call("GET", "/me/businesses", { token: this.tok, query: { fields: "id,name", limit: "50" } });
      if (v.ok && list(v.body).some((b) => String(b.id) === nid)) { this.ids.business_id = nid; this.add(S, N, "PASS", `portfolio "${c.name}" created and read back`, facts(nid, { created: true })); }
      else this.add(S, N, "FAIL", "portfolio created but not visible on read-back", facts(nid));
      return;
    }
    if (l.length === 1) { this.ids.business_id = l[0]!.id; this.add(S, N, "PASS", `the only portfolio: ${l[0]!.name || l[0]!.id}`, facts(l[0]!.id)); return; }
    if (l.length === 0) { this.add(S, N, "FAIL", "no business portfolio visible to this token. Create one in the app-creation wizard (checklist), or pass create_business:{name} to create it here.", facts("")); return; }
    this.add(S, N, "FAIL", "several portfolios: pass business_id", facts(""));
  }

  // ---- waba + phones -------------------------------------------------------------------------------------------------------------
  async phones(waba: string): Promise<GR> {
    const full = "id,display_phone_number,verified_name,code_verification_status,status,platform_type,name_status,quality_rating";
    let r = await this.g.call("GET", `/${waba}/phone_numbers`, { token: this.tok, query: { fields: full, limit: "50" } });
    if (!r.ok && fieldErr(r)) r = await this.g.call("GET", `/${waba}/phone_numbers`, { token: this.tok, query: { fields: "id,display_phone_number,verified_name", limit: "50" } });
    return r;
  }
  pf = (p: any) => ({
    id: String(p.id), display_number_masked: maskTail(p.display_phone_number), verified_name: p.verified_name ?? null, status: p.status ?? null,
    code_verification_status: p.code_verification_status ?? null, platform_type: p.platform_type ?? null, name_status: p.name_status ?? null, quality_rating: p.quality_rating ?? null,
  });
  async phone(id: string): Promise<{ ok: true; p: any } | { ok: false; error: string }> {
    const full = "id,display_phone_number,verified_name,code_verification_status,status,platform_type,name_status,new_display_name,new_name_status,quality_rating";
    let r = await this.g.call("GET", `/${id}`, { token: this.tok, query: { fields: full } });
    if (!r.ok && fieldErr(r)) r = await this.g.call("GET", `/${id}`, { token: this.tok, query: { fields: "id,display_phone_number,verified_name" } });
    if (!r.ok) return { ok: false, error: r.error };
    if (String(r.body?.id) !== id) return { ok: false, error: `Meta returned id ${r.body?.id}, expected ${id}` };
    return { ok: true, p: r.body };
  }

  async waba(): Promise<void> {
    const S = "waba", N = "WhatsApp Business Account + phone numbers";
    let wabaId = this.ids.waba_id;
    let wabas: any[] = [];
    if (!wabaId) {
      if (!this.ids.business_id) { this.add(S, N, "FAIL", "need business_id (run the businesses step) or waba_id"); return; }
      const r = await this.g.call("GET", `/${this.ids.business_id}/owned_whatsapp_business_accounts`, { token: this.tok, query: { fields: "id,name,account_review_status", limit: "50" } });
      if (!r.ok) { this.add(S, N, "FAIL", `GET owned_whatsapp_business_accounts: ${r.error}`); return; }
      wabas = list(r.body);
      const wl = wabas.map((w) => ({ id: String(w.id), name: w.name ?? null, account_review_status: w.account_review_status ?? null }));
      if (wl.length === 0) { this.add(S, N, "FAIL", "no WhatsApp Business Account on this portfolio yet. Create/attach it in the app dashboard (WhatsApp > API Setup), or pass waba_id.", { wabas: [] }); return; }
      if (wl.length > 1) { this.add(S, N, "FAIL", "several WABAs: pass waba_id", { wabas: wl }); return; }
      wabaId = wl[0]!.id;
    } else {
      const r = await this.g.call("GET", `/${wabaId}`, { token: this.tok, query: { fields: "id,name,account_review_status" } });
      if (!r.ok) { this.add(S, N, "FAIL", `GET WABA ${wabaId}: ${r.error}`); return; }
      if (String(r.body?.id) !== wabaId) { this.add(S, N, "FAIL", `Meta returned id ${r.body?.id}, expected ${wabaId}`); return; }
      wabas = [r.body];
    }
    const gr = this.tf?.granular.find((x) => x && x.scope === WA_MGMT);
    if (gr && Array.isArray(gr.target_ids) && gr.target_ids.length && !gr.target_ids.map(String).includes(wabaId)) {
      this.add(S, N, "FAIL", `the token is scoped to ${gr.target_ids.length} other WABA(s), not ${wabaId}`); return;
    }
    this.ids.waba_id = wabaId;
    const p = await this.phones(wabaId);
    if (!p.ok) { this.add(S, N, "FAIL", `WABA ${wabaId} found but GET phone_numbers failed: ${p.error}`, { waba_id: wabaId }); return; }
    const pl = list(p.body).map(this.pf);
    let note = "";
    if (this.ids.phone_number_id) {
      if (!pl.some((x) => x.id === this.ids.phone_number_id)) { this.add(S, N, "FAIL", `phone_number_id ${this.ids.phone_number_id} is not a number of WABA ${wabaId}`, { waba_id: wabaId, phones: pl }); return; }
    } else if (pl.length === 1) { this.ids.phone_number_id = pl[0]!.id; note = "; the only number selected"; }
    else if (pl.length > 1) note = "; several numbers: pass phone_number_id for phone steps";
    const w = wabas.find((x) => String(x.id) === wabaId);
    const envIds = this.ctx.cfg.phoneNumberIds;
    this.add(S, N, "PASS", `WABA ${w?.name ?? wabaId}, ${pl.length} number(s)${note}`, {
      waba_id: wabaId, waba_name: w?.name ?? null, account_review_status: w?.account_review_status ?? null, phones: pl,
      env_WA_PHONE_NUMBER_IDS_includes_selected: this.ids.phone_number_id ? envIds.includes(this.ids.phone_number_id) : null,
    });
  }

  // ---- system user -----------------------------------------------------------------------------------------------------------
  async systemUser(): Promise<void> {
    const q = this.q;
    const biz = this.ids.business_id, app = this.ids.app_id, waba = this.ids.waba_id;
    if (!biz || !app) { this.add("system_user_create", "System user", "FAIL", `need ${!biz ? "business_id (businesses step)" : "app_id (from the token)"}`); return; }
    // A. create (find by name first)
    const A = "system_user_create", AN = "System user exists";
    let suId = this.ids.system_user_id;
    const lr = await this.g.call("GET", `/${biz}/system_users`, { token: this.tok, query: { fields: "id,name", limit: "50" } });
    if (!lr.ok) { this.add(A, AN, "FAIL", `GET system_users: ${lr.error}`); return; }
    const sus = list(lr.body);
    const found = suId ? sus.find((s) => String(s.id) === suId) : sus.find((s) => String(s.name).toLowerCase() === q.systemUserName.toLowerCase());
    if (found) { suId = String(found.id); this.ids.system_user_id = suId; this.add(A, AN, "PASS", `"${found.name}" already exists (create skipped)`, { system_user_id: suId, role: found.role ?? null, created: false }); }
    else {
      const p = await this.g.call("POST", `/${biz}/system_users`, { token: this.tok, form: { name: q.systemUserName, role: q.systemUserRole } });
      if (!p.ok || !p.body?.id) { this.add(A, AN, "FAIL", `create system user: ${p.ok ? "no id in response" : p.error}`); return; }
      this.ids.system_user_id = String(p.body.id);
      const v = await this.g.call("GET", `/${biz}/system_users`, { token: this.tok, query: { fields: "id,name", limit: "50" } });
      if (!v.ok || !list(v.body).some((s) => String(s.id) === String(p.body.id))) { this.add(A, AN, "FAIL", v.ok ? "system user created but not visible on read-back" : `read-back failed: ${v.error}`, { system_user_id: String(p.body.id) }); return; }
      suId = String(p.body.id);
      this.add(A, AN, "PASS", `"${q.systemUserName}" created and read back`, { system_user_id: suId, role: q.systemUserRole, created: true });
    }
    // B. install the app on the system user
    const B = "system_user_install_app", BN = "App installed on the system user";
    const hasApp = (b: any) => list(b).some((a) => String(a.id) === app);
    const g1 = await this.g.call("GET", `/${suId}/applications`, { token: this.tok, query: { fields: "id,name" } });
    if (g1.ok && hasApp(g1.body)) this.add(B, BN, "PASS", "already installed (install skipped)", { app_id: app, installed: true });
    else {
      const p = await this.g.call("POST", `/${suId}/applications`, { token: this.tok, form: { business_app: app } });
      if (!p.ok) { this.add(B, BN, "FAIL", `POST applications: ${p.error}. Fallback: Business Settings > System users > Add assets > Apps (checklist).`); return; }
      const v = await this.g.call("GET", `/${suId}/applications`, { token: this.tok, query: { fields: "id,name" } });
      if (v.ok && hasApp(v.body)) this.add(B, BN, "PASS", "installed and read back", { app_id: app, installed: true });
      else if (!v.ok) this.add(B, BN, "WARN", `POST accepted but the read-back edge is unavailable (${v.error}); the token step proves it`, { app_id: app, installed: null });
      else { this.add(B, BN, "FAIL", "POST accepted but the app is not listed afterwards"); return; }
    }
    // C. assign the WABA
    const C = "system_user_assign_waba", CN = "WABA assigned to the system user";
    if (!waba) { this.add(C, CN, "FAIL", "need waba_id (waba step first)"); return; }
    const assigned = (b: any) => list(b).some((u) => String(u.id) === suId);
    const g3 = await this.g.call("GET", `/${waba}/assigned_users`, { token: this.tok, query: { business: biz, fields: "id,name" } });
    if (g3.ok && assigned(g3.body)) this.add(C, CN, "PASS", "already assigned (skipped)", { waba_id: waba, system_user_id: suId });
    else {
      const p = await this.g.call("POST", `/${waba}/assigned_users`, { token: this.tok, form: { user: suId!, tasks: JSON.stringify(["MANAGE"]) } });
      if (!p.ok) { this.add(C, CN, "FAIL", `POST assigned_users: ${p.error}. Fallback: Business Settings > System users > Add assets > WhatsApp accounts (checklist).`); return; }
      const v = await this.g.call("GET", `/${waba}/assigned_users`, { token: this.tok, query: { business: biz, fields: "id,name" } });
      if (v.ok && assigned(v.body)) this.add(C, CN, "PASS", "assigned and read back", { waba_id: waba, system_user_id: suId });
      else if (!v.ok) this.add(C, CN, "WARN", `POST accepted but read-back failed (${v.error})`, { waba_id: waba, system_user_id: suId });
      else { this.add(C, CN, "FAIL", "POST accepted but the system user is not listed on the WABA afterwards"); return; }
    }
    await this.mint(suId!, biz, app);
  }

  async mint(suId: string, biz: string, app: string): Promise<void> {
    const D = "system_user_token", DN = "Never-expiring system-user token";
    const q = this.q;
    if (!q.mintToken) { this.add(D, DN, "SKIP", "not requested (mint_token + return_token)"); return; }
    const envTok = this.ctx.cfg.waAccessToken;
    if (envTok && !q.forceMint) {
      const e = await this.debug(envTok, envTok);
      if (e.valid && e.type === "SYSTEM_USER" && e.expiresAt === 0 && e.appId === app && [WA_MGMT, WA_MSG].every((s) => e.scopes.includes(s))) {
        this.add(D, DN, "PASS", "WA_ACCESS_TOKEN on this deployment is already a valid never-expiring system-user token for this app (mint skipped; force_mint:true mints another)", { already_present: true, scopes: e.scopes, expires: "never" });
        return;
      }
    }
    const scope = ALL_SCOPES.join(",");
    const proof = this.appSecret ? createHmac("sha256", this.appSecret).update(this.tok).digest("hex") : undefined;
    const form1: Record<string, string> = { business_app: app, scope, set_token_expires_in_60_days: "false" };
    if (proof) form1.appsecret_proof = proof;
    let r = await this.g.call("POST", `/${suId}/access_tokens`, { token: this.tok, form: form1 });
    let edge = "system_user/access_tokens";
    if (!r.ok && r.code === 100) {
      const form2: Record<string, string> = { system_user_id: suId, scope, set_token_expires_in_60_days: "false" }; // business/system_user_access_tokens has no app param: the app is the one that owns the calling token
      if (proof) form2.appsecret_proof = proof;
      const r2 = await this.g.call("POST", `/${biz}/system_user_access_tokens`, { token: this.tok, form: form2 });
      if (r2.ok) { r = r2; edge = "business/system_user_access_tokens"; }
    }
    const minted = r.ok ? r.body?.access_token : undefined;
    if (!r.ok || typeof minted !== "string" || minted.length < 16) {
      this.add(D, DN, "FAIL", `mint: ${r.ok ? "no access_token in response" : r.error}. Fallback: Business Settings > System users > Generate token (checklist).`); return;
    }
    this.r.add(minted);
    const v = await this.debug(minted, minted);
    const scopesOk = [WA_MGMT, WA_MSG].every((s) => v.scopes.includes(s));
    const facts = { edge, type: v.type, scopes: v.scopes, expires: v.expiresAt === 0 ? "never" : v.expiresAt ? isoSec(v.expiresAt) : "unknown", app_id: v.appId, token_sha256_8: sha8(minted) };
    this.secrets.WA_ACCESS_TOKEN = minted; // returned once in secret_delivery, never logged or stored
    if (v.valid && v.type === "SYSTEM_USER" && v.expiresAt === 0 && scopesOk && v.appId === app) {
      this.add(D, DN, "PASS", "minted and verified with debug_token: valid, SYSTEM_USER, never expires, WhatsApp scopes present. Delivered once in secret_delivery.", facts);
      this.next.push("Set WA_ACCESS_TOKEN (and WA_APP_SECRET) as Worker secrets from secret_delivery now (wrangler secret put, value on stdin); never paste them into chat.");
    } else {
      this.add(D, DN, "FAIL", `minted but verification failed (${v.valid ? `type ${v.type}, expires ${facts.expires}, scopes ${v.scopes.join(",")}` : v.error}). The token is delivered once anyway in secret_delivery so you can revoke it; do NOT use it until it verifies.`, facts);
    }
  }

  // ---- phone ------------------------------------------------------------------------------------------------------------------
  needPhoneId(step: string): string | null {
    const id = this.ids.phone_number_id;
    if (!id) this.add(step, step, "FAIL", "phone_number_id required (the waba step lists the numbers)");
    return id;
  }

  async phoneAdd(): Promise<void> {
    const S = "phone_add", N = "Phone number added to the WABA";
    const waba = this.ids.waba_id, ph = this.q.phone;
    if (!waba) { this.add(S, N, "FAIL", "need waba_id (waba step first)"); return; }
    if (!ph) { this.add(S, N, "FAIL", "need phone:{cc, phone_number, verified_name}"); return; }
    const want = ph.cc + ph.number;
    const l = await this.phones(waba);
    if (!l.ok) { this.add(S, N, "FAIL", `GET phone_numbers: ${l.error}`); return; }
    const hit = list(l.body).find((p) => String(p.display_phone_number ?? "").replace(/\D/g, "") === want);
    if (hit) { this.ids.phone_number_id = String(hit.id); this.add(S, N, "PASS", "number already on this WABA (add skipped)", { ...this.pf(hit), added: false }); return; }
    const p = await this.g.call("POST", `/${waba}/phone_numbers`, { token: this.tok, form: { cc: ph.cc, phone_number: ph.number, verified_name: ph.name } });
    if (!p.ok || !p.body?.id) { this.add(S, N, "FAIL", `POST phone_numbers: ${p.ok ? "no id in response" : p.error}`); return; }
    const id = String(p.body.id);
    const v = await this.phone(id);
    if (!v.ok) { this.add(S, N, "FAIL", `added (${id}) but read-back failed: ${v.error}`, { phone_number_id: id }); return; }
    this.ids.phone_number_id = id;
    this.add(S, N, "PASS", "added and read back; next: phone_request_code", { ...this.pf(v.p), added: true });
  }

  async requestCode(): Promise<void> {
    const S = "phone_request_code", N = "Verification code requested";
    const id = this.needPhoneId(S); if (!id) return;
    const before = await this.phone(id);
    if (!before.ok) { this.add(S, N, "FAIL", before.error); return; }
    if (before.p.code_verification_status === "VERIFIED") { this.add(S, N, "SKIP", "number already VERIFIED (nothing to request)", this.pf(before.p)); return; }
    if (guardHit(this.ctx, `rc:${id}`, 3, 3600_000)) { this.add(S, N, "FAIL", "rate_guard: at most 3 code requests per number per hour from this deployment (Meta throttles and may block). Wait, then retry once.", this.pf(before.p)); return; }
    const p = await this.g.call("POST", `/${id}/request_code`, { token: this.tok, form: { code_method: this.q.codeMethod, language: this.q.language } });
    if (!p.ok) { this.add(S, N, "FAIL", `POST request_code: ${p.error}`, this.pf(before.p)); return; }
    this.add(S, N, "PASS", `${this.q.codeMethod} code requested; give the 6 digits to the bot via the secure form, then run phone_verify_code`, { ...this.pf(before.p), code_method: this.q.codeMethod });
  }

  async verifyCode(): Promise<void> {
    const S = "phone_verify_code", N = "Phone number verified";
    const id = this.needPhoneId(S); if (!id) return;
    const before = await this.phone(id);
    if (!before.ok) { this.add(S, N, "FAIL", before.error); return; }
    if (before.p.code_verification_status === "VERIFIED") { this.add(S, N, "SKIP", "already VERIFIED", this.pf(before.p)); return; }
    if (!this.q.code) { this.add(S, N, "FAIL", "code required (6 digits, from the secure form)", this.pf(before.p)); return; }
    const p = await this.g.call("POST", `/${id}/verify_code`, { token: this.tok, form: { code: this.q.code } });
    if (!p.ok) { this.add(S, N, "FAIL", `POST verify_code: ${p.error}`, this.pf(before.p)); return; }
    const v = await this.phone(id);
    if (v.ok && v.p.code_verification_status === "VERIFIED") this.add(S, N, "PASS", "verified (read back); next: phone_register", this.pf(v.p));
    else this.add(S, N, "FAIL", v.ok ? `POST accepted but code_verification_status is ${v.p.code_verification_status ?? "unknown"}` : `read-back failed: ${v.error}`);
  }

  async register(): Promise<void> {
    const S = "phone_register", N = "Phone number registered (Cloud API)";
    const id = this.needPhoneId(S); if (!id) return;
    const before = await this.phone(id);
    if (!before.ok) { this.add(S, N, "FAIL", before.error); return; }
    if (!this.q.forceRegister && before.p.status === "CONNECTED" && before.p.platform_type === "CLOUD_API") { this.add(S, N, "SKIP", "already CONNECTED on the Cloud API (register skipped; force_register:true overrides)", this.pf(before.p)); return; }
    if (before.p.code_verification_status !== "VERIFIED") { this.add(S, N, "FAIL", "not_verified: run phone_request_code / phone_verify_code first (no call made)", this.pf(before.p)); return; }
    let pin = this.q.pin;
    let generated = false;
    if (!pin && this.q.generatePin) { pin = String(randomInt(100000, 1000000)); generated = true; this.r.add(pin); }
    if (!pin) { this.add(S, N, "FAIL", "pin required: 6 digits (secure form) or generate_pin:true to get one returned once", this.pf(before.p)); return; }
    const p = await this.g.call("POST", `/${id}/register`, { token: this.tok, form: { messaging_product: "whatsapp", pin } });
    if (!p.ok) { this.add(S, N, "FAIL", `POST register: ${p.error}`, this.pf(before.p)); return; }
    if (generated) this.secrets.REGISTRATION_PIN = pin;
    const v = await this.phone(id);
    if (!v.ok) { this.add(S, N, "FAIL", `register accepted but read-back failed: ${v.error}`); return; }
    const connected = String(v.p.status ?? "").toUpperCase() === "CONNECTED";
    this.add(S, N, connected ? "PASS" : v.p.status ? "FAIL" : "WARN", connected ? "registered (status CONNECTED, read back)" : `status ${v.p.status ?? "not readable"} after register`, this.pf(v.p));
    if (connected) this.next.push("Keep the registration PIN in the bot's secret store: Meta needs it again to change the PIN or delete the number.");
  }

  // ---- subscribed_apps / webhook ----------------------------------------------------------------------------------------------------
  async subscribed(): Promise<void> {
    const S = "subscribed_apps", N = "App subscribed to the WABA";
    const waba = this.ids.waba_id, app = this.ids.app_id;
    if (!waba || !app) { this.add(S, N, "FAIL", `need ${!waba ? "waba_id (waba step first)" : "app_id"}`); return; }
    const has = (b: any) => list(b).some((x) => String(x?.whatsapp_business_api_data?.id ?? x?.id) === app);
    const g1 = await this.g.call("GET", `/${waba}/subscribed_apps`, { token: this.tok });
    if (!g1.ok) { this.add(S, N, "FAIL", `GET subscribed_apps: ${g1.error}`); return; }
    if (has(g1.body)) { this.add(S, N, "PASS", "app already subscribed (skipped)", { waba_id: waba, app_id: app, subscribed: true, changed: false }); return; }
    const p = await this.g.call("POST", `/${waba}/subscribed_apps`, { token: this.tok, form: {} });
    if (!p.ok) { this.add(S, N, "FAIL", `POST subscribed_apps: ${p.error}`); return; }
    const v = await this.g.call("GET", `/${waba}/subscribed_apps`, { token: this.tok });
    if (v.ok && has(v.body)) this.add(S, N, "PASS", "subscribed and read back", { waba_id: waba, app_id: app, subscribed: true, changed: true });
    else this.add(S, N, "FAIL", v.ok ? "POST accepted but the app is not listed afterwards" : `read-back failed: ${v.error}`);
  }

  async webhook(origin: string): Promise<void> {
    const q = this.q, cfg = this.ctx.cfg;
    const url = q.webhookUrl ?? `${origin}/api/webhook`;
    const verify = cfg.waVerifyToken;
    const H = "webhook_handshake_local", HN = "This deployment answers the webhook handshake with its own verify token";
    let path = "";
    try { path = new URL(url).pathname; } catch { /* invalid */ }
    if (!/\/api\/webhook\/?$/.test(path)) { this.add(H, HN, "FAIL", "webhook_url must be an https URL ending in /api/webhook"); return; }
    if (!verify || verify.length < 16) { this.add(H, HN, "FAIL", "WA_VERIFY_TOKEN is not set (or shorter than 16 chars) on this deployment"); return; }
    const probe = new URL(url);
    probe.searchParams.set("hub.mode", "subscribe"); probe.searchParams.set("hub.verify_token", verify); probe.searchParams.set("hub.challenge", "setupcheck");
    const hv = handleVerify(this.ctx, probe);
    if (hv.status !== 200 || (await hv.text()) !== "setupcheck") { this.add(H, HN, "FAIL", "internal handshake check failed"); return; }
    this.add(H, HN, "PASS", "in-process handshake OK (no network)");
    const dashboard = {
      where: "developers.facebook.com > your app > WhatsApp > Configuration > Webhook > Edit",
      callback_url: url, verify_token: verify, subscribe_to_fields: q.webhookFields,
      note: "the verify token is only a handshake string (not the app secret); enter both values exactly, press Verify and save",
    };
    const S = "webhook", N = "App-level webhook callback + verify token";
    const app = this.ids.app_id, secret = this.appSecret;
    const manual = (why: string) => { this.manual = dashboard; this.add(S, N, "WARN", `${why}. Enter the dashboard values returned under "manual".`, { mode: "manual_needed", callback_url: url }); };
    if (!app) { manual("app_id unknown"); return; }
    if (!secret) { manual("no app secret (send app_secret in the body, or set WA_APP_SECRET and redeploy)"); return; }
    const appTok = `${app}|${secret}`;
    this.r.add(appTok);
    const read = async () => {
      const r = await this.g.call("GET", `/${app}/subscriptions`, { appToken: appTok });
      if (!r.ok) return { ok: false as const, error: r.error };
      const e = list(r.body).find((x) => x.object === "whatsapp_business_account");
      const fields: string[] = e && Array.isArray(e.fields) ? e.fields.map((f: any) => String(f.name ?? f)) : [];
      const match = !!e && sameUrl(String(e.callback_url ?? ""), url) && q.webhookFields.every((f) => fields.includes(f));
      return { ok: true as const, match, fields };
    };
    const b = await read();
    if (!b.ok) manual(`app secret rejected or edge unavailable (${b.error})`);
    else if (b.match) this.add(S, N, "PASS", "already set (skipped)", { mode: "app", callback_url: url, fields: b.fields, changed: false });
    else {
      const p = await this.g.call("POST", `/${app}/subscriptions`, { appToken: appTok, form: { object: "whatsapp_business_account", callback_url: url, verify_token: verify, fields: q.webhookFields.join(","), include_values: "true" } });
      const a = await read();
      if (a.ok && a.match) this.add(S, N, "PASS", "set at app level and read back", { mode: "app", callback_url: url, fields: a.fields, changed: true });
      else manual(p.ok ? "POST accepted but the subscription does not read back as expected" : `POST refused: ${p.error}`);
    }
    if (q.wabaOverride) {
      const waba = this.ids.waba_id;
      if (!waba) { this.add("waba_override", "WABA-level callback override", "FAIL", "need waba_id"); return; }
      const o = await this.g.call("POST", `/${waba}/subscribed_apps`, { token: this.tok, form: { override_callback_uri: url, verify_token: verify } });
      const v = await this.g.call("GET", `/${waba}/subscribed_apps`, { token: this.tok });
      const hit = v.ok && list(v.body).some((x) => sameUrl(String(x?.whatsapp_business_api_data?.override_callback_uri ?? x?.override_callback_uri ?? ""), url));
      this.add("waba_override", "WABA-level callback override", hit ? "PASS" : "FAIL", hit ? "override read back" : o.ok ? "override not visible afterwards" : `POST refused: ${o.error}`);
    }
  }

  // ---- templates / display name / test send ---------------------------------------------------------------------------------------------
  async templates(): Promise<void> {
    const S = "templates", N = "Message templates submitted";
    const waba = this.ids.waba_id;
    if (!waba) { this.add(S, N, "FAIL", "need waba_id (waba step first)"); return; }
    if (!this.q.templates.length) { this.add(S, N, "SKIP", "no templates given"); return; }
    const out: Record<string, unknown>[] = [];
    let bad = false;
    const find = async (name: string, language: string) => {
      const l = await this.g.call("GET", `/${waba}/message_templates`, { token: this.tok, query: { name, fields: "id,name,status,language,category", limit: "50" } });
      return l.ok ? { ok: true as const, hit: list(l.body).find((x) => x.name === name && x.language === language) } : { ok: false as const, error: l.error };
    };
    for (const t of this.q.templates) {
      const allow = this.ctx.cfg.templateAllowlist.includes(t.name);
      const ex = await find(t.name, t.language);
      if (!ex.ok) { bad = true; out.push({ name: t.name, result: "FAIL", error: ex.error }); continue; }
      if (ex.hit) { out.push({ name: t.name, language: t.language, result: "exists", status: ex.hit.status ?? null, allowlisted: allow }); continue; }
      const p = await this.g.call("POST", `/${waba}/message_templates`, { token: this.tok, form: { name: t.name, category: t.category, language: t.language, components: JSON.stringify(t.components) } });
      if (!p.ok) { bad = true; out.push({ name: t.name, result: "FAIL", error: p.error }); continue; }
      const nx = await find(t.name, t.language);
      if (!nx.ok || !nx.hit) { bad = true; out.push({ name: t.name, result: "FAIL", error: "submitted but not visible on read-back" }); continue; }
      out.push({ name: t.name, language: t.language, result: "submitted", status: nx.hit.status ?? null, allowlisted: allow });
    }
    const notAllowed = out.filter((o) => o.allowlisted === false).map((o) => o.name);
    const status: Status = bad ? "FAIL" : notAllowed.length ? "WARN" : "PASS";
    this.add(S, N, status, bad ? "some templates failed (see facts)" : `${out.length} template(s) handled; approval is Meta's (webhook message_template_status_update)${notAllowed.length ? `. Not in WA_TEMPLATE_ALLOWLIST yet: ${notAllowed.join(", ")} (the bridge will not send them)` : ""}`, { templates: out });
  }

  async displayName(): Promise<void> {
    const S = "display_name", N = "Display name submitted";
    const id = this.needPhoneId(S); if (!id) return;
    const want = this.q.newDisplayName;
    if (!want) { this.add(S, N, "FAIL", "new_display_name required"); return; }
    const b = await this.phone(id);
    if (!b.ok) { this.add(S, N, "FAIL", b.error); return; }
    const facts = (p: any) => ({ ...this.pf(p), new_display_name: p.new_display_name ?? null, new_name_status: p.new_name_status ?? null });
    if (String(b.p.verified_name) === want) { this.add(S, N, "SKIP", "this is already the verified name", facts(b.p)); return; }
    if (String(b.p.new_display_name ?? "") === want) { this.add(S, N, "PASS", "already submitted and pending Meta review (skipped)", facts(b.p)); return; }
    const p = await this.g.call("POST", `/${id}`, { token: this.tok, form: { new_display_name: want } });
    if (!p.ok) { this.add(S, N, "FAIL", `POST new_display_name: ${p.error}`, facts(b.p)); return; }
    const v = await this.phone(id);
    if (v.ok && String(v.p.new_display_name ?? v.p.verified_name) === want) this.add(S, N, "PASS", "submitted and read back; approval is Meta's (webhook phone_number_name_update). Review can take up to ~14 days; after APPROVED, re-run phone_register (Meta asks the number to be registered again).", facts(v.p));
    else this.add(S, N, "FAIL", v.ok ? "accepted but the new display name does not read back" : `read-back failed: ${v.error}`);
  }

  async testSend(): Promise<void> {
    const S = "test_send", N = "Test template message";
    const cfg = this.ctx.cfg, q = this.q;
    if (cfg.launchMode === "live") { this.add(S, N, "FAIL", "blocked_live_mode: test sends are only allowed while LAUNCH_MODE is test (no call made)"); return; }
    if (!q.testTo) { this.add(S, N, "FAIL", "to required (an entry of TEST_RECIPIENTS)"); return; }
    if (!cfg.testRecipients.includes(q.testTo)) { this.add(S, N, "FAIL", "blocked_test_mode_recipient_not_allowlisted: add the number to TEST_RECIPIENTS first (no call made)"); return; }
    if (!q.confirm) { this.add(S, N, "FAIL", `confirm_required: send confirm:true to send ONE "${q.testTemplate}" template to ${maskTail(q.testTo, 3)} (no call made)`); return; }
    const id = this.needPhoneId(S); if (!id) return;
    const waba = this.ids.waba_id;
    if (!waba) { this.add(S, N, "FAIL", "need waba_id (waba step first)"); return; }
    const t = await this.g.call("GET", `/${waba}/message_templates`, { token: this.tok, query: { name: q.testTemplate, fields: "id,name,status,language", limit: "50" } });
    if (!t.ok) { this.add(S, N, "FAIL", `GET templates: ${t.error}`); return; }
    const ok = list(t.body).find((x) => x.name === q.testTemplate && x.language === q.testLanguage && String(x.status).toUpperCase() === "APPROVED");
    if (!ok) { this.add(S, N, "FAIL", `no APPROVED template ${q.testTemplate}/${q.testLanguage} on this WABA`); return; }
    if (guardHit(this.ctx, `ts:${id}:${q.testTo}:${q.testTemplate}`, 1, 300_000)) { this.add(S, N, "FAIL", "duplicate_send_suppressed: the same test message was already sent from this deployment in the last 5 minutes"); return; }
    const p = await this.g.call("POST", `/${id}/messages`, { token: this.tok, form: { messaging_product: "whatsapp", to: q.testTo, type: "template", template: JSON.stringify({ name: q.testTemplate, language: { code: q.testLanguage } }) } });
    const mid = p.ok ? p.body?.messages?.[0]?.id : undefined;
    if (typeof mid !== "string") { this.add(S, N, "FAIL", p.ok ? "no message id in the response" : `POST messages: ${p.error}`); return; }
    this.add(S, N, "PASS", "accepted by Meta (message id returned); delivery status arrives on the webhook", { to_masked: maskTail(q.testTo, 3), template: q.testTemplate, message_id_sha256_8: sha8(mid) });
  }
}

// ------------------------------------------------------------------------------------------------------------------------------
// HTTP handlers
// ------------------------------------------------------------------------------------------------------------------------------
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Content-Type": "application/json" };
const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...HEADERS, "WWW-Authenticate": 'Bearer realm="admin"' } });
const jerr = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export function metaSetupGet(ctx: Ctx, req: Request): Response {
  if (!adminAuthorized(ctx, req)) return unauthorized();
  const c = ctx.cfg;
  return jerr(200, {
    route: "meta-setup", dry_run: c.metaSetupDryRun, graph_version: c.graphVersion, launch_mode: c.launchMode,
    env_present: { WA_ACCESS_TOKEN: !!c.waAccessToken, WA_APP_SECRET: !!c.waAppSecret, WA_VERIFY_TOKEN: !!c.waVerifyToken, WA_PHONE_NUMBER_IDS: c.phoneNumberIds.length > 0, TEST_RECIPIENTS: c.testRecipients.length },
    default_webhook_url: `${new URL(req.url).origin}/api/webhook`,
    steps: ["preflight", ...STEP_ORDER], default_run: DEFAULT_RUN,
    ...(c.metaSetupDryRun ? { dry_run_token: DRY_RUN_TOKEN } : {}),
    note: "POST {action|steps, bootstrap_token, ...}. See docs/META-GUIDED-CHECKLIST.md. GET makes no Meta call.",
  });
}

export async function metaSetupPost(ctx: Ctx, req: Request): Promise<Response> {
  if (!adminAuthorized(ctx, req)) return unauthorized();
  const r = new Redactor();
  for (const s of [ctx.cfg.waAccessToken, ctx.cfg.waAppSecret, ctx.cfg.adminToken, ctx.cfg.mcpToken, ctx.cfg.cronSecret]) r.add(s);
  try {
    const u = new URL(req.url);
    for (const k of ["bootstrap_token", "access_token", "token", "app_secret", "code", "pin"]) {
      if (u.searchParams.has(k)) return jerr(400, { error: "bad_request", field: k, reason: "secrets are accepted in the JSON body only, never in the URL" });
    }
    const raw = await req.text();
    if (raw.length > MAX_BODY) return jerr(413, { error: "body_too_large" });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return jerr(400, { error: "bad_request", field: "body", reason: "invalid JSON" }); }
    // register the secrets with the redactor BEFORE anything else can echo them
    if (parsed && typeof parsed === "object") {
      for (const k of ["bootstrap_token", "app_secret", "code", "pin"]) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === "string") { r.add(v); const d = v.replace(/\D/g, ""); if (d !== v) r.add(d); }
      }
    }
    let q: Req;
    try { q = parseReq(parsed); } catch (e) {
      if (e instanceof BadReq) return jerr(400, { error: "bad_request", field: e.field, reason: e.reason });
      throw e;
    }
    const dry = ctx.cfg.metaSetupDryRun;
    const t0 = ctx.now();
    const stub = dry ? new FakeMeta({ dryRun: true }).fetch : undefined;
    const g = new Graph(stub ?? ctx.fetch, q.graphVersion ?? ctx.cfg.graphVersion, r, () => TIME_BUDGET_MS - (ctx.now() - t0));
    const s = new Setup(ctx, q, g, r);
    s.tok = q.token ?? ctx.cfg.waAccessToken ?? "";
    s.tokenSource = q.token ? "body" : "env";
    if (!s.tok) return jerr(400, { error: "bad_request", field: "bootstrap_token", reason: "required (or set WA_ACCESS_TOKEN on this deployment)" });
    r.add(s.tok);
    s.appSecret = q.appSecret ?? ctx.cfg.waAppSecret;
    if (s.appSecret) r.add(s.appSecret);

    const proceed = await s.preflight();
    const origin = new URL(req.url).origin;
    let blockedBy: string | null = proceed ? null : "preflight";
    for (const step of q.steps) {
      if (blockedBy) { s.add(step, step, "SKIP", `blocked by ${blockedBy}`); continue; }
      if (TIME_BUDGET_MS - (ctx.now() - t0) < 3000) { s.add(step, step, "SKIP", "time_budget: re-run to continue (completed steps are skipped)"); continue; }
      if (!s.scopeOk(step)) { if (!q.continueOnFail) blockedBy = step; continue; }
      const before = s.results.length;
      switch (step) {
        case "businesses": await s.businesses(); break;
        case "waba": await s.waba(); break;
        case "system_user": await s.systemUser(); break;
        case "phone_add": await s.phoneAdd(); break;
        case "phone_request_code": await s.requestCode(); break;
        case "phone_verify_code": await s.verifyCode(); break;
        case "phone_register": await s.register(); break;
        case "subscribed_apps": await s.subscribed(); break;
        case "webhook": await s.webhook(origin); break;
        case "templates": await s.templates(); break;
        case "display_name": await s.displayName(); break;
        case "test_send": await s.testSend(); break;
      }
      const bad = s.results.slice(before).find((x) => x.status === "FAIL");
      if (bad && !q.continueOnFail) blockedBy = bad.id;
    }
    const sum = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const x of s.results) sum[x.status.toLowerCase() as keyof typeof sum]++;
    const out: Record<string, unknown> = {
      ok: sum.fail === 0 && sum.pass > 0, dry_run: dry, graph_version: q.graphVersion ?? ctx.cfg.graphVersion, token_source: s.tokenSource,
      steps_requested: q.steps, ids: s.ids, summary: sum, results: s.results,
      ...(s.manual ? { manual: s.manual } : {}), ...(s.next.length ? { next: s.next } : {}),
      ...(dry ? { dry_run_notice: "META_SETUP_DRY_RUN=1: every Meta call was answered by a built-in stub; nothing was sent to graph.facebook.com and all ids/values are fake." } : {}),
    };
    ctx.log("meta_setup", { steps: q.steps.length, pass: sum.pass, fail: sum.fail, dry });
    const body = JSON.parse(r.redact(JSON.stringify(out))) as Record<string, unknown>;
    if (Object.keys(s.secrets).length) {
      body.secret_delivery = {
        delivered_once: true, values: s.secrets,
        handling: "Shown once, never stored or logged by the bridge. Put WA_ACCESS_TOKEN into the Worker as a secret immediately (wrangler secret put, value on stdin); keep REGISTRATION_PIN in your own secret store.",
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
  } catch (e) {
    ctx.log("meta_setup_error", { err: e instanceof Error ? e.name : "unknown" });
    return jerr(500, { ok: false, error: "internal_error" });
  }
}
