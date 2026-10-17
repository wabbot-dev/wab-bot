/**
 * xAI Grok Voice REST + realtime helpers (the only voice provider this project supports). Every function takes the fetch to use,
 * so tests run with mocks and no network. The API key is passed in, used for the Authorization header only, and never logged or returned.
 * Shapes observed live on 2026-10-17 (docs/VOICE-CALLS.md has the dates and sources).
 */
export const XAI_BASE = "https://api.x.ai";
/** list price when read on 2026-10-17 (USD per minute of speech-to-speech): used for ESTIMATES only; your xAI console is the truth */
export const XAI_VOICE_USD_PER_MIN = 0.08;

export interface XaiResult { ok: boolean; status: number }

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
const jsonHeaders = (key: string) => ({ ...auth(key), "Content-Type": "application/json" });

export interface RegisterArgs {
  number: string; // E.164 with +
  name: string;
  digestUser: string;
  digestPassword: string;
  allowedAddresses: string[];
  webhookUrl: string;
}

/** POST /v2/phone-numbers (byo_trunk). The signing secret comes back ONCE: the caller must store it immediately. */
export async function registerNumber(f: typeof fetch, key: string, a: RegisterArgs): Promise<XaiResult & { phoneId?: string; signingSecret?: string }> {
  const r = await f(`${XAI_BASE}/v2/phone-numbers`, {
    method: "POST",
    headers: jsonHeaders(key),
    body: JSON.stringify({
      origin: "byo_trunk",
      name: a.name,
      phone_number: a.number,
      webhook: { url: a.webhookUrl },
      sip_auth: { auth_username: a.digestUser, auth_password: a.digestPassword, allowed_addresses: a.allowedAddresses },
    }),
  });
  if (!r.ok) return { ok: false, status: r.status };
  const j = (await r.json().catch(() => ({}))) as { phone_number?: { phone_number_id?: string }; webhook?: { dispatch_signing_secret?: string } };
  const phoneId = j.phone_number?.phone_number_id;
  const signingSecret = j.webhook?.dispatch_signing_secret;
  if (!phoneId || !signingSecret) return { ok: false, status: r.status };
  return { ok: true, status: r.status, phoneId, signingSecret };
}

/** ids of registered numbers equal to `number` (E.164) */
export async function findNumbers(f: typeof fetch, key: string, number: string): Promise<XaiResult & { ids: string[] }> {
  const r = await f(`${XAI_BASE}/v2/phone-numbers`, { headers: auth(key) });
  if (!r.ok) return { ok: false, status: r.status, ids: [] };
  const j = (await r.json().catch(() => ({}))) as { phone_numbers?: { phone_number_id?: string; phone_number?: string }[] };
  const ids = (j.phone_numbers ?? []).filter((p) => p.phone_number === number && p.phone_number_id).map((p) => p.phone_number_id as string);
  return { ok: true, status: r.status, ids };
}

/** DELETE /v2/phone-numbers/<id> (204). 404 counts as success: it is already gone. */
export async function deleteNumber(f: typeof fetch, key: string, id: string): Promise<XaiResult> {
  const r = await f(`${XAI_BASE}/v2/phone-numbers/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(key) });
  return { ok: r.ok || r.status === 404, status: r.status };
}

/** POST /v1/realtime/calls/<id>/hangup. 404 = xAI had already closed the call (harmless). */
export async function hangupCall(f: typeof fetch, key: string, callId: string): Promise<XaiResult & { alreadyClosed: boolean }> {
  const r = await f(`${XAI_BASE}/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: "POST", headers: auth(key) });
  return { ok: r.ok || r.status === 404, status: r.status, alreadyClosed: r.status === 404 };
}

/** The realtime socket of one SIP call. Joining needs the REAL API key (ephemeral tokens are not accepted for call_id sessions). */
export async function openCallSocket(f: typeof fetch, key: string, callId: string): Promise<WebSocket> {
  const r = await f(`${XAI_BASE}/v1/realtime?call_id=${encodeURIComponent(callId)}`, { headers: { Upgrade: "websocket", ...auth(key) } });
  const ws = (r as unknown as { webSocket?: WebSocket }).webSocket;
  if (!ws) throw new Error(`xai_upgrade_failed_${r.status}`);
  (ws as unknown as { accept(): void }).accept();
  return ws;
}
