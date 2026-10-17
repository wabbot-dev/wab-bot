import { bearerOf, safeEqual, tokenOk } from "../lib/crypto";
import { consoleLog } from "../lib/log";
import { MANAGED_KEYS, SECRET_KEYS, mergeEnv, sources, validateSecrets } from "../lib/secrets";
import { stateStub } from "./do-backend";
import type { Env } from "./env";

/**
 * Self-provisioning secrets (see docs/SELF-PROVISIONING.md). Two routes and a per-isolate cache:
 *   POST /api/setup          one-time, authenticated by the plain-text SETUP_NONCE var; stores values in the Durable Object and locks forever
 *   GET|POST /api/admin/secrets   later inspection (names only) and rotation, authenticated by the ADMIN_TOKEN
 * Values are never logged, echoed or returned. Real Worker secret bindings, when present, always win over stored values.
 */

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
const MAX_BODY = 16 * 1024;
const MIN_NONCE_LEN = 32;
/** Other isolates notice a rotation within this long (the isolate that handled it refreshes at once). */
export const SECRETS_TTL_MS = 30_000;

interface Cache { env: Env; at: number; seq: number; values: Record<string, string> }
let cache: Cache | undefined;

/** The loaded credentials for this env (empty before the first load). Sync; getCtx() uses it. */
export function currentSecrets(env: Env): { seq: number; values: Record<string, string> } {
  return cache && cache.env === env ? cache : { seq: 0, values: {} };
}

/** Load (or refresh after SECRETS_TTL_MS) the stored credentials. Await before building a request context. */
export async function ensureSecrets(env: Env, now = Date.now()): Promise<void> {
  if (cache && cache.env === env && now - cache.at < SECRETS_TTL_MS) return;
  try {
    const r = await stateStub(env.STATE).getSecrets();
    cache = { env, at: now, seq: r.seq, values: r.values };
  } catch (e) {
    if (!cache || cache.env !== env) throw e; // nothing to fall back to: fail (Meta retries a 5xx)
    cache.at = now - SECRETS_TTL_MS + 5000; // keep serving the last known values, retry in 5 s
    consoleLog("secrets_refresh_failed", { err: e instanceof Error ? e.message.slice(0, 60) : "unknown" });
  }
}

const forceReload = () => { cache = undefined; };

async function readJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return { ok: false };
  const text = await req.text();
  if (text.length > MAX_BODY) return { ok: false };
  try {
    const b = JSON.parse(text);
    return typeof b === "object" && b !== null && !Array.isArray(b) ? { ok: true, body: b as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** POST /api/setup {nonce, secrets:{...}}. Works once. */
export async function handleSetup(env: Env, req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: "bad_request" }, 400);
  const { nonce, secrets } = parsed.body;
  // 1. nonce, constant time. No SETUP_NONCE configured (or a short one) = setup is off. Same 403 either way.
  const expected = env.SETUP_NONCE;
  if (typeof nonce !== "string" || !expected || expected.length < MIN_NONCE_LEN || !safeEqual(nonce, expected)) {
    consoleLog("setup_denied", { reason: "forbidden" });
    return json({ error: "forbidden" }, 403);
  }
  // 2. validate everything BEFORE claiming, so a typo does not burn the one-time setup.
  const v = validateSecrets(secrets, false);
  if (!v.ok) return json({ error: v.error, field: v.field }, 400);
  const values = v.values as Record<string, string>;
  // Setup is the only time credentials can be added without the admin token, so it must leave an admin token behind.
  const adminOk = typeof values.ADMIN_TOKEN === "string" || (typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length >= 16);
  if (!adminOk) return json({ error: "admin_token_required", field: "ADMIN_TOKEN" }, 400);
  // 3. atomic claim inside the Durable Object: first caller wins, everyone else gets 403 and nothing is written.
  const res = await stateStub(env.STATE).claimSetup(values, Date.now());
  if (!res.ok) {
    consoleLog("setup_denied", { reason: "locked" });
    return json({ error: "setup_locked" }, 403);
  }
  forceReload();
  await ensureSecrets(env);
  consoleLog("setup_claimed", { stored: Object.keys(values).length });
  return json({ ok: true, locked: true, stored: Object.keys(values).sort(), note: "Setup is now permanently locked. Rotate later with POST /api/admin/secrets (ADMIN_TOKEN)." });
}

/** GET /api/admin/secrets: names and sources only. POST {secrets:{NAME:value|null}}: rotate. Admin token required. */
export async function handleAdminSecrets(env: Env, req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
  await ensureSecrets(env);
  const eff = mergeEnv(env, currentSecrets(env).values);
  if (!tokenOk(bearerOf(req), eff.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="admin"' });
  const state = await stateStub(env.STATE).getSecrets();
  const src = sources(env, state.values);
  if (req.method === "GET") {
    return json({
      setup_locked: state.claimed,
      setup_nonce_present: typeof env.SETUP_NONCE === "string" && env.SETUP_NONCE !== "",
      names: Object.fromEntries(MANAGED_KEYS.map((k) => [k, { source: src[k], kind: (SECRET_KEYS as readonly string[]).includes(k) ? "secret" : "setting" }])),
    });
  }
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: "bad_request" }, 400);
  const v = validateSecrets(parsed.body.secrets, true);
  if (!v.ok) return json({ error: v.error, field: v.field }, 400);
  if (!Object.keys(v.values).length) return json({ error: "nothing_to_change" }, 400);
  await stateStub(env.STATE).putSecrets(v.values, Date.now());
  forceReload();
  await ensureSecrets(env);
  const names = Object.keys(v.values).sort();
  consoleLog("secrets_rotated", { changed: names.length });
  return json({ ok: true, changed: names, overridden_by_env: names.filter((n) => src[n] === "env"), note: "Other running instances pick this up within 30 seconds." });
}
