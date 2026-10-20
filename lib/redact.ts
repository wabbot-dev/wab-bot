/**
 * Output redactor for the Meta setup route. Every string that leaves the route (JSON body, error text echoed by Meta) goes through it.
 * Known secrets (tokens, app secret, OTP, PIN) are registered per request; shape-based patterns are the backstop.
 */
/**
 * Shape-based backstop: strips anything that looks like an API key, a bearer token or a webhook signing secret,
 * whether or not the value was registered. Used by the redactor, the logger and the error paths.
 */
export function redactShapes(text: string): string {
  let t = String(text);
  t = t.replace(/\bxai-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"); // xAI API keys
  t = t.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"); // generic sk-/rk-/pk- style API keys
  t = t.replace(/\bsk_[A-Za-z0-9]{24,}/g, "[REDACTED_KEY]"); // sk_ style API keys (ElevenLabs keys look like this)
  t = t.replace(/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, "[REDACTED]"); // webhook signing secrets
  t = t.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]");
  t = t.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_TOKEN]");
  t = t.replace(/\bEA[A-Za-z0-9]{16,}\b/g, "[REDACTED_TOKEN]"); // Meta access tokens start with EA
  t = t.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_TOKEN]"); // JWT
  t = t.replace(/(Bearer\s+)[A-Za-z0-9_.|~+/=-]{12,}/gi, "$1[REDACTED]");
  return t;
}

/** Redacts known secret values (exact match, plain and URL-encoded) and then the shapes above. */
export function scrubText(text: string, known: Iterable<string | null | undefined> = []): string {
  const r = new Redactor();
  for (const k of known) r.add(k);
  return r.redact(text);
}

export class Redactor {
  private secrets = new Set<string>();

  add(s: string | null | undefined): void {
    if (typeof s === "string" && s.length >= 4) this.secrets.add(s);
  }

  redact(text: string): string {
    let t = String(text);
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      const variants = new Set([s, encodeURIComponent(s)]);
      for (const v of variants) {
        // digits-only secrets (OTP, PIN) must not mangle longer numeric ids that merely contain them
        if (/^\d+$/.test(v)) t = t.replace(new RegExp(`(?<!\\d)${v}(?!\\d)`, "g"), "[REDACTED]");
        else t = t.split(v).join("[REDACTED]");
      }
    }
    t = redactShapes(t);
    t = t.replace(/\b\d{6,}\|[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_APP_TOKEN]"); // app_id|app_secret
    t = t.replace(/\b(access_token|client_secret|appsecret_proof|input_token|pin|app_secret|bootstrap_token)=[^&\s"']+/gi, "$1=[REDACTED]");
    t = t.replace(/\b(code)=\d{6}\b/gi, "$1=[REDACTED]"); // OTP echoed as code=123456
    t = t.replace(/("(?:access_token|client_secret|appsecret_proof|input_token|pin|app_secret|bootstrap_token)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
    return t;
  }
}
