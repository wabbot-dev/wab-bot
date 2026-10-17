import { META_AS32934_V4, splitTo16 } from "./meta-prefixes";
import { deleteNumber, findNumbers, registerNumber } from "./xai-voice";

/**
 * The Meta Graph and xAI REST calls that switch voice calling on and off. Pure over an injected fetch; used by the arm/disarm tools
 * (lib/calls-arm.ts) and by the Durable Object dead-man alarm (src/state-do.ts), which has no request context.
 * Credentials are used for Authorization headers only. Results carry HTTP statuses and booleans, never a credential or a response body.
 */
export interface Remote {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  graphVersion: string;
  accessToken: string;
  xaiKey: string;
}

const graph = (r: Remote, path: string) => `https://graph.facebook.com/${r.graphVersion}/${path}`;
const gh = (r: Remote) => ({ Authorization: `Bearer ${r.accessToken}`, "Content-Type": "application/json" });

export const SIP_HOST = "sip.voice.x.ai";
export const SIP_PORT = 5061;

export interface MetaCalling {
  ok: boolean;
  status: number;
  calling?: string;
  sip?: string;
  srtp?: string;
  codecs: string[];
  /** Meta's per-number SIP digest password: kept in memory for one call to xAI, never logged or returned */
  sipPassword?: string;
}

export async function readMetaCalling(r: Remote, pnid: string): Promise<MetaCalling> {
  const res = await r.fetch(graph(r, `${pnid}/settings?include_sip_credentials=true`), { headers: gh(r) });
  if (!res.ok) return { ok: false, status: res.status, codecs: [] };
  const j = (await res.json().catch(() => ({}))) as {
    calling?: { status?: string; srtp_key_exchange_protocol?: string; audio?: { additional_codecs?: string[] }; sip?: { status?: string; servers?: { sip_user_password?: string }[] } };
  };
  const c = j.calling ?? {};
  return {
    ok: true,
    status: res.status,
    calling: c.status,
    sip: c.sip?.status,
    srtp: c.srtp_key_exchange_protocol,
    codecs: Array.isArray(c.audio?.additional_codecs) ? c.audio!.additional_codecs! : [],
    sipPassword: c.sip?.servers?.find((s) => s.sip_user_password)?.sip_user_password,
  };
}

/** digits of the number's display_phone_number */
export async function readDisplayNumber(r: Remote, pnid: string): Promise<{ ok: boolean; status: number; digits?: string }> {
  const res = await r.fetch(graph(r, `${pnid}?fields=display_phone_number`), { headers: gh(r) });
  if (!res.ok) return { ok: false, status: res.status };
  const j = (await res.json().catch(() => ({}))) as { display_phone_number?: string };
  const digits = (j.display_phone_number ?? "").replace(/\D/g, "");
  return digits ? { ok: true, status: res.status, digits } : { ok: false, status: res.status };
}

/** Meta calling ON over SIP: SDES + G.711 (what the live-proven setup used), pointing at xAI's SIP endpoint. `sipWebhooks` (CALL_SIP_WEBHOOKS=1, test aid) asks Meta for call_created / terminate webhooks. */
export async function enableMetaSip(r: Remote, pnid: string, opts: { sipWebhooks?: boolean } = {}): Promise<{ ok: boolean; status: number }> {
  const res = await r.fetch(graph(r, `${pnid}/settings`), {
    method: "POST",
    headers: gh(r),
    body: JSON.stringify({
      calling: {
        status: "ENABLED",
        srtp_key_exchange_protocol: "SDES",
        call_icon_visibility: "DEFAULT",
        audio: { additional_codecs: ["PCMA", "PCMU"] },
        sip: { status: "ENABLED", webhook_delivery: opts.sipWebhooks ? "ENABLED" : "DISABLED", servers: [{ hostname: SIP_HOST, port: SIP_PORT }] },
      },
    }),
  });
  return { ok: res.ok, status: res.status };
}

/** Meta calling OFF (calling AND sip), restoring the SRTP mode and codecs that were set before arming. Three tries. */
export async function disableMetaSip(r: Remote, pnid: string, prior?: { srtp?: string; codecs?: string[] }): Promise<{ ok: boolean; status: number }> {
  const calling: Record<string, unknown> = { status: "DISABLED", sip: { status: "DISABLED", webhook_delivery: "DISABLED" } };
  if (prior?.srtp) calling.srtp_key_exchange_protocol = prior.srtp;
  if (prior?.codecs) calling.audio = { additional_codecs: prior.codecs };
  let status = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await r.fetch(graph(r, `${pnid}/settings`), { method: "POST", headers: gh(r), body: JSON.stringify({ calling }) });
      status = res.status;
      if (res.ok) return { ok: true, status };
    } catch { status = 0; }
    if (i < 2) await r.sleep(1500);
  }
  return { ok: false, status };
}

export interface ArmedRemote {
  pnid: string;
  xaiPhoneId?: string;
  prior?: { srtp?: string; codecs?: string[] };
}

export interface DisarmReport {
  meta: "disabled" | "failed" | "skipped";
  meta_status: number | null;
  xai: "deleted" | "failed" | "skipped";
  xai_status: number | null;
}

/** Undo everything arming did. Best effort and idempotent: each half is attempted even if the other fails. */
export async function disarmRemote(r: Remote, a: ArmedRemote): Promise<DisarmReport> {
  const out: DisarmReport = { meta: "skipped", meta_status: null, xai: "skipped", xai_status: null };
  try {
    const m = await disableMetaSip(r, a.pnid, a.prior);
    out.meta = m.ok ? "disabled" : "failed";
    out.meta_status = m.status;
  } catch { out.meta = "failed"; }
  if (a.xaiPhoneId) {
    try {
      const d = await deleteNumber(r.fetch, r.xaiKey, a.xaiPhoneId);
      out.xai = d.ok ? "deleted" : "failed";
      out.xai_status = d.status;
    } catch { out.xai = "failed"; }
  }
  return out;
}

export interface ArmRemoteArgs {
  pnid: string;
  /** digits the owner approved (live) or null (test number: whatever Meta reports) */
  goNumber?: string;
  webhookUrl: string;
  label: string;
}

export type ArmRemoteResult =
  | { ok: true; number: string; xaiPhoneId: string; signingSecret: string; prior: { srtp?: string; codecs: string[] } }
  | { ok: false; step: string; status?: number; xaiPhoneId?: string; prior?: { srtp?: string; codecs: string[] } };

/**
 * Steps 1-3 of arming (read-only checks, then register the number at xAI). Meta calling is NOT switched on here: the caller stores the
 * signing secret first, then calls enableMetaSip. Refuses to touch a number whose calling or SIP is already enabled, or that is
 * already registered at xAI.
 */
export async function prepareArm(r: Remote, a: ArmRemoteArgs): Promise<ArmRemoteResult> {
  const num = await readDisplayNumber(r, a.pnid);
  if (!num.ok || !num.digits) return { ok: false, step: "read_number", status: num.status };
  if (a.goNumber && num.digits !== a.goNumber) return { ok: false, step: "number_not_approved_by_owner" };
  const st = await readMetaCalling(r, a.pnid);
  if (!st.ok) return { ok: false, step: "read_calling_settings", status: st.status };
  const off = (v?: string) => v === undefined || v === "DISABLED" || v === "NOT_SET";
  if (!off(st.calling) || !off(st.sip)) return { ok: false, step: "calling_already_enabled_on_number" };
  if (!st.sipPassword) return { ok: false, step: "no_sip_password" };
  const prior = { srtp: st.srtp, codecs: st.codecs };
  const e164 = "+" + num.digits;
  const have = await findNumbers(r.fetch, r.xaiKey, e164);
  if (!have.ok) return { ok: false, step: "xai_list_numbers", status: have.status, prior };
  if (have.ids.length) return { ok: false, step: "number_already_registered_at_xai", prior };
  const reg = await registerNumber(r.fetch, r.xaiKey, {
    number: e164,
    name: a.label,
    digestUser: num.digits,
    digestPassword: st.sipPassword,
    allowedAddresses: splitTo16(META_AS32934_V4),
    webhookUrl: a.webhookUrl,
  });
  if (!reg.ok || !reg.phoneId || !reg.signingSecret) return { ok: false, step: "xai_register", status: reg.status, prior };
  return { ok: true, number: num.digits, xaiPhoneId: reg.phoneId, signingSecret: reg.signingSecret, prior };
}
