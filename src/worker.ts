import pkg from "../package.json" with { type: "json" };
import { adminErase, adminGet, adminPost } from "../lib/admin";
import { handleCron } from "../lib/cron";
import { createAdminMcpRoute } from "../lib/admin-mcp";
import { disarmCalling, sweepCalling, type ArmDeps } from "../lib/calls-arm";
import { handleSipWebhook, type CallHost } from "../lib/calls";
import { createMcpRoute } from "../lib/mcp";
import { MANAGED_KEYS, SECRET_KEYS, sources } from "../lib/secrets";
import { handleVerify, handleWebhookPost, recordHandshake } from "../lib/webhook";
import { redactShapes } from "../lib/redact";
import { retentionPass } from "../lib/retention";
import { retryFailedWakes } from "../lib/wake";
import type { Env } from "./env";
import { ADMIN_HTML, HEALTH_HTML } from "./pages";
import { getCtx } from "./runtime";
import { ensureSecrets, handleAdminSecrets, handleSetup } from "./setup";
import { DurableRateLimiter, stateStub } from "./do-backend";

export { BridgeState } from "./state-do";
export { CallSession } from "./call-do";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const ADMIN_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const html = (body: string, extra: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" }) => new Response(body, { status: 200, headers: extra });

const methodNotAllowed = (allow: string) =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { Allow: allow, "Content-Type": "application/json" } });

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

const callingDeps = (env: Env): ArmDeps => ({ setDeadman: (at) => stateStub(env.STATE).setDeadman(at) });

/** One CallSession Durable Object per call, named by xAI's call id. */
const callHost = (env: Env, ctx: () => ReturnType<typeof getCtx>): CallHost => ({
  start: async (a) => { await env.CALLS.get(env.CALLS.idFromName(a.callId)).start(a); },
  afterFinish: async ({ shouldDisarm }) => { if (shouldDisarm) await disarmCalling(ctx(), "last_call_ended", callingDeps(env)); },
});

/** Names, sources and kinds of the managed credentials for the read-only get_overview tool. Never reads a value out of this function. */
async function secretsInfo(env: Env) {
  const st = await stateStub(env.STATE).getSecrets();
  const src = sources(env, st.values);
  return {
    setup_locked: st.claimed,
    setup_nonce_present: typeof env.SETUP_NONCE === "string" && env.SETUP_NONCE !== "",
    names: Object.fromEntries(MANAGED_KEYS.map((k) => [k, { source: src[k]!, kind: ((SECRET_KEYS as readonly string[]).includes(k) ? "secret" : "setting") as "secret" | "setting" }])),
  };
}

async function route(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const ctx = () => getCtx(env, exec);
  const m = req.method;

  // Self-provisioned credentials must be loaded before any config is built. Static pages and /api/setup do not need them.
  if (path !== "/" && path !== "/api/health" && path !== "/admin" && path !== "/api/setup" && path !== "/api/admin/secrets") await ensureSecrets(env);

  const erase = /^\/api\/admin\/conversations\/([^/]+)$/.exec(path);
  if (erase) return m === "DELETE" ? adminErase(ctx(), req, erase[1]!) : methodNotAllowed("DELETE"); // no decoding: a valid id is plain [a-z0-9_]

  switch (path) {
    case "/api/setup":
      return handleSetup(env, req);
    case "/api/admin/secrets":
      return handleAdminSecrets(env, req);
    case "/":
      return m === "GET" || m === "HEAD" ? html(HEALTH_HTML) : methodNotAllowed("GET, HEAD");
    case "/api/health": // liveness only: no secrets, counts or message data, and no storage read
      return m === "GET" || m === "HEAD" ? new Response(JSON.stringify({ ok: true, version: pkg.version }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) : methodNotAllowed("GET, HEAD");
    case "/admin":
      return m === "GET" || m === "HEAD" ? html(ADMIN_HTML, ADMIN_PAGE_HEADERS) : methodNotAllowed("GET, HEAD");
    case "/api/webhook":
      if (m === "GET") {
        const c = ctx();
        const r = handleVerify(c, url);
        if (r.status === 200) recordHandshake(c); // for the admin MCP status only
        return r;
      }
      if (m === "POST") return handleWebhookPost(ctx(), req);
      return methodNotAllowed("GET, POST");
    case "/api/admin":
      if (m === "GET") return adminGet(ctx(), req);
      if (m === "POST") return adminPost(ctx(), req);
      return methodNotAllowed("GET, POST");
    case "/api/admin/meta-setup": {
      // Off unless META_SETUP_ENABLED=1 (set it only while running Meta setup, then delete it). Lazy import keeps it out of the hot path.
      const c = ctx();
      if (!c.cfg.metaSetupEnabled) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      const { metaSetupGet, metaSetupPost } = await import("../lib/meta-setup");
      if (m === "GET") return metaSetupGet(c, req);
      if (m === "POST") return metaSetupPost(c, req);
      return methodNotAllowed("GET, POST");
    }
    case "/api/cron/retry-wakes":
      return m === "GET" ? handleCron(ctx(), req) : methodNotAllowed("GET");
    case "/mcp":
      return createMcpRoute(ctx, { secretsInfo: () => secretsInfo(env) })(req);
    case "/admin/mcp": // owner-only admin MCP (404 unless ADMIN_MCP_TOKEN is set), see docs/mcp.md
      return createAdminMcpRoute(ctx, { secretsInfo: () => secretsInfo(env), limiter: new DurableRateLimiter(() => stateStub(env.STATE)), calling: callingDeps(env) })(req);
    case "/api/xai-sip": // voice calling webhook from xAI (404 while the owner gate is closed), see docs/VOICE-CALLS.md
      return handleSipWebhook(ctx(), req, callHost(env, ctx));
    default:
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    try {
      return withHeaders(await route(req, env, exec));
    } catch (e) {
      // Never leak internals; Meta (and the agent) retry on 5xx.
      console.log(JSON.stringify({ event: "unhandled_error", err: e instanceof Error ? redactShapes(e.message).slice(0, 80) : "unknown" }));
      return withHeaders(new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    }
  },

  /** Cron Trigger (wrangler.toml [triggers], daily 05:00 UTC): same retry pass as GET /api/cron/retry-wakes, no HTTP hop. */
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    await ensureSecrets(env);
    const ctx = getCtx(env, exec);
    await retryFailedWakes(ctx);
    await retentionPass(ctx);
    await sweepCalling(ctx, callingDeps(env)).catch(() => false); // closes a calling window that outlived itself
  },
} satisfies ExportedHandler<Env>;
