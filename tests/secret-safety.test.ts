// Secret safety: no tool result, log line or error path may carry a secret-shaped value. Every secret below is FAKE and built at run
// time from parts, so no key-shaped literal exists in the repository (the hygiene scan fails on those).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_TOOLS, createAdminMcpRoute } from "../lib/admin-mcp";
import { consoleLog } from "../lib/log";
import { createMcpRoute } from "../lib/mcp";
import { MemoryRateLimiter } from "../lib/rate-limit";
import { redactShapes, scrubText } from "../lib/redact";
import { baseEnv, makeHarness } from "./helpers";

const rep = (c: string, n: number) => c.repeat(n);
const FAKE = {
  xai: ["xai", "-", rep("a1B2", 12)].join(""),
  sk: ["sk", "-", rep("Zy9x", 12)].join(""),
  proj: ["sk", "-proj-", rep("Qw7e", 12)].join(""),
  whsec: ["whsec", "_", rep("Ab3d", 10)].join(""),
  gh: ["gh", "p_", rep("k9Lm", 10)].join(""),
  meta: ["E", "AAB", rep("x7Y2", 12)].join(""),
  bearer: rep("tok", 12) + "._-9",
  jwt: ["eyJ", rep("a", 12), ".eyJ", rep("b", 12), ".", rep("c", 12)].join(""),
};
const { bearer: _b, ...KEYS } = FAKE; // a bare token has no shape of its own; it is only recognisable after "Bearer "
const SHAPED = Object.values(KEYS);
const ADMIN = rep("adminmcp", 5);

const leaks = (text: string) => SHAPED.filter((s) => text.includes(s)).concat(text.includes(FAKE.bearer) ? [FAKE.bearer] : []);

test("redactShapes: every key-shaped value is removed, ordinary text is untouched", () => {
  for (const [k, v] of Object.entries(FAKE)) {
    const out = redactShapes(`before ${k === "bearer" ? "Bearer " : ""}${v} after`);
    assert.ok(!out.includes(v), `${k} survived`);
    assert.match(out, /^before .* after$/);
  }
  const plain = "table for 4 at 7:30, task-force desk-reservation, sketch-pad-notes-for-the-team";
  assert.equal(redactShapes(plain), plain);
  assert.equal(scrubText(`x ${"known-secret-value-1"} y`, ["known-secret-value-1"]), "x [REDACTED] y");
});

test("logs: a key-shaped value in a log field never reaches the console", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    for (const v of SHAPED) consoleLog("probe", { detail: v, other: `x ${v}` });
    consoleLog("probe", { detail: "Bearer " + FAKE.bearer });
  } finally { console.log = orig; }
  assert.equal(lines.length, SHAPED.length + 1);
  assert.deepEqual(leaks(lines.join("\n")), []);
});

function rigs() {
  const h = makeHarness(baseEnv({ ADMIN_MCP_TOKEN: ADMIN, XAI_API_KEY: FAKE.xai, WA_ACCESS_TOKEN: FAKE.meta, WA_APP_SECRET: FAKE.whsec, CRON_SECRET: FAKE.sk }));
  const host = { memory: new MemoryRateLimiter(), calling: { setDeadman: async () => {} } };
  const admin = createAdminMcpRoute(() => h.ctx, host);
  const agent = createMcpRoute(() => h.ctx, {});
  const rpc = async (route: (r: Request) => Promise<Response>, token: string, method: string, params: unknown) => {
    const res = await route(new Request("https://bridge.example.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    return res.text();
  };
  return { h, admin, agent, rpc };
}

test("admin MCP: no tool result or error contains a secret-shaped value, even when a tool is made to echo one", async () => {
  const r = rigs();
  r.h.ctx.fetch = async () => new Response(JSON.stringify({ error: { message: `bad token ${FAKE.meta} key ${FAKE.xai}` } }), { status: 400 });
  const out: string[] = [];
  for (const t of ADMIN_TOOLS) {
    if (["get_conversation", "erase_conversation", "erase_call_log", "arm_calling"].includes(t.name)) continue;
    const args = t.name === "get_call_log" ? { call_id: "cl_" + "0".repeat(20) } : {};
    out.push(await r.rpc(r.admin, ADMIN, "tools/call", { name: t.name, arguments: args }));
  }
  // error paths that echo caller input
  out.push(await r.rpc(r.admin, ADMIN, "tools/call", { name: FAKE.xai, arguments: {} }));
  out.push(await r.rpc(r.admin, ADMIN, "tools/call", { name: "get_call_log", arguments: { call_id: FAKE.sk } }));
  // a tool that returns secret-shaped values by mistake is scrubbed on the way out
  const leaky = { name: "leaky", description: "test only", spec: {}, inputSchema: { type: "object" }, run: async () => ({ a: SHAPED, b: `Bearer ${FAKE.bearer}`, c: `${FAKE.xai}` }) };
  (ADMIN_TOOLS as any[]).push(leaky);
  try { out.push(await r.rpc(r.admin, ADMIN, "tools/call", { name: "leaky", arguments: {} })); } finally { (ADMIN_TOOLS as any[]).pop(); }
  const all = out.join("\n");
  assert.deepEqual(leaks(all), []);
  assert.ok(!all.includes(ADMIN), "the admin MCP secret is never returned");
  assert.match(all, /REDACTED/);
  assert.deepEqual(leaks(JSON.stringify(r.h.logs)), [], "log lines carry no key-shaped value");
  assert.ok(!JSON.stringify(r.h.logs).includes(ADMIN));
});

test("agent MCP: tool results and errors carry no secret-shaped value", async () => {
  const r = rigs();
  const token = r.h.ctx.cfg.mcpToken!;
  const out: string[] = [];
  out.push(await r.rpc(r.agent, token, "tools/call", { name: "get_overview", arguments: {} }));
  out.push(await r.rpc(r.agent, token, "tools/call", { name: "get_controls", arguments: {} }));
  out.push(await r.rpc(r.agent, token, "tools/call", { name: "list_pending", arguments: {} }));
  out.push(await r.rpc(r.agent, token, "tools/call", { name: FAKE.xai, arguments: {} }));
  out.push(await r.rpc(r.agent, token, "tools/call", { name: "get_history", arguments: { conversation_id: FAKE.sk } }));
  const all = out.join("\n");
  assert.deepEqual(leaks(all), []);
  assert.ok(!all.includes(token), "the agent MCP token is never returned");
  assert.ok(out.every((o) => o.length > 0));
});
