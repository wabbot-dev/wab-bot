// Counts state-store operations for one typical customer exchange, against the in-memory FakeDoc (no network).
// Counted at the DocBackend boundary: every read() and every conditional write() is one Durable Object request on Cloudflare.
// Run: npx tsx scripts/measure-ops.ts      (the same function backs tests/ops.test.ts)
import { claimConversation, finishConversation, getControls, getHistory, listPending, sendReply } from "../lib/tools";
import { adminGet } from "../lib/admin";
import { activate, adminReq, cid, inboundPayload, makeHarness, post, statusPayload } from "../tests/helpers";

export interface StepOps { writes: number; reads: number }

export async function measure(opts: { replies?: number } = {}) {
  const replies = opts.replies ?? 1;
  const h = makeHarness();
  await activate(h); // setup, not part of an exchange
  const steps: Record<string, StepOps> = {};
  const step = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    h.doc.resetOps();
    const r = await f();
    const o = h.doc.ops;
    steps[name] = { writes: o.write, reads: o.read };
    return r;
  };
  await step("inbound webhook", () => post(h, inboundPayload({ wamid: "wamid.IN1" })));
  await step("debounced wake + retry pass", () => h.flush());
  await step("list_pending", () => listPending(h.ctx));
  const c: any = await step("claim_conversation", () => claimConversation(h.ctx, cid()));
  await step("get_history", () => getHistory(h.ctx, cid(), c.lease));
  for (let i = 0; i < replies; i++) {
    const r: any = await step(`send_reply #${i + 1}`, () => sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: `answer ${i}` }));
    for (const s of ["sent", "delivered", "read"]) {
      await step(`status ${s} #${i + 1}`, () => post(h, statusPayload({ wamid: `wamid.OUT${i + 1}`, status: s, rk: r.reply_key })));
    }
  }
  await step("finish_conversation", () => finishConversation(h.ctx, cid(), c.lease));
  await step("admin overview", async () => (await adminGet(h.ctx, adminReq("GET"))).json());
  await step("get_controls", () => getControls(h.ctx));
  const exchange = { writes: 0, reads: 0 };
  for (const [k, v] of Object.entries(steps)) {
    if (k === "admin overview" || k === "get_controls") continue; // not part of the customer exchange
    exchange.writes += v.writes; exchange.reads += v.reads;
  }
  return { steps, exchange };
}

async function main() {
  for (const replies of [1, 2]) {
    const m = await measure({ replies });
    console.log(`\n== exchange with ${replies} repl${replies === 1 ? "y" : "ies"} ==`);
    console.table(m.steps);
    const ex = m.exchange;
    // Each read/write is one Durable Object request (free plan: 100,000 requests/day, see docs/CLOUDFLARE.md).
    console.log("EXCHANGE:", ex, `=> ~${Math.floor(100000 / (ex.reads + ex.writes))} such exchanges/day by Durable Object requests (store ops only; the Worker's own request is separate)`);
  }
}
if (process.argv[1]?.endsWith("measure-ops.ts")) void main();
