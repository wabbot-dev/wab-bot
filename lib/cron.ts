import { bearerOf, tokenOk } from "./crypto";
import type { Ctx } from "./ctx";
import { retentionPass } from "./retention";
import { retryFailedWakes } from "./wake";

export async function handleCron(ctx: Ctx, req: Request): Promise<Response> {
  if (!tokenOk(bearerOf(req), ctx.cfg.cronSecret)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const tried = await retryFailedWakes(ctx);
  const retention = await retentionPass(ctx);
  return Response.json({ tried, retention });
}
