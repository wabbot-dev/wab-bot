#!/usr/bin/env node
// Meta (WhatsApp Cloud API) setup, run on YOUR OWN computer so every call to graph.facebook.com comes from YOUR IP.
// Node >= 20, no dependencies, single file.  Usage and flags: `node scripts/meta-setup.mjs --help`  (docs/META-SETUP.md).
//
// Secrets: the system-user token, the app secret and the registration PIN are read from a HIDDEN prompt (or, for CI, from the env vars
// META_SYSTEM_USER_TOKEN / META_APP_SECRET / META_REGISTER_PIN). They are NEVER accepted as command-line arguments, never printed, never logged;
// every line of output goes through a redactor. They are written only to a local mode-0600 file when you pass --write-secrets <file>.
// The final JSON bundle contains NON-secret facts only and is safe to share with your agent or a maintainer.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, openSync, writeSync, closeSync, fstatSync, fchmodSync, writeFileSync, chmodSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERSION = "1.1.0";
export const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];
export const DEFAULT_GRAPH_VERSION = "v25.0";
const HTTP_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------------------------------------------------------------------
export class Redactor {
  constructor() { this.secrets = new Set(); }
  add(s) { if (typeof s === "string" && s.length >= 4) this.secrets.add(s); }
  redact(text) {
    let t = String(text);
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) t = t.split(s).join("[REDACTED]");
    t = t.replace(/\bEA[A-Za-z0-9]{16,}\b/g, "[REDACTED_TOKEN]");              // Meta access tokens start with EA
    t = t.replace(/\b\d{6,}\|[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_APP_TOKEN]");   // app_id|app_secret
    t = t.replace(/\b(access_token|client_secret|appsecret_proof|input_token|pin)=[^&\s"']+/gi, "$1=[REDACTED]");
    t = t.replace(/(Bearer\s+)[A-Za-z0-9_.|-]{12,}/gi, "$1[REDACTED]");
    return t;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// argument parsing (secrets are refused as arguments)
// ---------------------------------------------------------------------------------------------------------------------------------------
const FORBIDDEN_FLAGS = ["token", "access-token", "system-user-token", "app-secret", "secret", "pin", "register-pin", "password"];
const VALUE_FLAGS = ["waba-id", "phone-number-id", "webhook-url", "verify-token", "app-id", "graph-version", "test-to", "template", "template-lang", "write-secrets", "json-out", "worker-name", "project-dir"];
const BOOL_FLAGS = ["register", "waba-override", "phone-override", "replace-webhook", "skip-app-subscription", "skip-handshake", "allow-expiring", "yes", "force", "push-cloudflare", "no-prompt", "help", "version"];

export function parseArgs(argv) {
  const o = { flags: {}, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o.errors.push(`unexpected argument "${a.length > 12 ? a.slice(0, 4) + "..." : a}"`); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (FORBIDDEN_FLAGS.includes(name)) { o.errors.push(`--${name} is not accepted: secrets are never passed as arguments (they would land in shell history and process lists). You will be asked at a hidden prompt.`); continue; }
    if (BOOL_FLAGS.includes(name)) { o.flags[name] = true; continue; }
    if (VALUE_FLAGS.includes(name)) {
      let v;
      if (eq !== -1) v = a.slice(eq + 1);
      else { v = argv[++i]; if (v === undefined || v.startsWith("--")) { o.errors.push(`--${name} needs a value`); if (v !== undefined) i--; continue; } }
      o.flags[name] = v; continue;
    }
    o.errors.push(`unknown flag --${name}`);
  }
  return o;
}

export const NEW_APP_STEPS = [
  "developers.facebook.com > My Apps > Create app: type Business, use case WhatsApp, and pick the SAME business portfolio",
  "on the new app's WhatsApp > API Setup, add this bot's number (a new WhatsApp Business Account in the same portfolio keeps the bots apart)",
  "Business Settings > System users: give a system user full control of the NEW app and that WhatsApp account; generate a never-expiring token for the new app",
  "re-run this script with the new app's token and app secret (--app-id <new app id>); the webhook is then set at the new app's level",
];

export function hostOf(u) { try { return new URL(u).host; } catch { return "(unreadable)"; } }

export const HELP = `Meta (WhatsApp Cloud API) setup, run on your own device.

  node scripts/meta-setup.mjs [flags]

Asked at a hidden prompt (never as arguments): system-user token, app secret (Enter to skip), registration PIN (only with --register).
Ask-or-flag (non-secret): --waba-id <id> --phone-number-id <id> --webhook-url <https://.../api/webhook> --verify-token <token>

Flags
  --app-id <id>           Meta app id (default: read from debug_token)
  --graph-version <vNN.0> default ${DEFAULT_GRAPH_VERSION}
  --waba-override         ALSO set the callback on the WABA itself (POST /{waba}/subscribed_apps override_callback_uri). Off by default.
  --phone-override        route ONLY this phone number to this bridge (POST /{phone-number-id} webhook_configuration.override_callback_uri);
                          the app-level callback is left alone. Fallback for ONE bot answering several numbers on a shared app; never
                          chosen automatically.

One bot per Meta app (default): if the app's webhook callback already points to ANOTHER deployment, nothing is changed and the
webhook step FAILs with "new app required": create a NEW Meta app for this bot in the same business portfolio (its own webhook,
app secret and system-user token) and re-run with that app's token. --phone-override or --replace-webhook only on purpose.
  --replace-webhook       allow replacing a callback that points to ANOTHER deployment (app, WABA or number level). Never the default.
  --skip-app-subscription never try to set the app-level webhook; just print the dashboard values
  --skip-handshake        do not test the webhook handshake against your bridge first
  --allow-expiring        an expiring token is a WARN instead of FAIL (temporary 24h token from the API Setup page)
  --register              register the phone number with Meta (asks for a 6-digit PIN at a hidden prompt; sets two-step verification)
  --test-to <number>      send ONE template message (default hello_world / en_US) to this recipient only (digits, with country code)
  --template <name> --template-lang <code>
  --write-secrets <file>  write WA_ACCESS_TOKEN / WA_APP_SECRET to a local file with mode 0600 (refuses to overwrite without --force)
  --push-cloudflare       run "wrangler secret put" for those two secrets on THIS device (values go through stdin only, never argv; uses the Worker name in wrangler.toml)
  --worker-name <name>    Worker name for --push-cloudflare (default: the name in wrangler.toml)
  --project-dir <dir>     template folder for --push-cloudflare (default: current directory)
  --json-out <file>       also save the result bundle to a file
  --yes                   do not ask for confirmation before --register / --test-to
  --no-prompt             never prompt; everything must come from flags / env vars
  --help, --version

Exit code: 0 all executed steps PASS (WARN allowed), 1 a step FAILED, 2 bad usage.`;

// ---------------------------------------------------------------------------------------------------------------------------------------
// Graph client
// ---------------------------------------------------------------------------------------------------------------------------------------
function describeGraphError(body, status) {
  const e = body && typeof body === "object" ? body.error : undefined;
  if (!e) return `HTTP ${status}`;
  const parts = [`HTTP ${status}`, `code ${e.code ?? "?"}${e.error_subcode ? "/" + e.error_subcode : ""}`, e.type ?? ""].filter(Boolean);
  let hint = "";
  const c = Number(e.code);
  if (c === 190) hint = " (token invalid, expired or revoked: generate a new system-user token)";
  else if (c === 10 || c === 200 || c === 299) hint = " (permission missing: the token's system user needs the WhatsApp permissions AND access to this WABA/app)";
  else if (c === 100) hint = " (invalid parameter or no access to that object: check the id and the system user's asset assignment)";
  else if (c === 4 || c === 17 || c === 32 || c === 613 || c === 80007) hint = " (rate limited: wait and retry)";
  else if (c === 131030) hint = " (recipient is not in the allowed recipient list of the test number)";
  else if (c === 133010) hint = " (phone number not registered: run with --register)";
  return `${parts.join(" ")}: ${e.message ?? "no message"}${hint}`;
}

export class Graph {
  constructor({ fetchImpl, version, redactor }) { this.f = fetchImpl; this.version = version; this.r = redactor; }
  // request(method, path, {token, query, form, json, base}) -> {ok, status, body, error}
  // The token always travels in the Authorization header, never in a URL we could print.
  async request(method, path, { token, query, form, json, absolute } = {}) {
    let url = absolute ? path : `https://graph.facebook.com/${this.version}${path}`;
    if (query) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
    else if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    try {
      const res = await this.f(url, { method, headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      let parsed; const text = await res.text();
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: this.r.redact(text.slice(0, 200)) }; }
      if (!res.ok || (parsed && parsed.error)) return { ok: false, status: res.status, body: parsed, error: this.r.redact(describeGraphError(parsed, res.status)) };
      return { ok: true, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: this.r.redact(`network error: ${err && err.name === "TimeoutError" ? "timeout" : (err && err.message) || String(err)}`) };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// hidden prompt
// ---------------------------------------------------------------------------------------------------------------------------------------
export function createPrompter(stdin = process.stdin, stderr = process.stderr) {
  let buffered = "", ended = false, waiter = null;
  const nonTty = !stdin.isTTY;
  const pushLine = () => { if (waiter) { const i = buffered.indexOf("\n"); if (i !== -1 || ended) { const w = waiter; waiter = null; const line = i === -1 ? buffered : buffered.slice(0, i); buffered = i === -1 ? "" : buffered.slice(i + 1); w(line.replace(/\r$/, "")); } } };
  if (nonTty) {
    stdin.setEncoding("utf8");
    stdin.on("data", (d) => { buffered += d; pushLine(); });
    stdin.on("end", () => { ended = true; pushLine(); });
    stdin.pause();
  }
  const readLine = () => new Promise((resolve) => { waiter = resolve; if (nonTty) { stdin.resume(); pushLine(); } });
  const readTty = (label, hidden) => new Promise((resolve) => {
    stderr.write(label);
    let value = "";
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") { done(); return; }
        if (ch === "\u0003") { stderr.write("\n"); stdin.setRawMode(false); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;   // pasted text arrives as one chunk; control characters are dropped
      }
      if (!hidden) { /* visible: terminal is in raw mode, so echo ourselves */ }
    };
    const done = () => { stdin.removeListener("data", onData); stdin.setRawMode(false); stdin.pause(); stderr.write("\n"); resolve(value.trim()); };
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8"); stdin.on("data", onData);
  });
  const ask = async (label, hidden) => {
    if (!nonTty) {
      if (hidden) return readTty(label, true);
      stderr.write(label); // visible: plain line read in cooked mode
      return new Promise((resolve) => { stdin.setEncoding("utf8"); stdin.resume(); stdin.once("data", (d) => { stdin.pause(); resolve(String(d).split(/\r?\n/)[0].trim()); }); });
    }
    stderr.write(label + (hidden ? "(input is not a terminal: reading one line from stdin) " : ""));
    const line = await readLine(); stderr.write("\n"); return line.trim();
  };
  return { ask, hidden: (label) => ask(label, true), visible: (label) => ask(label, false), interactive: !nonTty };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// local secret file (mode 0600)
// ---------------------------------------------------------------------------------------------------------------------------------------
export function writeSecretsFile(path, entries, { force = false, platform = process.platform } = {}) {
  if (existsSync(path) && !force) throw new Error(`${path} already exists (use --force to overwrite)`);
  const content = Object.entries(entries).filter(([, v]) => v).map(([k, v]) => `${k}=${v}\n`).join("");
  const fd = openSync(path, force ? "w" : "wx", 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, content); const mode = fstatSync(fd).mode & 0o777; return { mode: mode.toString(8).padStart(3, "0"), enforced: platform !== "win32" && mode === 0o600 }; }
  finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------------------------
const sha8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const maskTail = (s, n = 3) => (s ? `${"*".repeat(Math.max(0, String(s).length - n))}${String(s).slice(-n)}` : null);
const isId = (s) => /^\d{5,25}$/.test(s || "");
const normPhone = (s) => String(s || "").replace(/[^\d]/g, "");
const iso = (sec) => new Date(sec * 1000).toISOString();

function sameUrl(a, b) { try { const x = new URL(a), y = new URL(b); return x.origin + x.pathname.replace(/\/+$/, "") === y.origin + y.pathname.replace(/\/+$/, ""); } catch { return false; } }

// ---------------------------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------------------------
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const redactor = new Redactor();
  const errW = deps.stderr ?? ((s) => process.stderr.write(s));
  const outW = deps.stdout ?? ((s) => process.stdout.write(s));
  const info = (s = "") => errW(redactor.redact(s) + "\n");
  const rawInfo = (s = "") => errW(s + "\n"); // ONLY for the deliberate dashboard-values block
  const parsed = parseArgs(argv);
  if (parsed.errors.length) { for (const e of parsed.errors) info(`ERROR: ${e}`); info("Run with --help for usage."); return { code: 2 }; }
  const fl = parsed.flags;
  if (fl.help) { outW(HELP + "\n"); return { code: 0 }; }
  if (fl.version) { outW(VERSION + "\n"); return { code: 0 }; }

  const prompter = deps.prompter ?? (fl["no-prompt"] ? null : createPrompter());
  const canAsk = !!prompter && !fl["no-prompt"];
  const askVisible = async (label) => (canAsk ? prompter.visible(label) : "");
  const askHidden = async (label) => (canAsk ? prompter.hidden(label) : "");

  // ---- inputs -------------------------------------------------------------------------------------------------------------------------
  info(`Meta setup v${VERSION}: all calls to graph.facebook.com are made from THIS device. Nothing secret is printed.`);
  let token = env.META_SYSTEM_USER_TOKEN || "";
  if (!token) token = (await askHidden("System-user token (hidden; paste then Enter): ")).trim();
  if (!token) { info("ERROR: no token provided."); return { code: 2 }; }
  redactor.add(token);

  const need = async (flag, label, check, what) => {
    let v = fl[flag] ?? "";
    if (!v) v = (await askVisible(`${label}: `)).trim();
    if (!check(v)) { info(`ERROR: ${what}`); return null; }
    return v;
  };
  const wabaId = await need("waba-id", "WhatsApp Business Account (WABA) id", isId, "WABA id must be digits (copy it from the app's WhatsApp > API Setup page, or Business Settings > WhatsApp accounts)");
  if (!wabaId) return { code: 2 };
  const phoneId = await need("phone-number-id", "Phone number id", isId, "phone number id must be digits (WhatsApp > API Setup, 'Phone number ID')");
  if (!phoneId) return { code: 2 };
  const webhookUrl = await need("webhook-url", "Webhook callback URL (https://<alias>/api/webhook)", (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } }, "webhook URL must be a valid https URL");
  if (!webhookUrl) return { code: 2 };
  const verifyToken = await need("verify-token", "Webhook verify token", (v) => v.length >= 8, "verify token is required (the WA_VERIFY_TOKEN of your bridge)");
  if (!verifyToken) return { code: 2 };
  redactor.add(verifyToken);
  const graphVersion = fl["graph-version"] || DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(graphVersion)) { info("ERROR: --graph-version must look like v25.0"); return { code: 2 }; }
  const testTo = fl["test-to"] ? normPhone(fl["test-to"]) : "";
  if (fl["test-to"] && !/^\d{7,15}$/.test(testTo)) { info("ERROR: --test-to must be one phone number in international format (digits)"); return { code: 2 }; }

  const g = new Graph({ fetchImpl, version: graphVersion, redactor });
  let appSecret = env.META_APP_SECRET || "";
  let webhookDone = false, newAppRequired = "";
  const steps = [];
  const bundle = {
    tool: "meta-setup.mjs", version: VERSION, generatedAt: (deps.now ? deps.now() : new Date()).toISOString(), graphVersion,
    ok: false, wabaId, phoneNumberId: phoneId, appId: null, scopes: [], tokenType: null, tokenExpires: null,
    webhook: { url: webhookUrl, verifyTokenSha256_8: sha8(verifyToken), mode: "not_set", callbackVerified: false, fields: [] },
    subscription: { subscribed: false, appIdMatches: null }, phone: {}, waba: {}, steps,
    secrets: { tokenReceived: true, appSecretReceived: false, writtenTo: null, cloudflarePush: null },
  };
  const step = (id, name, status, detail = "") => {
    steps.push({ id, name, status, detail: redactor.redact(detail) });
    info(`${status.padEnd(4)}  ${name}${detail ? " - " + detail : ""}`);
    return status;
  };
  const failed = () => steps.some((s) => s.status === "FAIL");
  info("");

  // ---- 0 bridge handshake (your own bridge, not Meta) --------------------------------------------------------------------------------
  if (!fl["skip-handshake"]) {
    const challenge = "setup" + sha8(String(Math.random()));
    try {
      const u = new URL(webhookUrl); u.searchParams.set("hub.mode", "subscribe"); u.searchParams.set("hub.verify_token", verifyToken); u.searchParams.set("hub.challenge", challenge);
      const res = await fetchImpl(u.toString(), { method: "GET", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const text = (await res.text()).trim();
      if (res.status === 200 && text === challenge) step("handshake", "Bridge answers the webhook handshake with your verify token", "PASS", "200 + challenge echoed");
      else step("handshake", "Bridge answers the webhook handshake with your verify token", "FAIL", `HTTP ${res.status}; check the webhook URL host and WA_VERIFY_TOKEN`);
    } catch (e) { step("handshake", "Bridge answers the webhook handshake with your verify token", "FAIL", `unreachable: ${(e && e.message) || e}`); }
    if (!/\/api\/webhook\/?$/.test(new URL(webhookUrl).pathname)) info("      note: the bridge's webhook path is /api/webhook");
  }

  // ---- 1 debug_token -----------------------------------------------------------------------------------------------------------------
  let tokenValid = false, appId = fl["app-id"] || null, granular = [];
  {
    const r = await g.request("GET", "/debug_token", { token, query: { input_token: token } });
    // input_token travels in the query of a request we never print; the redactor also scrubs it from any message.
    if (!r.ok) step("debug_token", "Token check (debug_token)", "FAIL", r.error);
    else {
      const d = r.body.data || {};
      const scopes = Array.isArray(d.scopes) ? d.scopes : [];
      bundle.scopes = scopes; bundle.tokenType = d.type ?? null; granular = Array.isArray(d.granular_scopes) ? d.granular_scopes : [];
      if (d.app_id) { appId = appId || String(d.app_id); bundle.appId = String(d.app_id); }
      if (fl["app-id"] && d.app_id && String(d.app_id) !== fl["app-id"]) info(`      note: --app-id ${fl["app-id"]} differs from the token's app ${d.app_id}`);
      const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      const expiresAt = Number(d.expires_at ?? -1);
      bundle.tokenExpires = expiresAt === 0 ? "never" : expiresAt > 0 ? iso(expiresAt) : "unknown";
      if (d.data_access_expires_at !== undefined) bundle.dataAccessExpiresAt = Number(d.data_access_expires_at) === 0 ? "never" : iso(Number(d.data_access_expires_at));
      if (d.is_valid !== true) { step("debug_token", "Token is valid", "FAIL", `Meta says the token is not valid${d.error?.message ? ": " + d.error.message : ""} (expired or revoked)`); }
      else {
        tokenValid = true;
        step("debug_token", "Token is valid", "PASS", `type ${d.type ?? "?"}, app ${d.app_id ?? "?"}`);
        if (missing.length) step("scopes", "Required scopes present", "FAIL", `missing: ${missing.join(", ")} (have: ${scopes.join(", ") || "none"}). Re-generate the token and tick both WhatsApp permissions.`);
        else step("scopes", "Required scopes present", "PASS", REQUIRED_SCOPES.join(", "));
        if (expiresAt === 0) step("expiry", "Token never expires", "PASS", "expires_at = 0");
        else {
          const msg = `expires ${bundle.tokenExpires}. Use a system-user token with "Never" expiry for production`;
          step("expiry", "Token never expires", fl["allow-expiring"] ? "WARN" : "FAIL", msg);
        }
        const wm = granular.find((x) => x && x.scope === "whatsapp_business_management");
        if (wm && Array.isArray(wm.target_ids) && wm.target_ids.length) {
          const ok = wm.target_ids.map(String).includes(wabaId);
          step("waba_access", "Token is scoped to this WABA", ok ? "PASS" : "FAIL", ok ? `target ${wabaId}` : `token covers ${wm.target_ids.length} WABA(s), not ${wabaId}`);
        }
      }
    }
  }

  if (!tokenValid) {
    for (const [id, name] of [["waba", "WABA and phone numbers"], ["subscribe", "Subscribe app to WABA"], ["webhook", "Webhook callback"]]) step(id, name, "SKIP", "token invalid");
    return finish(false);
  }

  // ---- 2 WABA + phone numbers --------------------------------------------------------------------------------------------------------
  {
    const w = await g.request("GET", `/${wabaId}`, { token, query: { fields: "id,name,currency,timezone_id,account_review_status" } });
    let wr = w;
    if (!w.ok && Number(w.body?.error?.code) === 100 && /field/i.test(w.body?.error?.message || "")) wr = await g.request("GET", `/${wabaId}`, { token, query: { fields: "id,name" } });
    if (!wr.ok) step("waba", "GET WABA", "FAIL", wr.error);
    else if (String(wr.body.id) !== wabaId) step("waba", "GET WABA", "FAIL", `Meta returned id ${wr.body.id}, expected ${wabaId}`);
    else { bundle.waba = { id: wabaId, name: wr.body.name ?? null, accountReviewStatus: wr.body.account_review_status ?? null }; step("waba", "GET WABA", "PASS", `${wr.body.name ?? "(no name)"}`); }

    const fieldsFull = "id,display_phone_number,verified_name,quality_rating,code_verification_status,status";
    let p = await g.request("GET", `/${wabaId}/phone_numbers`, { token, query: { fields: fieldsFull } });
    if (!p.ok && Number(p.body?.error?.code) === 100 && /field/i.test(p.body?.error?.message || "")) p = await g.request("GET", `/${wabaId}/phone_numbers`, { token, query: { fields: "id,display_phone_number,verified_name" } });
    if (!p.ok) step("phones", "GET phone numbers of the WABA", "FAIL", p.error);
    else {
      const list = Array.isArray(p.body.data) ? p.body.data : [];
      const mine = list.find((x) => String(x.id) === phoneId);
      if (!mine) step("phones", "Phone number id belongs to the WABA", "FAIL", `${phoneId} not among the ${list.length} number(s) of ${wabaId}: ${list.map((x) => x.id).join(", ") || "none"}`);
      else {
        bundle.phone = { id: phoneId, displayNumberMasked: maskTail(mine.display_phone_number ? normPhone(mine.display_phone_number) : null, 4), verifiedName: mine.verified_name ?? null, status: mine.status ?? null, qualityRating: mine.quality_rating ?? null, codeVerificationStatus: mine.code_verification_status ?? null };
        step("phones", "Phone number id belongs to the WABA", "PASS", `${mine.verified_name ?? "?"}, status ${mine.status ?? "?"}, quality ${mine.quality_rating ?? "?"}`);
      }
    }
  }

  // ---- 2b one bot per Meta app: does this app already serve ANOTHER bot? (read only; the number's own view needs no app secret) ------------
  const flagNewApp = (cur) => {
    newAppRequired = hostOf(cur);
    bundle.webhook.mode = "new_app_required";
    bundle.newAppRequired = { currentHost: newAppRequired, appId, steps: NEW_APP_STEPS, override: "--phone-override only if ONE bot should answer several numbers on this app" };
    step("webhook_app_level", "Meta app is free for this bot (one bot per Meta app)", "FAIL", `new app required: this app's webhook already points to another bot (${newAppRequired}); nothing was changed. Create a NEW Meta app for this bot in the same business portfolio and re-run with its token. --phone-override only for one bot answering several numbers`);
  };
  if (!fl["replace-webhook"] && !fl["phone-override"] && !fl["waba-override"] && !fl["skip-app-subscription"]) {
    const v = await g.request("GET", `/${phoneId}`, { token, query: { fields: "webhook_configuration" } });
    const wc = v.ok ? v.body?.webhook_configuration || {} : {};
    const appCb = typeof wc.application === "string" ? wc.application : "";
    const routedHere = typeof wc.phone_number === "string" && sameUrl(wc.phone_number, webhookUrl);
    if (appCb && !sameUrl(appCb, webhookUrl) && !routedHere) flagNewApp(appCb);
  }

  // ---- 3 subscribe app to the WABA ---------------------------------------------------------------------------------------------------
  const readSubs = async () => g.request("GET", `/${wabaId}/subscribed_apps`, { token });
  const subsHaveApp = (body) => {
    const d = Array.isArray(body?.data) ? body.data : [];
    const ids = d.map((x) => String(x?.whatsapp_business_api_data?.id ?? x?.id ?? ""));
    return { any: d.length > 0, has: appId ? ids.includes(String(appId)) : d.length > 0, d };
  };
  if (newAppRequired) step("subscribe", "Subscribe app to WABA", "SKIP", "new app required: the other bot's app is not subscribed to anything new");
  else {
    const pre = await readSubs();
    if (pre.ok) info(`      before: ${subsHaveApp(pre.body).d.length} app(s) subscribed`);
    const post = await g.request("POST", `/${wabaId}/subscribed_apps`, { token, form: {} });
    if (!post.ok) step("subscribe", "POST subscribed_apps", "FAIL", post.error);
    else {
      const ver = await readSubs();
      if (!ver.ok) step("subscribe", "Verify subscription (GET subscribed_apps)", "FAIL", ver.error);
      else {
        const s = subsHaveApp(ver.body);
        bundle.subscription = { subscribed: s.has, appIdMatches: appId ? s.has : null };
        step("subscribe", "App is subscribed to the WABA (verified by GET)", s.has ? "PASS" : "FAIL", s.has ? `app ${appId ?? "?"}` : `POST succeeded (success=${post.body.success}) but ${appId ? "app " + appId : "no app"} is not listed afterwards`);
      }
    }
  }

  // ---- 4 webhook callback + verify token ---------------------------------------------------------------------------------------------------
  const wantApp = !fl["skip-app-subscription"];
  if (!appSecret && wantApp && !newAppRequired && canAsk) appSecret = (await askHidden("App secret (hidden; needed to set the webhook automatically and for the bridge; Enter to skip): ")).trim();
  if (appSecret) { redactor.add(appSecret); bundle.secrets.appSecretReceived = true; }
  if (newAppRequired) step("webhook", "Webhook callback", "SKIP", "new app required (see webhook_app_level)");
  else if (fl["skip-app-subscription"]) step("webhook", "Webhook callback", "SKIP", "--skip-app-subscription: set it in the dashboard (values below)");
  else if (!appSecret || !appId) step("webhook", "Webhook callback (app level)", "SKIP", !appId ? "app id unknown" : "no app secret given; set it in the dashboard (values below)");
  else {
    const appToken = `${appId}|${appSecret}`; redactor.add(appToken);
    const readApp = () => g.request("GET", `/${appId}/subscriptions`, { token: appToken });
    const matches = (body) => {
      const d = Array.isArray(body?.data) ? body.data : [];
      const wa = d.find((x) => x && x.object === "whatsapp_business_account");
      if (!wa) return { ok: false, why: "no whatsapp_business_account subscription on the app" };
      const fields = (Array.isArray(wa.fields) ? wa.fields : []).map((f) => (typeof f === "string" ? f : f?.name)).filter(Boolean);
      bundle.webhook.fields = fields;
      const urlOk = sameUrl(wa.callback_url, webhookUrl), msgs = fields.includes("messages");
      return { ok: urlOk && msgs && wa.active !== false, why: !urlOk ? `callback_url is ${wa.callback_url || "empty"}` : !msgs ? "field 'messages' not subscribed" : wa.active === false ? "subscription inactive" : "" };
    };
    const before = await readApp();
    if (!before.ok) step("webhook_auth", "App secret accepted by Meta (GET /{app}/subscriptions)", "FAIL", before.error);
    else {
      step("webhook_auth", "App secret accepted by Meta (GET /{app}/subscriptions)", "PASS");
      const cur = (Array.isArray(before.body?.data) ? before.body.data : []).find((x) => x && x.object === "whatsapp_business_account")?.callback_url || "";
      const elsewhere = cur && !sameUrl(cur, webhookUrl);
      if (elsewhere && !fl["replace-webhook"] && !fl["phone-override"]) {
        // one bot per Meta app (default): never move the other bot's callback and never share its app silently
        flagNewApp(cur);
      } else if (fl["phone-override"]) {
        info("      --phone-override: the app-level callback is left as it is");
      } else {
        const set = await g.request("POST", `/${appId}/subscriptions`, { token: appToken, form: { object: "whatsapp_business_account", callback_url: webhookUrl, verify_token: verifyToken, fields: "messages", include_values: "true" } });
        if (!set.ok) info(`      app-level POST was refused: ${set.error}`);
        const after = await readApp();
        const m = after.ok ? matches(after.body) : { ok: false, why: after.error };
        if (m.ok) { webhookDone = true; bundle.webhook.mode = "app"; bundle.webhook.callbackVerified = true; step("webhook", "Webhook callback + verify token set at app level (verified by GET)", elsewhere ? "WARN" : "PASS", `${elsewhere ? `replaced ${hostOf(cur)} (--replace-webhook); ` : ""}fields: ${bundle.webhook.fields.join(",")}`); }
        else step("webhook", "Webhook callback + verify token set at app level (verified by GET)", "FAIL", `${set.ok ? "POST accepted but " : ""}${m.why}. Fallback: set the dashboard values below, or retry with --phone-override`);
      }
    }
  }
  if (fl["phone-override"]) {
    const readPn = () => g.request("GET", `/${phoneId}`, { token, query: { fields: "webhook_configuration" } });
    const pre = await readPn();
    const curPn = pre.ok ? pre.body?.webhook_configuration?.phone_number || "" : "";
    if (curPn && !sameUrl(curPn, webhookUrl) && !fl["replace-webhook"]) step("phone_override", "Per-number callback override", "FAIL", `refused: this number is already routed to another deployment (${hostOf(curPn)}); nothing changed. --replace-webhook only if that deployment is retired`);
    else if (webhookUrl.length > 200) step("phone_override", "Per-number callback override", "FAIL", "Meta accepts override URLs up to 200 characters");
    else {
      const set = curPn && sameUrl(curPn, webhookUrl) ? { ok: true } : await g.request("POST", `/${phoneId}`, { token, json: { webhook_configuration: { override_callback_uri: webhookUrl, verify_token: verifyToken } } });
      const ver = await readPn();
      const hit = ver.ok && sameUrl(ver.body?.webhook_configuration?.phone_number || "", webhookUrl);
      if (hit) { webhookDone = true; bundle.webhook.mode = "phone_override"; bundle.webhook.callbackVerified = true; step("phone_override", "Per-number callback override (verified by GET)", "PASS", "only this number is routed here"); }
      else step("phone_override", "Per-number callback override (verified by GET)", "FAIL", set.ok ? "override not visible afterwards (is the app subscribed to the WABA?)" : set.error);
    }
  }
  if (fl["waba-override"]) {
    const pre = await readSubs();
    const curW = (pre.ok && Array.isArray(pre.body?.data) ? pre.body.data : []).map((x) => x?.override_callback_uri || x?.whatsapp_business_api_data?.override_callback_uri || "").find(Boolean) || "";
    const refusedW = curW && !sameUrl(curW, webhookUrl) && !fl["replace-webhook"];
    const set = refusedW ? { ok: false, error: `refused: this WABA is already routed to another deployment (${hostOf(curW)}); nothing changed. Use --phone-override, or --replace-webhook only if that deployment is retired` } : await g.request("POST", `/${wabaId}/subscribed_apps`, { token, form: { override_callback_uri: webhookUrl, verify_token: verifyToken } });
    if (!set.ok) step("waba_override", "WABA-level callback override", "FAIL", set.error);
    else {
      const ver = await readSubs();
      const d = ver.ok && Array.isArray(ver.body.data) ? ver.body.data : [];
      const hit = d.find((x) => sameUrl(x?.whatsapp_business_api_data?.override_callback_uri || x?.override_callback_uri || "", webhookUrl));
      if (hit) { webhookDone = true; if (bundle.webhook.mode === "not_set") bundle.webhook.mode = "waba_override"; bundle.webhook.callbackVerified = true; step("waba_override", "WABA-level callback override (verified by GET)", "PASS"); }
      else step("waba_override", "WABA-level callback override (verified by GET)", "FAIL", ver.ok ? "override not visible afterwards" : ver.error);
    }
  }
  if (newAppRequired) {
    info("");
    info(`      NEW META APP REQUIRED: this app already serves another bot (${newAppRequired}). Its webhook was left as it is. Next:`);
    NEW_APP_STEPS.forEach((s, i) => info(`        ${i + 1}. ${s}`));
    info("      Do NOT enter this bot's callback in the old app's dashboard: that would move every number of the other bot here.");
    info("");
  } else if (!webhookDone) {
    bundle.webhook.mode = "manual_needed";
    info("");
    info("      MANUAL FALLBACK: in developers.facebook.com > your app > WhatsApp > Configuration > Webhook, press Edit and enter:");
    rawInfo(`        Callback URL : ${webhookUrl}`);
    rawInfo(`        Verify token : ${verifyToken}`);
    info("        then Verify and save, and subscribe to the field: messages");
    info("");
  }

  // ---- 5 optional registration -------------------------------------------------------------------------------------------------------
  if (!fl.register) step("register", "Register phone number", "SKIP", "not requested (--register)");
  else {
    let pin = env.META_REGISTER_PIN || "";
    if (!pin && canAsk) pin = (await askHidden("6-digit registration PIN (hidden; sets two-step verification, remember it): ")).trim();
    redactor.add(pin);
    let go = /^\d{6}$/.test(pin);
    if (!go) step("register", "Register phone number", "FAIL", "a 6-digit PIN is required");
    else {
      if (!fl.yes && canAsk) { const a = await askVisible(`Register phone number id ${phoneId} with Meta now? Type "yes": `); go = a.trim().toLowerCase() === "yes"; }
      if (!go) step("register", "Register phone number", "SKIP", "not confirmed");
      else {
        const r = await g.request("POST", `/${phoneId}/register`, { token, json: { messaging_product: "whatsapp", pin } });
        if (!r.ok) step("register", "POST register", "FAIL", r.error);
        else {
          const v = await g.request("GET", `/${phoneId}`, { token, query: { fields: "id,status,code_verification_status,platform_type" } });
          if (v.ok) { bundle.phone.status = v.body.status ?? bundle.phone.status; bundle.phone.platformType = v.body.platform_type ?? null; bundle.phone.codeVerificationStatus = v.body.code_verification_status ?? bundle.phone.codeVerificationStatus; }
          const connected = v.ok && (!v.body.status || String(v.body.status).toUpperCase() === "CONNECTED");
          step("register", "Registered (POST success, verified by GET status)", r.body.success !== false && connected ? "PASS" : "FAIL", v.ok ? `status ${v.body.status ?? "?"}` : v.error);
        }
      }
    }
  }

  // ---- 6 optional test template send -------------------------------------------------------------------------------------------------
  if (!testTo) step("test_send", "Test template message", "SKIP", "not requested (--test-to)");
  else {
    const tpl = fl.template || "hello_world", lang = fl["template-lang"] || "en_US";
    const t = await g.request("GET", `/${wabaId}/message_templates`, { token, query: { name: tpl, fields: "name,status,language", limit: "50" } });
    const found = t.ok && (t.body.data || []).find((x) => x.name === tpl && (x.language === lang) && String(x.status).toUpperCase() === "APPROVED");
    if (!t.ok) step("test_template", "Template exists and is APPROVED", "FAIL", t.error);
    else if (!found) step("test_template", "Template exists and is APPROVED", "FAIL", `no APPROVED template ${tpl}/${lang} on this WABA`);
    else {
      step("test_template", "Template exists and is APPROVED", "PASS", `${tpl}/${lang}`);
      let go = true;
      if (!fl.yes && canAsk) { const a = await askVisible(`Send template "${tpl}" to ${maskTail(testTo)} only (must be an allowed recipient)? Type "yes": `); go = a.trim().toLowerCase() === "yes"; }
      if (!go) step("test_send", "Test template message", "SKIP", "not confirmed");
      else {
        const r = await g.request("POST", `/${phoneId}/messages`, { token, json: { messaging_product: "whatsapp", to: testTo, type: "template", template: { name: tpl, language: { code: lang } } } });
        const id = r.ok && r.body.messages && r.body.messages[0] && r.body.messages[0].id;
        if (id) { bundle.testSend = { to: maskTail(testTo), template: tpl, language: lang, messageIdSha256_8: sha8(String(id)) }; step("test_send", "Test template accepted by Meta (message id returned; delivery status arrives on your webhook)", "PASS", `to ${maskTail(testTo)}`); }
        else step("test_send", "Test template accepted by Meta", "FAIL", r.ok ? "no message id in the response" : r.error);
      }
    }
  }

  return finish(true);

  // ---- 7 secrets handling + result bundle ----------------------------------------------------------------------------------------------
  async function finish(reached) {
    if (newAppRequired && (fl["write-secrets"] || fl["push-cloudflare"])) step("secrets_file", "Secrets for this Worker", "SKIP", "new app required: this app's token and secret belong to the other bot; nothing was written or pushed");
    else if (reached || tokenValid) {
      if (fl["write-secrets"]) {
        try {
          const r = (deps.writeSecrets ?? writeSecretsFile)(fl["write-secrets"], { WA_ACCESS_TOKEN: token, WA_APP_SECRET: appSecret }, { force: !!fl.force });
          bundle.secrets.writtenTo = fl["write-secrets"];
          step("secrets_file", `Secrets written to ${fl["write-secrets"]}`, r.enforced ? "PASS" : "WARN", `mode ${r.mode}${r.enforced ? "" : " (this OS does not enforce 0600: protect the file yourself)"}; delete it after use`);
        } catch (e) { step("secrets_file", "Write secrets file", "FAIL", (e && e.message) || String(e)); }
      }
      if (fl["push-cloudflare"]) {
        const cwd = fl["project-dir"] || process.cwd();
        const run = deps.spawn ?? spawnSync;
        const results = {};
        for (const [name, val] of [["WA_ACCESS_TOKEN", token], ["WA_APP_SECRET", appSecret]]) {
          if (!val) { results[name] = "skipped (no value)"; continue; }
          const args = ["--no-install", "wrangler", "secret", "put", name, ...(fl["worker-name"] ? ["--name", fl["worker-name"]] : [])];
          const r = run("npx", args, { input: val, cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
          results[name] = r.status === 0 ? "set" : `failed (exit ${r.status})`;
        }
        bundle.secrets.cloudflarePush = results;
        const bad = Object.values(results).some((v) => v.startsWith("failed"));
        step("cloudflare_push", "wrangler secret put (stdin)", bad ? "FAIL" : "PASS", Object.entries(results).map(([k, v]) => `${k}: ${v}`).join("; "));
      }
      if (!fl["write-secrets"] && !fl["push-cloudflare"]) {
        info("");
        info("Secrets were NOT saved anywhere. To store them in your Cloudflare Worker WITHOUT printing them, re-run with --write-secrets <file>, then:");
        for (const n of ["WA_ACCESS_TOKEN", "WA_APP_SECRET"]) info(`  sed -n 's/^${n}=//p' <file> | npx wrangler secret put ${n}`);
        info("(or use --push-cloudflare to let this script run those two commands for you). Never paste a token into chat.");
      }
    }
    bundle.ok = !failed() && steps.some((s) => s.status === "PASS");
    const json = JSON.stringify(bundle, null, 2);
    if (fl["json-out"]) { try { (deps.writeFile ?? ((p, c) => { writeFileSync(p, c, { mode: 0o600 }); chmodSync(p, 0o600); }))(fl["json-out"], json + "\n"); info(`Bundle saved to ${fl["json-out"]}`); } catch (e) { info(`could not write ${fl["json-out"]}: ${(e && e.message) || e}`); } }
    info("");
    info(`RESULT: ${bundle.ok ? "ALL EXECUTED STEPS PASSED" : "SOME STEPS FAILED"}   (${steps.filter((s) => s.status === "PASS").length} pass, ${steps.filter((s) => s.status === "FAIL").length} fail, ${steps.filter((s) => s.status === "WARN").length} warn, ${steps.filter((s) => s.status === "SKIP").length} skipped)`);
    info("Copy everything between the markers below and share it with your agent or a maintainer (it contains no secrets):");
    info("----- BEGIN META SETUP BUNDLE -----");
    outW(redactor.redact(json) + "\n");
    info("----- END META SETUP BUNDLE -----");
    return { code: bundle.ok ? 0 : 1, bundle };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((r) => process.exit(r.code), (e) => { process.stderr.write(`unexpected error: ${(e && e.message) || e}\n`); process.exit(1); });
}
