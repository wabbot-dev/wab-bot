/**
 * Business mode (docs/BUSINESS-MODE.md): who the bot serves (consumers, businesses, both), a contact/account directory the OWNER
 * manages (keyed by WhatsApp number: account name, tags, terms, notes), the customer-detail and identity checks, a staff-verified
 * payment step, and a hook that passes bookings/orders/quote requests to the owner's own system.
 *
 * Trust: directory entries come from the owner (admin API / admin MCP), so get_history shows them as trusted metadata. A customer can
 * never create or change an entry, and nothing a customer writes is ever copied into the directory by the bridge.
 */
import type { Ctx } from "./ctx";
import { fetchTimeout } from "./ctx";
import { scheduleAlert } from "./alerts";
import { update } from "./store";
import type { Conv } from "./types";

type Json = Record<string, unknown>;

export const CONTACT_PREFIX = "contact/";
export const contactKey = (wa: string) => `${CONTACT_PREFIX}${wa}`;
export const MAX_CONTACTS = 5000;

export interface Contact {
  wa: string;
  /** the account (company / customer) name the owner entered */
  account?: string;
  /** the person's name at that account */
  person?: string;
  /** owner tags, lowercase, e.g. wholesale, vip, reseller, net30 */
  tags: string[];
  /** true = an existing business account (trade prices, account terms, private documents allowed after the identity check) */
  known_account: boolean;
  /** owner's short note for the agent: account terms, price list name, credit status. Never customer-written text. */
  terms?: string;
  notes?: string;
  updatedAt: number;
}

const clean = (v: unknown, n: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, n) : undefined;
};
const digits = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");
export const tagsOf = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(raw.map((x) => String(x).toLowerCase().replace(/[^a-z0-9_-]/g, "")).filter(Boolean))].slice(0, 12);
};

export async function getContact(ctx: Ctx, wa: string): Promise<Contact | null> {
  if (!/^\d{6,20}$/.test(wa)) return null;
  return (await ctx.store.get<Contact>(contactKey(wa)))?.value ?? null;
}

/** Owner: create or update one directory entry. Fields not given are kept. */
export async function upsertContact(ctx: Ctx, a: Json): Promise<Json> {
  const wa = digits(a.number);
  if (!/^\d{6,20}$/.test(wa)) return { ok: false, error: "invalid_number" };
  if (a.known_account !== undefined && typeof a.known_account !== "boolean") return { ok: false, error: "known_account_must_be_boolean" };
  const existing = await ctx.store.keys(CONTACT_PREFIX);
  if (!existing.includes(contactKey(wa)) && existing.length >= MAX_CONTACTS) return { ok: false, error: "directory_full" };
  const r = await update<Contact, Contact>(ctx, contactKey(wa), (cur) => {
    const next: Contact = {
      wa,
      account: a.account !== undefined ? clean(a.account, 100) : cur?.account,
      person: a.person !== undefined ? clean(a.person, 100) : cur?.person,
      tags: a.tags !== undefined ? tagsOf(a.tags) : cur?.tags ?? [],
      known_account: typeof a.known_account === "boolean" ? a.known_account : cur?.known_account ?? false,
      terms: a.terms !== undefined ? clean(a.terms, 300) : cur?.terms,
      notes: a.notes !== undefined ? clean(a.notes, 500) : cur?.notes,
      updatedAt: ctx.now(),
    };
    return { next, result: next };
  });
  ctx.log("directory", { action: "upsert", known: r.result.known_account, tags: r.result.tags.length });
  return { ok: true, contact: redactedContact(r.result) };
}

export async function deleteContact(ctx: Ctx, number: unknown): Promise<Json> {
  const wa = digits(number);
  if (!/^\d{6,20}$/.test(wa)) return { ok: false, error: "invalid_number" };
  const r = await update<Contact, boolean>(ctx, contactKey(wa), (cur) => ({ next: (cur ? null : undefined) as unknown as Contact | undefined, result: !!cur })); // an explicit null deletes the row
  ctx.log("directory", { action: "delete", existed: r.result });
  return { ok: true, deleted: r.result };
}

/** A directory entry without the full number (last 4 digits only): for lists and the admin MCP. */
export function redactedContact(c: Contact): Json {
  return { number_last4: c.wa.slice(-4), account: c.account ?? null, person: c.person ?? null, tags: c.tags, known_account: c.known_account, terms_set: !!c.terms, notes_set: !!c.notes, updated_at: new Date(c.updatedAt).toISOString() };
}

export async function listContacts(ctx: Ctx, o: { tag?: string; known?: boolean; offset?: number; limit?: number } = {}): Promise<Json> {
  const keys = await ctx.store.keys(CONTACT_PREFIX);
  const rows = (await ctx.store.getMany<Contact>(keys)).flatMap((r) => (r ? [r.value] : []));
  const tag = o.tag ? tagsOf(o.tag)[0] : undefined;
  const all = rows.filter((c) => (!tag || c.tags.includes(tag)) && (o.known === undefined || c.known_account === o.known)).sort((a, b) => b.updatedAt - a.updatedAt);
  const off = o.offset ?? 0;
  const page = all.slice(off, off + (o.limit ?? 50));
  return { ok: true, total: rows.length, total_matching: all.length, returned: page.length, contacts: page.map(redactedContact) };
}

/** What get_history adds: the mode, the owner's directory entry (trusted), the checks to run and the payment status. */
export function businessView(ctx: Ctx, c: Conv, contact: Contact | null): Json {
  const cfg = ctx.cfg;
  const view: Json = {
    mode: cfg.businessMode,
    language: cfg.botLanguages[0] === "auto" ? { reply_in: "the customer's language" } : { preferred: cfg.botLanguages },
  };
  if (cfg.businessMode !== "consumers" || contact) {
    view.directory = contact
      ? { trusted: true, source: "owner", known_account: contact.known_account, account: contact.account ?? null, person: contact.person ?? null, tags: contact.tags, terms: contact.terms ?? null, notes: contact.notes ?? null }
      : { trusted: true, source: "owner", known_account: false, note: "This number is not in the owner's directory: treat it as a new contact (no account terms, no private documents)." };
  }
  if (cfg.identityCheck !== "none") {
    view.identity_check = cfg.identityCheck === "known_number"
      ? "Account details, account terms and private documents only for a number marked known_account in the directory. Anyone else: general information only, or escalate (category identity)."
      : `Before account details, account terms or private documents: the number must be a known_account AND the customer must confirm: ${cfg.customerDetails.join(", ") || "their name and account name"}, matching the directory. If anything does not match, do not reveal it; escalate (category identity).`;
  }
  if (cfg.customerDetails.length) view.customer_details_to_collect = cfg.customerDetails;
  if (cfg.paymentCheck === "staff") view.payment = c.payment ? { status: c.payment.status, at: new Date(c.payment.at).toISOString() } : { status: "none" };
  if (cfg.bookingWebhookUrl) view.requests = (c.requests ?? []).slice(-5).map((r) => ({ kind: r.kind, at: new Date(r.at).toISOString(), ok: r.ok, reference: r.reference ?? null }));
  return view;
}

// ---------------------------------------------------------------- payments (staff-verified)
export async function reportPayment(ctx: Ctx, convKey: string, check: (c: Conv) => string | null, a: { amount?: string; reference?: string; method?: string }): Promise<Json> {
  if (ctx.cfg.paymentCheck !== "staff") return { ok: false, error: "payments_not_enabled" };
  const r = await update<Conv, Json>(ctx, convKey, (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    const err = check(c);
    if (err) return { next: undefined, result: { ok: false, error: err } };
    if (c.payment?.status === "verified") return { next: undefined, result: { ok: true, status: "verified", note: "Already verified by staff." } };
    c.payment = { status: "claimed", at: ctx.now(), amount: clean(a.amount, 40), reference: clean(a.reference, 80), method: clean(a.method, 40) };
    c.updatedAt = ctx.now();
    return { next: c, result: { ok: true, status: "claimed", id: c.id, wa: c.wa_id } };
  });
  if (r.result.ok !== true || r.result.status !== "claimed") return r.result;
  const { id, wa } = r.result as { id: string; wa: string };
  scheduleAlert(ctx, { event: "payment_claimed", conversationId: id, waId: wa, category: "payment", reason: [a.method, a.amount].map((x) => clean(x, 40)).filter(Boolean).join(" ") || undefined });
  return { ok: true, status: "claimed", owner_alerted: ctx.cfg.alertEvents.includes("payment_claimed") && (!!ctx.cfg.alertWebhookUrl || ctx.cfg.alertWhatsappTo.length > 0), note: "Recorded as CLAIMED, not paid. Tell the customer staff will confirm; never say it is confirmed until get_history shows payment.status verified." };
}

/** Staff decision (admin): verified or rejected. */
export async function decidePayment(ctx: Ctx, convKey: string, decision: string): Promise<Json> {
  if (decision !== "verified" && decision !== "rejected") return { ok: false, error: "value_must_be_verified_or_rejected" };
  const r = await update<Conv, Json>(ctx, convKey, (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    if (!c.payment) return { next: undefined, result: { ok: false, error: "no_payment_claim" } };
    c.payment = { ...c.payment, status: decision, decidedAt: ctx.now() };
    c.updatedAt = ctx.now();
    return { next: c, result: { ok: true, payment: decision } };
  });
  return r.result;
}

// ---------------------------------------------------------------- booking / order hook
export const REQUEST_KINDS = ["booking", "order", "quote", "callback", "other"] as const;

export interface RequestArgs { kind: string; summary: string; fields?: Record<string, unknown>; idempotency_key: string }

/**
 * Pass a request to the owner's system (BOOKING_WEBHOOK_URL). The body carries the customer's number (the owner's own system needs it
 * to follow up), the kind, the agent's summary and the details the customer gave. One attempt; a failure alerts the owner.
 */
export async function submitRequest(ctx: Ctx, convKey: string, check: (c: Conv) => string | null, a: RequestArgs): Promise<Json> {
  const cfg = ctx.cfg;
  if (!cfg.bookingWebhookUrl) return { ok: false, error: "booking_hook_not_configured", hint: "Escalate instead (category booking or order) so staff handle it." };
  if (!(REQUEST_KINDS as readonly string[]).includes(a.kind)) return { ok: false, error: "invalid_kind" };
  const summary = clean(a.summary, 1000);
  if (!summary) return { ok: false, error: "summary_required" };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.fields ?? {}).slice(0, 20)) {
    const key = k.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
    const val = typeof v === "number" || typeof v === "boolean" ? String(v) : clean(v, 300);
    if (key && val) fields[key] = val;
  }
  const key = a.idempotency_key.slice(0, 100);
  const pre = await update<Conv, Json>(ctx, convKey, (c) => {
    if (!c) return { next: undefined, result: { ok: false, error: "not_found" } };
    const err = check(c);
    if (err) return { next: undefined, result: { ok: false, error: err } };
    const prev = (c.requests ?? []).find((r) => r.key === key);
    if (prev?.ok) return { next: undefined, result: { ok: true, idempotent_replay: true, reference: prev.reference ?? null } };
    return { next: undefined, result: { ok: true, go: true, id: c.id, wa: c.wa_id, pn: c.phone_number_id } };
  });
  if (pre.result.go !== true) return pre.result;
  const { id, wa, pn } = pre.result as { id: string; wa: string; pn: string };
  let http: number | "network" = "network";
  let reference: string | undefined;
  try {
    const res = await fetchTimeout(ctx, cfg.bookingWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `${id}:${key}`.slice(0, 200), ...(cfg.bookingWebhookKey ? { Authorization: `Bearer ${cfg.bookingWebhookKey}` } : {}) },
      body: JSON.stringify({ event: "whatsapp_request", kind: a.kind, conversation_id: id, customer_number: wa, business_number_id: pn, summary, fields, at: new Date(ctx.now()).toISOString(), idempotency_key: key }),
    }, 10000);
    http = res.status;
    const j = (await res.json().catch(() => ({}))) as { reference?: unknown; id?: unknown };
    const ref = j.reference ?? j.id;
    if (typeof ref === "string" || typeof ref === "number") reference = String(ref).replace(/[^\w.:/-]/g, "").slice(0, 60) || undefined;
  } catch { http = "network"; }
  const ok = typeof http === "number" && http >= 200 && http < 300;
  await update<Conv, null>(ctx, convKey, (c) => {
    if (!c) return { next: undefined, result: null };
    c.requests = [...(c.requests ?? []).filter((r) => r.key !== key), { key, kind: a.kind, at: ctx.now(), ok, http, ...(reference ? { reference } : {}) }].slice(-20);
    c.updatedAt = ctx.now();
    return { next: c, result: null };
  });
  ctx.log("request_hook", { conv: id, kind: a.kind, ok, http });
  if (!ok) {
    scheduleAlert(ctx, { event: "booking_failed", conversationId: id, waId: wa, category: a.kind, reason: `the ${a.kind} could not be passed on (${http})` });
    return { ok: false, error: "booking_hook_failed", http, hint: "Nothing was confirmed. Tell the customer a person will confirm, then escalate (category booking or order). Retry later with the same idempotency_key." };
  }
  return { ok: true, kind: a.kind, reference: reference ?? null, note: "Passed to the business's system. Confirm to the customer only what the business confirms (a reference if one was returned)." };
}
