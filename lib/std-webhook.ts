import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto";

/**
 * Standard Webhooks v1 (what xAI uses for `realtime.call.incoming`): headers webhook-id, webhook-timestamp, webhook-signature
 * ("v1,<base64> v1,<base64>"). The secret is "whsec_<base64 key>"; the signed content is `${id}.${timestamp}.${rawBody}`;
 * HMAC-SHA256, base64. Constant-time compare; timestamps outside the tolerance (default 300 s, both directions) are refused.
 * Fails closed on anything malformed. Never throws.
 */
export function verifyStandardWebhook(secret: string | undefined, rawBody: string, headers: Headers, nowMs: number, toleranceS = 300): boolean {
  try {
    const id = headers.get("webhook-id");
    const ts = headers.get("webhook-timestamp");
    const sig = headers.get("webhook-signature");
    if (!secret || !id || !ts || !sig) return false;
    if (!/^\d{9,12}$/.test(ts)) return false;
    if (Math.abs(nowMs / 1000 - Number(ts)) > toleranceS) return false;
    const b64 = secret.replace(/^whsec_/, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
    const key = Buffer.from(b64, "base64");
    if (key.length < 16) return false;
    const expect = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
    let ok = false;
    for (const part of sig.split(" ")) {
      const [v, val] = part.split(",");
      if (v === "v1" && val && safeEqual(val, expect)) ok = true; // no early exit: time does not depend on which entry matched
    }
    return ok;
  } catch {
    return false;
  }
}

/** Sign a body the way xAI does (tests and local simulation only). */
export function signStandardWebhook(secret: string, id: string, tsSeconds: number, rawBody: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${tsSeconds}.${rawBody}`).digest("base64");
}
