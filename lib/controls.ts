import type { Ctx } from "./ctx";
import { update, type Snapshot } from "./store";
import type { Controls } from "./types";

export const CONTROLS_KEY = "ctl/controls";

/** Fail-safe: if never written, auto-reply counts as paused. */
export const controlsOf = (snap: Snapshot): Controls =>
  snap.get<Controls>(CONTROLS_KEY)?.value ?? { autoReply: "paused", updatedAt: 0 };

export async function readControls(ctx: Ctx): Promise<Controls> {
  return controlsOf(await ctx.store.snapshot({ keys: [CONTROLS_KEY] }));
}

export async function setAutoReply(ctx: Ctx, value: "paused" | "active"): Promise<Controls> {
  const now = ctx.now();
  const r = await update<Controls, Controls>(ctx, CONTROLS_KEY, () => {
    const next: Controls = { autoReply: value, updatedAt: now };
    return { next, result: next };
  });
  return r.result;
}
