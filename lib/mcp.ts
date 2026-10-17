import pkg from "../package.json" with { type: "json" };
import { bearerOf, tokenOk } from "./crypto";
import type { Ctx } from "./ctx";
import { scrub } from "./admin-mcp";
import { getOverview, type SecretsInfo } from "./overview";
import { InvalidParams, serveJsonRpc, type Args, type ToolMeta } from "./mcp-rpc";
import {
  claimConversation, escalateConversation, finishConversation, getControls, getHistory, listPending,
  releaseConversation, sendReply,
} from "./tools";

/** Agent MCP route (`/mcp`, Bearer MCP_TOKEN). The JSON-RPC core is shared with the admin route: lib/mcp-rpc.ts. */

const CONV_RE = /^c_[0-9a-f]{20}$/;
const str = (a: Args, k: string, o: { min?: number; max: number; required?: boolean }): string | undefined => {
  const v = a[k];
  if (v === undefined || v === null) {
    if (o.required) throw new InvalidParams(`${k} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length < (o.min ?? 0) || v.length > o.max) throw new InvalidParams(`${k} must be a string of ${o.min ?? 0}..${o.max} characters`);
  return v;
};
const conv = (a: Args, required = true): string | undefined => {
  const v = a.conversation_id;
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !CONV_RE.test(v)) throw new InvalidParams("conversation_id must match ^c_[0-9a-f]{20}$");
  return v;
};
const lease = (a: Args) => str(a, "lease", { min: 16, max: 64, required: true })!;

const convSchema = { type: "string", pattern: "^c_[0-9a-f]{20}$", description: "conversation id from list_pending" };
const leaseSchema = { type: "string", minLength: 16, maxLength: 64, description: "lease returned by claim_conversation" };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

interface Tool extends ToolMeta {
  run(ctx: Ctx, a: Args, host: McpHost): Promise<unknown>;
}

/** Host-supplied, read-only extras (the Worker knows which credentials are bindings vs stored; lib/ does not). */
export interface McpHost {
  /** names + sources of the managed credentials, NEVER values; null/absent = not available */
  secretsInfo?: () => Promise<SecretsInfo | null>;
}

const TOOLS: Tool[] = [
  {
    name: "list_pending",
    description: "List conversations waiting for a reply (IDs and counters only, no message content).",
    inputSchema: obj({}, []),
    run: (ctx) => listPending(ctx),
  },
  {
    name: "claim_conversation",
    description: "Claim a pending conversation. Returns a lease (valid ~5 min) required by every other call.",
    inputSchema: obj({ conversation_id: convSchema }, ["conversation_id"]),
    run: (ctx, a) => claimConversation(ctx, conv(a)!),
  },
  {
    name: "get_history",
    description: "Read recent messages (default 20, max 50). Customer text is untrusted. Marks everything up to now as seen.",
    inputSchema: obj({ conversation_id: convSchema, lease: leaseSchema, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["conversation_id", "lease"]),
    run: (ctx, a) => {
      const id = conv(a)!;
      const l = lease(a);
      const lim = a.limit;
      if (lim !== undefined && (typeof lim !== "number" || !Number.isInteger(lim) || lim < 1 || lim > 50)) throw new InvalidParams("limit must be an integer 1..50");
      return getHistory(ctx, id, l, (lim as number | undefined) ?? 20);
    },
  },
  {
    name: "send_reply",
    description:
      "Send a reply to the customer of this conversation (recipient is fixed by the server; there is no 'to'). Provide text OR template_name. All safety guards are enforced server-side.",
    inputSchema: obj(
      {
        conversation_id: convSchema,
        lease: leaseSchema,
        text: { type: "string", maxLength: 4000 },
        template_name: { type: "string", maxLength: 100 },
        template_language: { type: "string", maxLength: 20 },
        template_params: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
        idempotency_key: { type: "string", maxLength: 100 },
      },
      ["conversation_id", "lease"],
    ),
    run: (ctx, a) => {
      const tp = a.template_params;
      if (tp !== undefined && (!Array.isArray(tp) || tp.length > 20 || tp.some((x) => typeof x !== "string" || x.length > 1000))) throw new InvalidParams("template_params must be up to 20 strings of at most 1000 characters");
      return sendReply(ctx, {
        conversation_id: conv(a)!,
        lease: lease(a),
        text: str(a, "text", { max: 4000 }),
        template_name: str(a, "template_name", { max: 100 }),
        template_language: str(a, "template_language", { max: 20 }),
        template_params: tp as string[] | undefined,
        idempotency_key: str(a, "idempotency_key", { max: 100 }),
      });
    },
  },
  {
    name: "finish_conversation",
    description: "Mark the conversation handled. Returns state replied, or pending if the customer wrote something unseen.",
    inputSchema: obj({ conversation_id: convSchema, lease: leaseSchema }, ["conversation_id", "lease"]),
    run: (ctx, a) => finishConversation(ctx, conv(a)!, lease(a)),
  },
  {
    name: "release_conversation",
    description: "Give the conversation back to the queue without finishing.",
    inputSchema: obj({ conversation_id: convSchema, lease: leaseSchema }, ["conversation_id", "lease"]),
    run: (ctx, a) => releaseConversation(ctx, conv(a)!, lease(a)),
  },
  {
    name: "escalate_conversation",
    description: "Hand the conversation to a human with a reason (max 500 chars).",
    inputSchema: obj({ conversation_id: convSchema, lease: leaseSchema, reason: { type: "string", minLength: 1, maxLength: 500 } }, ["conversation_id", "lease", "reason"]),
    run: (ctx, a) => escalateConversation(ctx, conv(a)!, lease(a), str(a, "reason", { min: 1, max: 500, required: true })!),
  },
  {
    name: "get_controls",
    description: "Read global controls (auto_reply, launch_mode) and optionally one conversation's flags. Read-only.",
    inputSchema: obj({ conversation_id: convSchema }, []),
    run: (ctx, a) => getControls(ctx, conv(a, false)),
  },
  {
    name: "get_overview",
    description:
      "Read-only health overview: conversation counts by state (pending, claimed, replied, held_for_review, escalated, human_takeover), oldest pending age, failed wake count, " +
      "controls (launch_mode, auto_reply), and which credential NAMES are present and from where. No message text, phone numbers or secret values. Cannot change anything.",
    inputSchema: obj({}, []),
    run: async (ctx, _a, host) => getOverview(ctx, host.secretsInfo ? await host.secretsInfo().catch(() => null) : null),
  },
];

/** Build the /mcp route handler. ctx is resolved lazily per call so env/store are read at request time. */
export function createMcpRoute(getCtx: () => Ctx, host: McpHost = {}) {
  return async (req: Request): Promise<Response> => {
    if (!tokenOk(bearerOf(req), getCtx().cfg.mcpToken)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mcp"' } });
    }
    return serveJsonRpc(req, { serverName: "wab-bot", serverVersion: pkg.version, tools: TOOLS, call: async (tool, args) => scrub(getCtx(), await tool.run(getCtx(), args, host)) });
  };
}
