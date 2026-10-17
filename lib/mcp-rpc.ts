import { redactShapes } from "./redact";
import { isStoreBusy } from "./store";

/**
 * Minimal stateless MCP server core over Streamable HTTP (JSON responses only: no SSE, no sessions), shared by the agent route
 * (`/mcp`, lib/mcp.ts) and the owner-only admin route (`/admin/mcp`, lib/admin-mcp.ts). Hand-written so the Worker pays no CPU
 * to build an SDK server and schema objects on every request (Cloudflare Free: 10 ms CPU/request) and keeps zero runtime
 * dependencies. Implements initialize, ping, tools/list and tools/call (+ ignores notifications) of the MCP spec.
 * Authentication is NOT done here: each route authenticates before it calls serveJsonRpc.
 */

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type Args = Record<string, unknown>;
export class InvalidParams extends Error {}

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, ...); advisory hints for clients */
  annotations?: Record<string, boolean>;
}

export interface RpcOptions<T extends ToolMeta> {
  serverName: string;
  serverVersion: string;
  tools: T[];
  /** run one tool; throw InvalidParams for bad arguments */
  call(tool: T, args: Args): Promise<unknown>;
  /** most JSON-RPC messages accepted in one POST (default 20) */
  maxBatch?: number;
  /** longest request body accepted, in characters (default: unlimited) */
  maxBodyChars?: number;
  /** extra response headers (for example Cache-Control) */
  headers?: Record<string, string>;
}

/** Always answer with ONE JSON text block: a store conflict that outlasted its retry budget is a structured, retryable result (nothing was applied), never an opaque tool error. */
export const STORE_BUSY = { ok: false, error: "store_busy", retryable: true, hint: "Another writer kept winning for ~8 s. Nothing was changed. Call the same tool again." };
export const asText = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export interface RpcMsg { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }
export const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: redactShapes(message) } });
export const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

async function handleOne<T extends ToolMeta>(o: RpcOptions<T>, byName: Map<string, T>, m: RpcMsg): Promise<unknown | null> {
  if (!m || typeof m !== "object" || typeof m.method !== "string") return m && "id" in m && m.id !== undefined ? rpcError(m.id, -32600, "Invalid Request") : null; // stray response: ignore
  if (m.id === undefined) return null; // notification
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return rpcOk(m.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: o.serverName, version: o.serverVersion },
      });
    }
    case "ping":
      return rpcOk(m.id, {});
    case "tools/list":
      return rpcOk(m.id, { tools: o.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case "tools/call": {
      const tool = typeof m.params?.name === "string" ? byName.get(m.params.name) : undefined;
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${String(m.params?.name).slice(0, 60)}`);
      const args = m.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcError(m.id, -32602, "arguments must be an object");
      try {
        return rpcOk(m.id, asText(await o.call(tool, args as Args)));
      } catch (e) {
        if (e instanceof InvalidParams) return rpcError(m.id, -32602, `Invalid arguments for ${tool.name}: ${e.message}`);
        if (isStoreBusy(e)) return rpcOk(m.id, asText(STORE_BUSY));
        throw e;
      }
    }
    default:
      return rpcError(m.id, -32601, "Method not found");
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Serve one Streamable HTTP request (POST only). The caller has already authenticated it. */
export async function serveJsonRpc<T extends ToolMeta>(req: Request, o: RpcOptions<T>): Promise<Response> {
  const headers = { ...JSON_HEADERS, ...(o.headers ?? {}) };
  if (req.method !== "POST") {
    return new Response(JSON.stringify(rpcError(null, -32000, "Method not allowed (stateless server: POST only).")), { status: 405, headers: { ...headers, Allow: "POST" } });
  }
  let body: unknown;
  try {
    const text = await req.text();
    if (o.maxBodyChars !== undefined && text.length > o.maxBodyChars) return new Response(JSON.stringify(rpcError(null, -32600, "Request too large")), { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcMsg[];
  if (msgs.length === 0 || msgs.length > (o.maxBatch ?? 20)) return new Response(JSON.stringify(rpcError(null, -32600, "Invalid Request")), { status: 400, headers });
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const out: unknown[] = [];
  for (const m of msgs) {
    try {
      const r = await handleOne(o, byName, m);
      if (r !== null) out.push(r);
    } catch {
      out.push(rpcError(m?.id, -32603, "Internal error"));
    }
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: o.headers }); // only notifications / responses
  return new Response(JSON.stringify(batch ? out : out[0]), { status: 200, headers });
}
