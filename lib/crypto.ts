import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison (hash both sides, then timingSafeEqual). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const MIN_TOKEN_LEN = 16;

/**
 * Bearer/shared-secret check. Fails closed: an unset or shorter-than-16-char expected
 * token refuses everything.
 */
export function tokenOk(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_TOKEN_LEN) return false;
  if (!provided) return false;
  return safeEqual(provided, expected);
}

export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

/** Meta X-Hub-Signature-256 check over the RAW body bytes (a string is hashed as UTF-8). */
export function verifySignature(rawBody: string | Uint8Array, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(m[1]!.toLowerCase(), expected);
}

export const signBody = (rawBody: string, appSecret: string): string =>
  "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");
