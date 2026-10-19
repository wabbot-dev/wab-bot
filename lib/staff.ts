import { hmacHex, safeEqual, sha256hex } from "./crypto";
import type { Ctx } from "./ctx";
import { update } from "./store";

/**
 * Staff sign-in for the team inbox without handing out ADMIN_TOKEN. The owner (or the owner's bot, which holds the token)
 * asks for a ONE-TIME invite code (POST /api/admin {action:"staff_invite"}, Bearer ADMIN_TOKEN). The code is short-lived
 * (default 15 minutes), single-use and only its hash is stored. Redeeming it at /admin sets an HttpOnly, Secure,
 * SameSite=Strict session cookie signed with ADMIN_TOKEN (rotating ADMIN_TOKEN signs every staff session out).
 * A cookie session may read the inbox and act on conversations; changing requests also need the X-Staff-Request header
 * (a cross-site form cannot set it), and it can never mint further invites or touch secrets.
 */

export const STAFF_INVITES_KEY = "staff/invites";
export const STAFF_COOKIE = "wb_staff";
export const SESSION_MS = 12 * 3600_000;
const MAX_INVITES = 20;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
interface InviteRow { list: { h: string; exp: number; used?: number }[] }

export function newCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length) % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function createInvite(ctx: Ctx, ttlMinutes: number, rand: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): Promise<{ code: string; expires_at: string }> {
  const code = newCode(rand);
  const now = ctx.now();
  const exp = now + Math.min(60, Math.max(5, Math.floor(ttlMinutes))) * 60_000;
  await update<InviteRow, null>(ctx, STAFF_INVITES_KEY, (cur) => {
    const list = (cur?.list ?? []).filter((x) => x.exp > now && !x.used).slice(-(MAX_INVITES - 1));
    list.push({ h: sha256hex(normCode(code)), exp });
    return { next: { list }, result: null };
  });
  ctx.log("staff_invite", { ttl_min: Math.round((exp - now) / 60_000) });
  return { code, expires_at: new Date(exp).toISOString() };
}

/** Single use: the matching invite is marked used in the same commit that accepts it. */
export async function redeemInvite(ctx: Ctx, code: string): Promise<boolean> {
  if (typeof code !== "string" || code.length > 40) return false;
  const h = sha256hex(normCode(code));
  const r = await update<InviteRow, boolean>(ctx, STAFF_INVITES_KEY, (cur) => {
    const now = ctx.now();
    const hit = cur?.list.find((x) => !x.used && x.exp > now && safeEqual(x.h, h));
    if (!cur || !hit) return { next: undefined, result: false };
    hit.used = now;
    return { next: { list: cur.list.filter((x) => x.exp > now) }, result: true };
  });
  ctx.log("staff_login", { ok: r.result });
  return r.result;
}

export const sessionValue = (adminToken: string, exp: number): string => `${exp}.${hmacHex(adminToken, `staff-session|${exp}`)}`;

export function cookieOf(req: Request, name = STAFF_COOKIE): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Valid, unexpired session cookie signed with the current ADMIN_TOKEN. Returns its expiry or null. */
export function sessionOf(req: Request, adminToken: string | undefined, now: number): number | null {
  if (!adminToken || adminToken.length < 16) return null;
  const v = cookieOf(req);
  const m = v ? /^(\d{13})\.([0-9a-f]{64})$/.exec(v) : null;
  if (!m) return null;
  const exp = Number(m[1]);
  if (!(exp > now) || exp - now > SESSION_MS + 60_000) return null;
  return safeEqual(m[2]!, hmacHex(adminToken, `staff-session|${exp}`)) ? exp : null;
}

export const sessionCookie = (value: string, maxAgeSec: number) =>
  `${STAFF_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
