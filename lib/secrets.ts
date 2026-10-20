import { MIN_TOKEN_LEN } from "./crypto";

/**
 * Self-provisioned secrets. A deployment made WITHOUT secret bindings (for example through the Cloudflare plugin or API, which
 * redact secret values) receives its secrets once through POST /api/setup and keeps them in Durable Object storage.
 * Pure logic only (validation, merge); storage lives in src/state-do.ts, the routes in src/setup.ts.
 */

/** Credentials. Never logged, never echoed, never returned by any endpoint. */
export const SECRET_KEYS = ["WA_ACCESS_TOKEN", "WA_APP_SECRET", "WA_VERIFY_TOKEN", "MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET", "WAKE_KEY", "XAI_API_KEY", "ELEVENLABS_API_KEY"] as const;
/** Non-secret settings that may also be provisioned. */
export const SETTING_KEYS = [
  "LAUNCH_MODE", "TEST_RECIPIENTS", "WA_PHONE_NUMBER_IDS", "WA_TEMPLATE_ALLOWLIST", "WA_WABA_ID", "WA_APP_ID", "WAKE_URL", "WAKE_HEADER", "WAKE_AUTH", "WAKE_DEBOUNCE_MS", "WAKE_TYPES", "GRAPH_VERSION",
] as const;
export const MANAGED_KEYS: readonly string[] = [...SECRET_KEYS, ...SETTING_KEYS];

const BEARER_LIKE = new Set(["WA_VERIFY_TOKEN", "MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET"]); // tokenOk() refuses anything shorter than 16
const MAX_VALUE = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SPACE = /\s/;

export type Validated =
  | { ok: true; values: Record<string, string | null> }
  | { ok: false; error: string; field?: string };

/**
 * Check a `secrets` object. Errors name the field and the rule, never the value.
 * `allowNull`: rotation may delete a key (null); first-time setup may not.
 */
export function validateSecrets(input: unknown, allowNull: boolean): Validated {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "secrets_must_be_an_object" };
  const values: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!MANAGED_KEYS.includes(k)) return { ok: false, error: "unknown_name", field: k.slice(0, 40) };
    if (v === null && allowNull) {
      if (k === "ADMIN_TOKEN") return { ok: false, error: "admin_token_cannot_be_deleted", field: k };
      values[k] = null;
      continue;
    }
    if (typeof v !== "string" || v.length === 0) return { ok: false, error: "must_be_a_non_empty_string", field: k };
    if (v.length > MAX_VALUE) return { ok: false, error: "too_long", field: k };
    if (CONTROL.test(v)) return { ok: false, error: "control_characters_not_allowed", field: k };
    if ((SECRET_KEYS as readonly string[]).includes(k) && SPACE.test(v)) return { ok: false, error: "whitespace_not_allowed", field: k };
    if (BEARER_LIKE.has(k) && v.length < MIN_TOKEN_LEN) return { ok: false, error: `must_be_at_least_${MIN_TOKEN_LEN}_chars`, field: k };
    if (k === "LAUNCH_MODE" && v !== "test" && v !== "live") return { ok: false, error: "must_be_test_or_live", field: k };
    values[k] = v;
  }
  return { ok: true, values };
}

/** Environment first (a real binding always wins, even for a stored value that is newer), then the stored value. */
export function mergeEnv(env: object, stored: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  for (const k of MANAGED_KEYS) {
    const e = out[k];
    if ((e === undefined || e.trim() === "") && stored[k] !== undefined) out[k] = stored[k];
  }
  return out;
}

/** Where each managed name currently comes from (names only; never a value). */
export function sources(env: object, stored: Record<string, string>): Record<string, "env" | "stored" | "unset"> {
  const e = env as Record<string, unknown>;
  const out: Record<string, "env" | "stored" | "unset"> = {};
  for (const k of MANAGED_KEYS) {
    const ev = e[k];
    out[k] = typeof ev === "string" && ev.trim() !== "" ? "env" : stored[k] !== undefined ? "stored" : "unset";
  }
  return out;
}
