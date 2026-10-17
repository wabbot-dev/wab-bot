import { signBody } from "../lib/crypto";
import { loadConfig, type Env } from "../lib/config";
import type { Ctx } from "../lib/ctx";
import { newVolatileState } from "../lib/ctx";
import { convId } from "../lib/conv";
import { FakeDoc } from "../lib/fake-doc";
import { makeStore } from "../lib/make-store";
import { setAutoReply } from "../lib/controls";
import type { Store } from "../lib/store";
import { handleWebhookPost } from "../lib/webhook";
import { claimConversation, getHistory } from "../lib/tools";
import type { Conv } from "../lib/types";

// All values below are fake, test-only strings.
export const PN = "1000000000001";
export const WABA = "2000000000002";
export const OWN = "15551000000";
export const WA = "15550000001";
export const WA2 = "15550000002";
export const APP_SECRET = "test-app-secret-0000001";
export const WAKE_URL = "https://wake.example.test/hook";
export const WAKE_KEY = "test-wake-key-00000001";
export const MCP_TOKEN = "test-mcp-token-0000001";
export const ADMIN_TOKEN = "test-admin-token-00001";
export const CRON_SECRET = "test-cron-secret-00001";
export const VERIFY_TOKEN = "test-verify-token-0001";

export const T0 = Date.parse("2026-10-15T10:00:00.000Z");

export class FakeClock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

export interface Call { url: string; method: string; headers: Record<string, string>; body: any; }

export class FakeNet {
  calls: Call[] = [];
  graphStatus = 200;
  graphThrows = false;
  graphMissingWamid = false;
  wakeStatus = 200;
  wakeThrows = false;
  private n = 0;
  fetch: typeof fetch;
  constructor() {
    this.fetch = async (input, init) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.calls.push({ url, method: init?.method ?? "GET", headers, body });
      if (url.startsWith("https://graph.facebook.com/")) {
        if (this.graphThrows) throw new Error("network down");
        if (this.graphStatus >= 200 && this.graphStatus < 300) {
          return Response.json(this.graphMissingWamid ? {} : { messages: [{ id: `wamid.OUT${++this.n}` }] }, { status: this.graphStatus });
        }
        return Response.json({ error: { code: this.graphStatus === 401 ? 190 : 100, message: "x" } }, { status: this.graphStatus });
      }
      if (url === WAKE_URL) {
        if (this.wakeThrows) throw new Error("network down");
        return new Response("{}", { status: this.wakeStatus });
      }
      throw new Error("unexpected network call " + url);
    };
  }
  get graph() { return this.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/")); }
  get wakes() { return this.calls.filter((c) => c.url === WAKE_URL); }
}

export function baseEnv(over: Env = {}): Env {
  return {
    LAUNCH_MODE: "live",
    WA_ACCESS_TOKEN: "test-access-token-0000001",
    WA_APP_SECRET: APP_SECRET,
    WA_VERIFY_TOKEN: VERIFY_TOKEN,
    WA_PHONE_NUMBER_IDS: PN,
    WAKE_URL,
    WAKE_KEY,
    MCP_TOKEN,
    ADMIN_TOKEN,
    CRON_SECRET,
    ...over,
  };
}

export interface Harness {
  ctx: Ctx;
  clock: FakeClock;
  net: FakeNet;
  store: Store;
  /** the in-memory DocBackend under the store: counts reads and conditional writes */
  doc: FakeDoc;
  logs: { event: string; fields?: Record<string, unknown> }[];
  /** queued wake tasks (what the debounce armed) */
  queue: (() => Promise<void>)[];
  /** queued maintenance tasks (opportunistic retry pass) */
  bg: (() => Promise<void>)[];
  flush(): Promise<void>;
}

export function makeHarness(over: Env = {}, opts: { doc?: FakeDoc } = {}): Harness {
  const clock = new FakeClock();
  const net = new FakeNet();
  const doc = opts.doc ?? new FakeDoc();
  const state = newVolatileState();
  const store = makeStore({ backend: doc, now: clock.now, state });
  const queue: (() => Promise<void>)[] = [];
  const bg: (() => Promise<void>)[] = [];
  const logs: Harness["logs"] = [];
  const ctx: Ctx = {
    cfg: loadConfig(baseEnv(over)),
    store,
    now: clock.now,
    fetch: net.fetch,
    sleep: async (ms) => { clock.advance(ms); },
    rand: () => 0.5,
    schedule: (task, label) => { (label === "maintenance" ? bg : queue).push(task); },
    log: (event, fields) => { logs.push({ event, fields }); },
    state,
  };
  return {
    ctx, clock, net, store, doc, logs, queue, bg,
    async flush() { while (queue.length || bg.length) await (queue.length ? queue : bg).shift()!(); },
  };
}

export const activate = (h: Harness) => setAutoReply(h.ctx, "active");

export function inboundPayload(opts: {
  wamid: string; text?: string; from?: string; type?: string; tsMs?: number; name?: string;
  pn?: string; display?: string; extra?: Record<string, unknown>;
}) {
  const type = opts.type ?? "text";
  const msg: Record<string, unknown> = {
    id: opts.wamid, from: opts.from ?? WA, type,
    timestamp: String(Math.floor((opts.tsMs ?? T0) / 1000)),
    ...(type === "text" ? { text: { body: opts.text ?? "hello" } } : {}),
    ...(opts.extra ?? {}),
  };
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: WABA,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: opts.display ?? OWN, phone_number_id: opts.pn ?? PN },
          contacts: [{ profile: { name: opts.name ?? "Test Customer" }, wa_id: opts.from ?? WA }],
          messages: [msg],
        },
      }],
    }],
  };
}

export function statusPayload(opts: { wamid: string; status: string; to?: string; rk?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: WABA,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: OWN, phone_number_id: PN },
          statuses: [{
            id: opts.wamid, status: opts.status, recipient_id: opts.to ?? WA,
            timestamp: String(Math.floor(T0 / 1000)),
            ...(opts.rk ? { biz_opaque_callback_data: `rk:${opts.rk}` } : {}),
          }],
        },
      }],
    }],
  };
}

export function signedRequest(payload: unknown, secret = APP_SECRET, raw?: string): Request {
  const body = raw ?? JSON.stringify(payload);
  return new Request("https://bridge.example.test/api/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody(body, secret) },
    body,
  });
}

export async function post(h: Harness, payload: unknown) {
  return handleWebhookPost(h.ctx, signedRequest(payload));
}

export const cid = (wa = WA) => convId(PN, WABA, wa);

export async function getConv(h: Harness, wa = WA): Promise<Conv> {
  const r = await h.store.get<Conv>(`conv/${cid(wa)}`);
  if (!r) throw new Error("conv missing");
  return r.value;
}

/** claim + read history; returns lease */
export async function claimAndRead(h: Harness, wa = WA): Promise<string> {
  const c: any = await claimConversation(h.ctx, cid(wa));
  if (!c.ok) throw new Error("claim failed " + JSON.stringify(c));
  await getHistory(h.ctx, cid(wa), c.lease);
  return c.lease;
}

export function adminReq(method: string, body?: unknown, token = ADMIN_TOKEN, query = ""): Request {
  return new Request("https://bridge.example.test/api/admin" + query, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
