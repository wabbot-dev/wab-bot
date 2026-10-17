/**
 * Fixed-window counters for the admin MCP route. Two layers:
 *  - MemoryRateLimiter: per-isolate Map, zero I/O, bounded size. Stops a hot loop on one isolate without any storage cost.
 *  - A durable limiter (src/do-backend.ts DurableRateLimiter) that keeps the same counters in the single Durable Object, so
 *    the limit holds across isolates. Same interface; the route uses both.
 * Best effort by design: a limiter outage on the failed-attempt path never opens the door (the token compare still decides).
 */
export interface RateResult {
  /** false once the window's budget is spent */
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  hit(key: string, now: number, windowMs: number, max: number): Promise<RateResult>;
}

export function fixedWindowHit(win: { start: number; count: number } | undefined, now: number, windowMs: number, max: number): { win: { start: number; count: number }; result: RateResult } {
  const cur = !win || now - win.start >= windowMs || now < win.start ? { start: now, count: 0 } : win;
  const next = { start: cur.start, count: cur.count + 1 };
  return { win: next, result: { allowed: next.count <= max, count: next.count, retryAfterSec: Math.max(1, Math.ceil((next.start + windowMs - now) / 1000)) } };
}

export class MemoryRateLimiter implements RateLimiter {
  private wins = new Map<string, { start: number; count: number; ms: number }>();
  constructor(private maxKeys = 500) {}

  async hit(key: string, now: number, windowMs: number, max: number): Promise<RateResult> {
    const prev = this.wins.get(key);
    const { win, result } = fixedWindowHit(prev, now, windowMs, max);
    this.wins.delete(key); // re-insert: Map order = recency
    this.wins.set(key, { ...win, ms: windowMs });
    if (this.wins.size > this.maxKeys) {
      for (const [k, w] of this.wins) if (now - w.start >= w.ms) this.wins.delete(k);
      while (this.wins.size > this.maxKeys) this.wins.delete(this.wins.keys().next().value as string);
    }
    return result;
  }

  /** read-only view: how many hits are in the current window (0 if none) */
  peek(key: string, now: number, windowMs: number): number {
    const w = this.wins.get(key);
    return w && now >= w.start && now - w.start < windowMs ? w.count : 0;
  }
}
