import { compactConv, IDLE_TRIM_MS } from "./conv";
import type { Ctx } from "./ctx";
import { convKeyOf } from "./conv";
import { update } from "./store";
import type { Conv } from "./types";

/** At most this many conversations are re-examined per pass (oldest untouched first). */
export const RETENTION_BATCH = 100;

/**
 * Retention for idle conversations. Rows are only compacted when they are written (lib/row-store.ts), so a daily pass
 * (Cron Trigger) visits conversations nobody has written for IDLE_TRIM_MS and applies compactConv to them: replied
 * conversations are trimmed after 14 idle days, anything idle > 180 days or flagged deleted is dropped. Also removes
 * expired counter rows. Costs 1 read per batch + 1 conditional write per conversation that actually changes.
 */
export async function retentionPass(ctx: Ctx): Promise<{ examined: number; changed: number; purged: number }> {
  const now = ctx.now();
  const keys = await ctx.store.stale("conv/", now - IDLE_TRIM_MS, RETENTION_BATCH);
  let changed = 0;
  const untouched: string[] = [];
  for (const key of keys) {
    const r = await update<Conv, boolean>(ctx, key, (cur) => {
      if (!cur) return { next: undefined, result: false };
      // writing the unchanged value makes the store apply compactConv (trim or drop) on commit
      return compactConv(cur, ctx.now()) === undefined ? { next: undefined, result: false } : { next: cur, result: true };
    });
    if (r.result) changed++;
    else untouched.push(key);
  }
  // Rows that need no change (e.g. a pending conversation idle for 20 days) are marked examined so the next pass moves on
  // to older-looking rows instead of re-reading the same 100 forever; they come back after another IDLE_TRIM_MS.
  await ctx.store.touch(untouched, now);
  const purged = await ctx.store.purgeExpired(now);
  ctx.log("retention", { examined: keys.length, changed, purged });
  return { examined: keys.length, changed, purged };
}
