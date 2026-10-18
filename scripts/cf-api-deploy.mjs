#!/usr/bin/env node
// Deploy / verify / tear down the bridge on Cloudflare through the Cloudflare REST API instead of `wrangler deploy`.
// For people who cannot use `wrangler login` (CI, locked-down machines) and for the throwaway tests in STATUS.
// Zero dependencies (Node >= 20). Free plan only: nothing here upgrades a plan, buys a domain or creates KV/R2/D1.
//
//   node scripts/cf-api-deploy.mjs init      --secrets-file F [--from-env] [--map NAME=ENVVAR ...]     (self-provisioning: make the local setup file)
//   node scripts/cf-api-deploy.mjs deploy    --name NAME --secrets-file F --self-provision [--var K=V ...] [--cron "0 5 * * *"] [--bundle worker.js]
//                                             [--emit-plugin-js OUT.js]            (ONLY the plain-text SETUP_NONCE is uploaded; no secret bindings)
//     add --migrate-from v1 when redeploying a Worker made before voice calling existed (adds the CallSession object); a new Worker needs nothing
//     add --purge-secret-bindings when re-deploying over a Worker that already had secret bindings; --no-nonce for a redeploy after setup
//   node scripts/cf-api-deploy.mjs provision --url https://NAME.SUB.workers.dev --secrets-file F        (POST /api/setup once; locks it)
//   node scripts/cf-api-deploy.mjs rotate    --url URL --admin-token-file F --secrets-file G             (later changes, needs ADMIN_TOKEN)
//   node scripts/cf-api-deploy.mjs deploy    --name NAME --secrets-file F [--var K=V ...] ...            (classic: values as secret_text bindings)
//   node scripts/cf-api-deploy.mjs subdomain --name NAME [--subdomain SUB]                              (only make sure the account has a workers.dev subdomain)
//   node scripts/cf-api-deploy.mjs verify    --url https://NAME.SUB.workers.dev --secrets-file F [--phone ID]
//   node scripts/cf-api-deploy.mjs teardown  --name NAME [--emit-plugin-js OUT.js]
//
// workers.dev subdomain: a brand-new Cloudflare account has none, so `deploy` first does GET /accounts/{id}/workers/subdomain and, only if
//   none is registered, PUT /accounts/{id}/workers/subdomain with "<worker name>-<6 random hex>" (new suffix on a name clash, a few tries) or
//   --subdomain NAME (tried once), reads it back and builds the URL from it. An existing subdomain is never changed. `subdomain --name NAME
//   [--subdomain NAME]` does just this step (deploy-cloudflare.sh calls it when a token is exported).
//
// Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment, OR --emit-plugin-js, which writes an `async () => {...}`
// for a tool that already holds a Cloudflare session (the file then contains your secrets: it is created mode 0600, delete/shred it after use).
// Token permissions (create the token for THIS ONE account, nothing broader; no zone, user or "all accounts" scopes; set an expiry):
//   Account > Workers Scripts > Edit    the only permission required. The dry run of 2026-10-17 found it sufficient for wrangler deploy
//                                       (upload, secrets, cron, Durable Object migrations) and for registering the workers.dev subdomain
//                                       by hand with PUT. (This script's own subdomain step has not been run live; a token that carries
//                                       nothing else was not separately tested.)
//   Account > Account Settings > Read   NOT needed by this script. The Cloudflare API reference lists "Workers Scripts Write" (PUT) and
//                                       "Workers Scripts Read or Write" (GET) for the subdomain endpoints, not Account Settings
//                                       (per Cloudflare docs, not tested with a token that lacks it). Do not add it.
//   Registering a subdomain needs Workers Scripts: Edit (Cloudflare docs list "Workers Scripts Write" for the PUT; the by-hand PUT worked
//   with an Edit token in the dry run). A read-only token (Workers Scripts: Read) can read the subdomain but not register one or
//   deploy (per Cloudflare docs, not tested).
//   Do not create the token broader than needed (no Workers KV/R2/D1, DNS, Zone, Account Settings: Edit, no Global API Key). See docs/CLOUDFLARE.md.
// Secrets file: KEY=VALUE lines, mode 0600, never printed. Classic deploy uploads them as secret_text bindings. Self-provisioning
// (--self-provision) uploads only SETUP_NONCE (a plain-text var); `provision` then sends the rest to POST /api/setup over HTTPS.
// Why: plugins that redact secret values (the Cloudflare MCP plugin does) cannot carry secret bindings, and no API token or
// `wrangler login` is needed this way. See docs/SELF-PROVISIONING.md.
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSubdomain } from "./cf-subdomain.mjs";

const SECRET_NAMES = ["WA_APP_SECRET", "WA_VERIFY_TOKEN", "MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET", "WA_ACCESS_TOKEN", "WAKE_KEY", "XAI_API_KEY"];
const VAR_NAMES = ["LAUNCH_MODE", "WA_PHONE_NUMBER_IDS", "WAKE_URL", "WAKE_DEBOUNCE_MS", "META_SETUP_ENABLED", "MAX_MESSAGES", "WAKE_TYPES", "WAKE_AUTH", "WAKE_HEADER", "STALE_WAKE_MS",
  "CALLING_MODE", "CALLING_GO_NUMBER", "CALLING_BV_DONE", "CALLING_PHONE_NUMBER_ID", "CALL_ALLOWED_CALLERS", "CALL_MAX_SECONDS", "CALL_BUDGET_SECONDS", "CALL_VOICE", "CALL_LANGUAGE_HINT", "CALL_DISCLOSE_AI", "CALL_SIP_WEBHOOKS", "CALL_RECORDING_LINE", "CALL_TRANSCRIPTS", "CALL_TRANSCRIPT_RETENTION_DAYS", "CALL_BUSINESS_NAME", "CALL_GREETING", "CALL_INSTRUCTIONS"];
const SETTING_NAMES = ["LAUNCH_MODE", "TEST_RECIPIENTS", "WA_PHONE_NUMBER_IDS", "WA_TEMPLATE_ALLOWLIST", "WAKE_URL", "WAKE_HEADER", "WAKE_AUTH", "WAKE_DEBOUNCE_MS", "WAKE_TYPES", "GRAPH_VERSION"];
const MANAGED = [...SECRET_NAMES, ...SETTING_NAMES];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$/;

function parseArgs(argv) {
  const o = { _: [], var: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (k === "self-provision" || k === "from-env" || k === "no-nonce" || k === "purge-secret-bindings") { o[k] = "1"; continue; }
    const v = argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    if (k === "var") o.var.push(v);
    else if (k === "map") (o.map ??= []).push(v);
    else o[k] = v;
  }
  return o;
}
function die(m) { console.error("ERROR: " + m); process.exit(1); }

function checkSubdomainFlag(o) {
  if (o.subdomain !== undefined && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(o.subdomain)) die("--subdomain must be 1-63 lowercase letters, digits and dashes, not starting or ending with a dash");
}

function readEnvFile(file, allowed) {
  if (!file) die("--secrets-file is required");
  if (!existsSync(file)) die(`secrets file not found: ${file}`);
  if ((statSync(file).mode & 0o077) !== 0) die(`${file} must be mode 0600 (chmod 600 it)`);
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (!allowed.includes(m[1])) die(`unknown name in file: ${m[1]}`);
    out[m[1]] = m[2];
  }
  return out;
}
function readSecrets(file) {
  const out = readEnvFile(file, SECRET_NAMES);
  for (const n of ["WA_APP_SECRET", "WA_VERIFY_TOKEN", "MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET"]) if (!out[n]) die(`secret ${n} missing in the file`);
  return out;
}
const withNonce = (names) => [...names, "SETUP_NONCE"];
const NONCE_RE = /^[0-9a-f]{32,128}$/;
const hex = (n) => randomBytes(n).toString("hex");

function build(bundle) {
  if (bundle) return readFileSync(bundle, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "wbt-bundle-"));
  const r = spawnSync("npx", ["--no-install", "wrangler", "deploy", "--dry-run", "--minify", "--outdir", dir], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) die("bundling failed:\n" + (r.stdout + r.stderr).split("\n").slice(-8).join("\n"));
  return readFileSync(join(dir, "worker.js"), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/m, "");
}

function tomlValue(re, d) { const m = re.exec(readFileSync("wrangler.toml", "utf8")); return m ? m[1] : d; }

// ---- the programs: run either locally against the REST API or inside a tool that provides `cloudflare.request` ----
const DEPLOY = `async (cloudflare, accountId, input) => {
  const ensureSubdomain = /*ENSURE_SUBDOMAIN*/;
  const base = '/accounts/' + accountId + '/workers';
  // A brand-new account has no workers.dev subdomain: register one BEFORE the first upload (never changes an existing one).
  const sdr = await ensureSubdomain(cloudflare, accountId, { workerName: input.name, subdomain: input.subdomain });
  if (!sdr.ok) return { ok: false, step: 'subdomain', error: sdr.error };
  const before = await cloudflare.request({ method: 'GET', path: base + '/scripts' });
  const exists = (before.result || []).some((s) => s.id === input.name);
  const metadata = { ...input.metadata };
  // v1 = the state object; v2 = the per-call object (voice calling). A new script gets both at once. An existing script gets the
  // missing step: input.migrateFrom is the tag it already has ('v1' for deployments made before voice calling existed; leave unset for v2).
  if (!exists) metadata.migrations = { new_tag: 'v2', new_sqlite_classes: ['BridgeState', 'CallSession'] };
  else if (input.migrateFrom === 'v1') metadata.migrations = { old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['CallSession'] };
  const b = '--F' + Date.now() + Math.random().toString(16).slice(2);
  const body = [
    '--' + b, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata),
    '--' + b, 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"', 'Content-Type: application/javascript+module', '', input.code, '--' + b + '--',
  ].join('\\r\\n');
  const put = await cloudflare.request({ method: 'PUT', path: base + '/scripts/' + input.name, body, contentType: 'multipart/form-data; boundary=' + b, rawBody: true });
  if (!put.success) return { ok: false, step: 'upload', errors: put.errors };
  // Secret bindings of an earlier deployment SURVIVE a re-upload that omits them (found live), and a real binding beats a stored value.
  let purged = [];
  if (input.purge && input.purge.length) {
    const have = await cloudflare.request({ method: 'GET', path: base + '/scripts/' + input.name + '/secrets' });
    for (const sec of (have.result || [])) {
      if (!input.purge.includes(sec.name)) continue;
      const d = await cloudflare.request({ method: 'DELETE', path: base + '/scripts/' + input.name + '/secrets/' + sec.name });
      if (d.success) purged.push(sec.name);
    }
  }
  const sub = await cloudflare.request({ method: 'POST', path: base + '/scripts/' + input.name + '/subdomain', body: { enabled: true, previews_enabled: false } });
  let cron = null;
  if (input.cron && input.cron.length) {
    const c = await cloudflare.request({ method: 'PUT', path: base + '/scripts/' + input.name + '/schedules', body: input.cron.map((x) => ({ cron: x })) });
    cron = { success: c.success, errors: c.errors, result: c.result };
  }
  const sd = sdr.subdomain;
  return { ok: true, existed: exists, accountSubdomain: { name: sd, created: sdr.created }, purgedSecretBindings: purged, subdomainEnabled: !!(sub.success && sub.result && sub.result.enabled), url: sd ? 'https://' + input.name + '.' + sd + '.workers.dev' : null, cron, scriptsBefore: (before.result || []).map((s) => s.id) };
}`;

const TEARDOWN = `async (cloudflare, accountId, input) => {
  const base = '/accounts/' + accountId + '/workers';
  const del = await cloudflare.request({ method: 'DELETE', path: base + '/scripts/' + input.name, query: { force: true } });
  const scripts = await cloudflare.request({ method: 'GET', path: base + '/scripts' });
  const dos = await cloudflare.request({ method: 'GET', path: base + '/durable_objects/namespaces' });
  return { deleted: { success: del.success, errors: del.errors }, scripts: (scripts.result || []).map((s) => s.id), durableObjectNamespaces: (dos.result || []).map((d) => d.name + ':' + d.class) };
}`;

const PROGRAM_PARTS = { "/*ENSURE_SUBDOMAIN*/": ensureSubdomain.toString().replace(/^export\s+/, "") };
const withParts = (program) => program.replace(/\/\*ENSURE_SUBDOMAIN\*\//g, () => PROGRAM_PARTS["/*ENSURE_SUBDOMAIN*/"]);

function restShim() {
  const token = process.env.CLOUDFLARE_API_TOKEN, accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) die("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or use --emit-plugin-js");
  const cloudflare = {
    async request({ method, path, query, body, contentType, rawBody }) {
      const qs = query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])) : "";
      const headers = { Authorization: `Bearer ${token}` };
      let payload;
      if (body !== undefined) { headers["Content-Type"] = contentType ?? "application/json"; payload = rawBody ? body : JSON.stringify(body); }
      const r = await fetch("https://api.cloudflare.com/client/v4" + path + qs, { method, headers, body: payload });
      const j = await r.json().catch(() => ({}));
      return { success: !!j.success, status: r.status, result: j.result, errors: j.errors ?? [] };
    },
  };
  return { cloudflare, accountId };
}

async function run(program, input, o) {
  program = withParts(program);
  if (o["emit-plugin-js"]) {
    const js = `async () => {\n  const input = ${JSON.stringify(input)};\n  return (${program})(cloudflare, accountId, input);\n}\n`;
    writeFileSync(o["emit-plugin-js"], js, { mode: 0o600 });
    console.log(`wrote ${o["emit-plugin-js"]} (mode 0600, ${js.length} chars). Run it with the tool, then delete/shred it.`);
    return;
  }
  const { cloudflare, accountId } = restShim();
  const out = await (0, eval)(`(${program})`)(cloudflare, accountId, input);
  console.log(JSON.stringify(out, null, 2));
  if (out && out.ok === false) { console.error(`ERROR: ${out.step || "step"} failed: ${out.error || JSON.stringify(out.errors ?? out)}`); process.exit(1); }
}

async function verify(o) {
  const url = (o.url || "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url)) die("--url must look like https://<worker>.<account-subdomain>.workers.dev");
  const s = readEnvFile(o["secrets-file"], withNonce(MANAGED));
  for (const n of ["WA_VERIFY_TOKEN", "WA_APP_SECRET"]) if (!s[n]) die(`${n} missing in the file`);
  let bad = 0;
  const check = (label, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? " (" + extra + ")" : ""}`); if (!ok) bad++; };
  const get = (p) => fetch(url + p, { redirect: "manual" });
  let r = await get("/");
  check("GET / is 200", r.status === 200, String(r.status));
  r = await get(`/api/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(s.WA_VERIFY_TOKEN)}&hub.challenge=424242`);
  check("handshake with the right token echoes the challenge", r.status === 200 && (await r.text()) === "424242", String(r.status));
  r = await get("/api/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1");
  check("handshake with a wrong token is 403", r.status === 403, String(r.status));
  r = await get("/api/admin/meta-setup");
  check("meta-setup route is closed (404)", r.status === 404, String(r.status));
  const phone = (o.phone || "100000000001");
  const wa = "15569" + String(Date.now()).slice(-6);
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "2000000000002", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15551000000", phone_number_id: phone }, contacts: [{ profile: { name: "Verify" }, wa_id: wa }], messages: [{ id: "wamid.VERIFY" + Date.now(), from: wa, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: "hello" } }] } }] }] });
  const post = (headers) => fetch(url + "/api/webhook", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload });
  r = await post({});
  check("unsigned POST is 401", r.status === 401, String(r.status));
  r = await post({ "X-Hub-Signature-256": "sha256=" + createHmac("sha256", s.WA_APP_SECRET).update(payload).digest("hex") });
  check("correctly signed POST is 200", r.status === 200, String(r.status));
  r = await post({ "X-Hub-Signature-256": "sha256=" + createHmac("sha256", "wrong-secret-" + Date.now()).update(payload).digest("hex") });
  check("badly signed POST is 401", r.status === 401, String(r.status));
  if (s.SETUP_NONCE) {
    r = await fetch(url + "/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: s.SETUP_NONCE, secrets: { ADMIN_TOKEN: "x".repeat(32) } }) });
    check("a second /api/setup is 403", r.status === 403, String(r.status));
  }
  console.log(`Webhook callback URL for Meta: ${url}/api/webhook`);
  process.exit(bad ? 1 : 0);
}

// ---- self-provisioning helpers (never print a value) ----
function writeEnvFile(file, obj) {
  writeFileSync(file, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

/** init: create or complete the local setup file. Generates SETUP_NONCE and the bridge's own tokens; Meta values come from the environment. */
function init(o) {
  const file = o["secrets-file"];
  if (!file) die("--secrets-file is required");
  const cur = existsSync(file) ? readEnvFile(file, withNonce(MANAGED)) : {};
  const gen = { SETUP_NONCE: hex(24), WA_VERIFY_TOKEN: hex(24), MCP_TOKEN: hex(24), ADMIN_TOKEN: hex(24), CRON_SECRET: hex(24) };
  const added = [];
  for (const [k, v] of Object.entries(gen)) if (!cur[k]) { cur[k] = v; added.push(k); }
  const maps = Object.fromEntries((Array.isArray(o.map) ? o.map : o.map ? [o.map] : []).map((m) => m.split("=")));
  for (const [name, envName] of Object.entries(maps)) {
    if (!MANAGED.includes(name)) die(`--map: unknown name ${name}`);
    if (process.env[envName]) { cur[name] = process.env[envName]; added.push(name); }
  }
  if (o["from-env"] !== undefined) for (const n of MANAGED) if (!cur[n] && process.env[n]) { cur[n] = process.env[n]; added.push(n); }
  writeEnvFile(file, cur);
  console.log(`wrote ${file} (mode 0600). names now present: ${Object.keys(cur).sort().join(", ")}. added/updated: ${added.join(", ") || "none"}`);
}

function webUrl(o) {
  const url = (o.url || "").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url) && !/^https:\/\/[a-z0-9.-]+$/.test(url)) die("--url must be the Worker's https URL");
  return url;
}

/** provision: POST /api/setup once. Prints the HTTP status and the stored NAMES only. */
async function provision(o) {
  const url = webUrl(o);
  const f = readEnvFile(o["secrets-file"], withNonce(MANAGED));
  const { SETUP_NONCE: nonce, ...secrets } = f;
  if (!nonce) die("SETUP_NONCE missing in the file");
  const r = await fetch(url + "/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, secrets }) });
  const j = await r.json().catch(() => ({}));
  console.log(`POST /api/setup -> HTTP ${r.status}${j.error ? " " + j.error : ""}${j.field ? " (" + j.field + ")" : ""}${j.stored ? "; stored: " + j.stored.join(", ") : ""}`);
  process.exit(r.status === 200 ? 0 : 1);
}

/** rotate: change values later; authenticated by the ADMIN_TOKEN (first line of --admin-token-file, or ADMIN_TOKEN= in it). */
async function rotate(o) {
  const url = webUrl(o);
  const tf = o["admin-token-file"];
  if (!tf || !existsSync(tf) || (statSync(tf).mode & 0o077) !== 0) die("--admin-token-file must exist and be mode 0600");
  const raw = readFileSync(tf, "utf8");
  const tok = (/^ADMIN_TOKEN=(.*)$/m.exec(raw)?.[1] ?? raw.split("\n")[0]).trim();
  const secrets = readEnvFile(o["secrets-file"], MANAGED);
  const r = await fetch(url + "/api/admin/secrets", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ secrets }) });
  const j = await r.json().catch(() => ({}));
  console.log(`POST /api/admin/secrets -> HTTP ${r.status}${j.error ? " " + j.error : ""}${j.changed ? "; changed: " + j.changed.join(", ") : ""}${j.overridden_by_env?.length ? "; overridden by a real binding: " + j.overridden_by_env.join(", ") : ""}`);
  process.exit(r.status === 200 ? 0 : 1);
}

const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
if (cmd === "verify") await verify(o);
else if (cmd === "init") init(o);
else if (cmd === "provision") await provision(o);
else if (cmd === "rotate") await rotate(o);
else if (cmd === "subdomain") {
  if (!NAME_RE.test(o.name || "")) die("--name must be lowercase letters, digits and dashes");
  checkSubdomainFlag(o);
  const { cloudflare, accountId } = restShim();
  const r = await ensureSubdomain(cloudflare, accountId, { workerName: o.name, subdomain: o.subdomain });
  if (!r.ok) die(r.error);
  console.log(r.created ? `registered the account's workers.dev subdomain: ${r.subdomain}` : `the account's workers.dev subdomain is already registered (unchanged): ${r.subdomain}`);
} else if (cmd === "deploy") {
  if (!NAME_RE.test(o.name || "")) die("--name must be lowercase letters, digits and dashes");
  checkSubdomainFlag(o);
  const bindings = [{ type: "durable_object_namespace", name: "STATE", class_name: "BridgeState" }, { type: "durable_object_namespace", name: "CALLS", class_name: "CallSession" }];
  if (o["purge-secret-bindings"] !== undefined && o["self-provision"] === undefined) die("--purge-secret-bindings only makes sense with --self-provision");
  if (o["self-provision"] !== undefined) {
    // No secret bindings at all: only the one-time nonce, as a plain-text var.
    if (o["no-nonce"] === undefined) {
      const f = readEnvFile(o["secrets-file"], withNonce(MANAGED));
      if (!NONCE_RE.test(f.SETUP_NONCE || "")) die("SETUP_NONCE missing or malformed in the file (run: init --secrets-file F)");
      bindings.push({ type: "plain_text", name: "SETUP_NONCE", text: f.SETUP_NONCE });
    } // --no-nonce: redeploy AFTER setup so the nonce var is gone from the Worker (the lock in the Durable Object does not depend on it)
  } else {
    const secrets = readSecrets(o["secrets-file"]);
    for (const [name, text] of Object.entries(secrets)) bindings.push({ type: "secret_text", name, text });
  }
  for (const kv of o.var) {
    const i = kv.indexOf("=");
    const k = kv.slice(0, i), v = kv.slice(i + 1);
    if (!VAR_NAMES.includes(k) && o["allow-any-var"] !== "1") die(`unknown var: ${k} (pass --allow-any-var 1 for test-only variables)`);
    bindings.push({ type: "plain_text", name: k, text: v });
  }
  const flags = JSON.parse("[" + tomlValue(/compatibility_flags\s*=\s*\[([^\]]*)\]/, '"nodejs_compat"') + "]");
  if (o.flags) for (const f of o.flags.split(",")) if (!flags.includes(f)) flags.push(f); // test-only override
  const metadata = { main_module: "worker.js", compatibility_date: tomlValue(/compatibility_date\s*=\s*"([^"]+)"/, "2026-10-01"), compatibility_flags: flags, bindings, observability: { enabled: true } };
  await run(DEPLOY, { name: o.name, code: build(o.bundle), metadata, purge: o["purge-secret-bindings"] !== undefined ? SECRET_NAMES : [], subdomain: o.subdomain, cron: o.cron ? o.cron.split(";").map((x) => x.trim()).filter(Boolean) : [], migrateFrom: o["migrate-from"] }, o);
} else if (cmd === "teardown") {
  if (!NAME_RE.test(o.name || "")) die("--name must be lowercase letters, digits and dashes");
  await run(TEARDOWN, { name: o.name }, o);
} else die("usage: cf-api-deploy.mjs deploy|subdomain|verify|teardown (see the header of this file)");
