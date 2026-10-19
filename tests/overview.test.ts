// get_overview: read-only health snapshot. Counts, ages, names and booleans only; never content, numbers, leases or secret values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpRoute } from "../lib/mcp";
import { getOverview, type SecretsInfo } from "../lib/overview";
import { MANAGED_KEYS, SECRET_KEYS } from "../lib/secrets";
import { update } from "../lib/store";
import { claimConversation } from "../lib/tools";
import type { Conv } from "../lib/types";
import {
  ADMIN_TOKEN, APP_SECRET, MCP_TOKEN, VERIFY_TOKEN, WAKE_KEY, WAKE_URL, WA, WA2, activate, cid, inboundPayload, makeHarness, post, type Harness,
} from "./helpers";

const WA3 = "15550000003";
const WA4 = "15550000004";
const WA5 = "15550000005";
const WA6 = "15550000006";

const mutate = (h: Harness, wa: string, f: (c: Conv) => void) =>
  update<Conv, null>(h.ctx, `conv/${cid(wa)}`, (c) => { if (!c) throw new Error("conv missing"); f(c); return { next: c, result: null }; });

const info = (over: Record<string, "env" | "stored" | "unset"> = {}): SecretsInfo => ({
  setup_locked: true,
  setup_nonce_present: false,
  names: Object.fromEntries(MANAGED_KEYS.map((k) => [k, {
    source: over[k] ?? "env",
    kind: (SECRET_KEYS as readonly string[]).includes(k) ? "secret" as const : "setting" as const,
  }])),
});

test("overview on an empty store: zero counts, null ages, fail-safe controls", async () => {
  const h = makeHarness({ LAUNCH_MODE: "" });
  const o: any = await getOverview(h.ctx, null);
  assert.equal(o.read_only, true);
  assert.equal(o.conversations.total, 0);
  assert.deepEqual(o.conversations.by_state, { pending: 0, claimed: 0, replied: 0, held_for_review: 0, escalated: 0, human_takeover: 0 });
  assert.equal(o.conversations.oldest_pending_age_seconds, null);
  assert.equal(o.conversations.oldest_pending_conversation_id, null);
  assert.equal(o.conversations.last_inbound_at, null);
  assert.equal(o.wake.failed_count, 0);
  assert.equal(o.controls.launch_mode, "test", "anything but live is test");
  assert.equal(o.controls.auto_reply, "paused", "never written = paused");
  assert.equal(o.secrets, null);
});

test("overview counts every state, oldest pending age, failed wakes and controls", async () => {
  const h = makeHarness({ TEST_RECIPIENTS: "+1 555 000 0001, 15550000002", WA_TEMPLATE_ALLOWLIST: "hello_a,hello_b,hello_c" });
  await activate(h);
  // six customers write; the first message of WA is the oldest
  const customers = [WA, WA2, WA3, WA4, WA5, WA6];
  for (const [i, wa] of customers.entries()) {
    await post(h, inboundPayload({ wamid: `wamid.OV${i}`, from: wa, text: `private text ${i}`, name: `Hidden Name ${i}`, tsMs: h.clock.now() }));
    h.clock.advance(60_000);
  }
  await h.flush();
  // WA stays pending (oldest), WA2 -> escalated, WA3 -> held, WA4 -> takeover, WA5 -> replied, WA6 -> claimed (live lease)
  await mutate(h, WA2, (c) => { c.state = "escalated"; c.escalation = { reason: "refund dispute", at: h.clock.now() }; });
  await mutate(h, WA3, (c) => { c.state = "held_for_review"; c.hold = { reason: "price promise", at: h.clock.now() }; });
  await mutate(h, WA4, (c) => { c.state = "human_takeover"; });
  await mutate(h, WA5, (c) => { c.state = "replied"; c.unhandled = 0; });
  const claim: any = await claimConversation(h.ctx, cid(WA6));
  assert.equal(claim.ok, true);
  // two failed wakes, one of them on a pending conversation
  await mutate(h, WA, (c) => { c.wake.status = "failed"; c.wake.attempts = 3; c.wake.nextRetryAt = h.clock.now() + 120_000; });
  await mutate(h, WA2, (c) => { c.wake.status = "failed"; c.wake.attempts = 1; c.wake.nextRetryAt = h.clock.now() + 60_000; });

  h.clock.advance(2 * 60_000); // inside the 5 min lease
  const o: any = await getOverview(h.ctx, null);
  assert.equal(o.conversations.total, 6);
  assert.deepEqual(o.conversations.by_state, { pending: 1, claimed: 1, replied: 1, held_for_review: 1, escalated: 1, human_takeover: 1 });
  assert.equal(o.conversations.pending, 1);
  assert.equal(o.conversations.held_for_review, 1);
  assert.equal(o.conversations.escalated, 1);
  assert.equal(o.conversations.human_takeover, 1);
  // WA wrote at T0; now = T0 + 6 min (writes) + 2 min = 8 min
  assert.equal(o.conversations.oldest_pending_age_seconds, 8 * 60);
  assert.equal(o.conversations.oldest_pending_conversation_id, cid(WA));
  assert.equal(o.conversations.last_inbound_at, new Date(h.clock.now() - 2 * 60_000 - 60_000).toISOString());
  assert.equal(o.wake.failed_count, 2);
  assert.equal(o.wake.earliest_next_retry_at, new Date(h.clock.now() - 2 * 60_000 + 60_000).toISOString());
  assert.equal(o.wake.url_configured, true);
  assert.equal(o.wake.key_present, true);
  assert.equal(o.wake.auth_mode, "bearer");
  assert.equal(o.controls.launch_mode, "live");
  assert.equal(o.controls.auto_reply, "active");
  assert.equal(o.controls.test_recipients_count, 2);
  assert.equal(o.controls.template_allowlist_count, 3);
  assert.equal(o.controls.meta_setup_enabled, false);
});

test("an expired lease counts as pending (same lazy rule as list_pending)", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.EX1" }));
  await h.flush();
  const claim: any = await claimConversation(h.ctx, cid());
  assert.equal(claim.ok, true);
  assert.equal(((await getOverview(h.ctx, null)) as any).conversations.by_state.claimed, 1);
  h.clock.advance(h.ctx.cfg.leaseMs + 1000);
  const o: any = await getOverview(h.ctx, null);
  assert.equal(o.conversations.by_state.claimed, 0);
  assert.equal(o.conversations.pending, 1);
  assert.ok(o.conversations.oldest_pending_age_seconds >= h.ctx.cfg.leaseMs / 1000);
});

test("overview is read-only: 1 read, 0 writes, store unchanged, arguments cannot change anything", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.RO1" }));
  await h.flush();
  const before = JSON.stringify(await h.store.get(`conv/${cid()}`));
  const ctlBefore = JSON.stringify(await h.store.get("ctl/controls"));
  h.doc.resetOps();
  await getOverview(h.ctx, info());
  assert.equal(h.doc.ops.write, 0);
  assert.equal(h.doc.ops.read, 1);
  assert.equal(JSON.stringify(await h.store.get(`conv/${cid()}`)), before);
  assert.equal(JSON.stringify(await h.store.get("ctl/controls")), ctlBefore);
});

test("overview never contains message text, names, numbers, leases or secret values", async () => {
  const h = makeHarness({ TEST_RECIPIENTS: WA, WAKE_HEADER: "X-Wake-Key" });
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.LK1", text: "my private symptoms", name: "Zed Hidden" }));
  await h.flush();
  const claim: any = await claimConversation(h.ctx, cid());
  const dump = JSON.stringify(await getOverview(h.ctx, info({ WAKE_KEY: "stored", CRON_SECRET: "unset" })));
  for (const forbidden of [
    "my private symptoms", "Zed Hidden", WA, claim.lease, "test-access-token", APP_SECRET, MCP_TOKEN, ADMIN_TOKEN, WAKE_KEY, VERIFY_TOKEN, WAKE_URL, "wake.example.test", "wamid.LK1", "X-Wake-Key",
  ]) assert.equal(dump.includes(forbidden), false, `overview leaked ${forbidden.slice(0, 10)}`);
  const o = JSON.parse(dump);
  assert.equal(o.wake.auth_mode, "custom_header");
});

test("secrets block lists NAMES and sources only, split into present and missing", async () => {
  const h = makeHarness();
  const o: any = await getOverview(h.ctx, info({ WAKE_KEY: "stored", CRON_SECRET: "unset", TEST_RECIPIENTS: "unset" }));
  assert.equal(o.secrets.setup_locked, true);
  assert.equal(o.secrets.names.WAKE_KEY.source, "stored");
  assert.equal(o.secrets.names.WA_ACCESS_TOKEN.kind, "secret");
  assert.equal(o.secrets.names.LAUNCH_MODE.kind, "setting");
  assert.deepEqual(o.secrets.missing, ["CRON_SECRET", "TEST_RECIPIENTS"]);
  assert.ok(o.secrets.present.includes("WAKE_KEY"));
  assert.ok(!o.secrets.present.includes("CRON_SECRET"));
  for (const v of Object.values<any>(o.secrets.names)) assert.deepEqual(Object.keys(v).sort(), ["kind", "source"]);
});

const rpcOver = (h: Harness, host = {}) => {
  const route = createMcpRoute(() => h.ctx, host);
  return (method: string, params: unknown, token: string | null = MCP_TOKEN) =>
    route(new Request("https://x.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
};

test("MCP: get_overview is listed read-only with no inputs, needs the MCP token (the admin token is refused), and is callable", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.MCP1" }));
  await h.flush();
  const rpc = rpcOver(h, { secretsInfo: async () => info({ WAKE_KEY: "unset" }) });
  assert.equal((await rpc("tools/call", { name: "get_overview", arguments: {} }, null)).status, 401);
  assert.equal((await rpc("tools/call", { name: "get_overview", arguments: {} }, ADMIN_TOKEN)).status, 401);
  const list: any = await (await rpc("tools/list", {})).json();
  const t = list.result.tools.find((x: any) => x.name === "get_overview");
  assert.ok(t);
  assert.deepEqual(t.inputSchema.properties, {});
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.match(t.description, /Read-only/);
  assert.match(t.description, /Cannot change anything/);
  const before = JSON.stringify(await h.store.get(`conv/${cid()}`));
  // extra arguments are ignored: nothing a caller passes can change state
  const res: any = await (await rpc("tools/call", { name: "get_overview", arguments: { auto_reply: "paused", action: "delete_conversation", conversation_id: cid() } })).json();
  const o = JSON.parse(res.result.content[0].text);
  assert.equal(o.conversations.pending, 1);
  assert.equal(o.controls.auto_reply, "active");
  assert.deepEqual(o.secrets.missing, ["WAKE_KEY"]);
  assert.equal(JSON.stringify(await h.store.get(`conv/${cid()}`)), before);
  assert.equal(((await h.store.get("ctl/controls"))!.value as any).autoReply, "active");
});

test("MCP: a failing secrets provider degrades to secrets:null, never an error", async () => {
  const h = makeHarness();
  const rpc = rpcOver(h, { secretsInfo: async () => { throw new Error("do down"); } });
  const res: any = await (await rpc("tools/call", { name: "get_overview", arguments: {} })).json();
  assert.equal(JSON.parse(res.result.content[0].text).secrets, null);
});

test("MCP: start_conversation and get_overview are the only tools added and none of the tools can change global controls", async () => {
  const h = makeHarness();
  const list: any = await (await rpcOver(h)("tools/list", {})).json();
  const names = list.result.tools.map((t: any) => t.name);
  assert.equal(names.length, 10);
  for (const n of names) assert.ok(!/set_|auto_reply|launch|takeover|delete/.test(n), n);
});
