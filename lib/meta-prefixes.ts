/**
 * IPv4 prefixes announced by Meta's autonomous system AS32934 (RADb route objects, snapshot 2026-10-17). Meta publishes no separate
 * list of SIP source addresses, so this is what the voice setup registers as xAI's `allowed_addresses` source allowlist.
 * xAI accepts IPv4 only and every CIDR must be /16 or narrower (observed live on 2026-10-17: IPv6 and wider CIDRs are rejected),
 * so anything wider is split into /16s by `splitTo16`. Meta's ranges change: refresh this list before each release (docs/VOICE-CALLS.md).
 */
export const META_AS32934_V4 = [
  "31.13.24.0/21", "31.13.64.0/18", "45.64.40.0/22", "57.141.0.0/20", "57.141.16.0/21", "57.141.24.0/22", "57.141.28.0/23",
  "57.144.0.0/16", "57.145.0.0/16", "57.146.0.0/16", "57.147.0.0/16", "66.220.144.0/20", "69.63.176.0/20", "69.171.224.0/19",
  "74.119.76.0/22", "102.132.96.0/20", "103.4.96.0/22", "129.134.0.0/16", "147.75.208.0/20", "157.240.0.0/16", "163.70.128.0/17",
  "163.77.128.0/17", "173.252.64.0/18", "179.60.192.0/22", "185.60.216.0/22", "185.89.216.0/22", "204.15.20.0/22",
];

/** Split every IPv4 CIDR shorter than /maxPrefix into /maxPrefix blocks (default /16); drop anything that is not IPv4 CIDR. */
export function splitTo16(cidrs: readonly string[], maxPrefix = 16): string[] {
  const out: string[] = [];
  for (const c of cidrs) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c);
    if (!m) continue;
    const [a, b, c2, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    const len = Number(m[5]);
    if ([a, b, c2, d].some((x) => x > 255) || len > 32) continue;
    if (len >= maxPrefix) { out.push(c); continue; }
    const base = ((a << 24) | (b << 16) | (c2 << 8) | d) >>> 0;
    const n = 2 ** (maxPrefix - len);
    const step = 2 ** (32 - maxPrefix);
    for (let i = 0; i < n; i++) {
      const v = (base + i * step) >>> 0;
      out.push(`${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}/${maxPrefix}`);
    }
  }
  return out;
}
