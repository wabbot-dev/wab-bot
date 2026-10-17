import type { Config } from "./config";
import { randomHex, sha256hex } from "./crypto";
import type { Conv } from "./types";

export const WINDOW_MS = 24 * 3600 * 1000;
export const convKeyOf = (id: string) => `conv/${id}`;
export const CONV_ID_RE = /^c_[0-9a-f]{20}$/;

export const convId = (phoneNumberId: string, wabaId: string, waId: string): string =>
  "c_" + sha256hex(`${phoneNumberId}|${wabaId}|${waId}`).slice(0, 20);

export function newConv(phoneNumberId: string, wabaId: string, waId: string, now: number): Conv {
  return {
    id: convId(phoneNumberId, wabaId, waId),
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    wa_id: waId,
    state: "replied",
    unhandled: 0,
    inSeq: 0,
    seenSeq: 0,
    claimSeq: 0,
    messages: [],
    seenIds: [],
    sends: [],
    outs: {},
    wake: { status: "none", attempts: 0, log: [] },
    createdAt: now,
    updatedAt: now,
  };
}

/** Lazy lease expiry: an expired claim silently returns to pending. Mutates and returns c. */
export function normalize(c: Conv, now: number): Conv {
  if (c.state === "claimed" && (c.leaseExpiry === undefined || c.leaseExpiry <= now)) {
    c.state = "pending";
    c.lease = undefined;
    c.leaseExpiry = undefined;
  }
  return c;
}

export const windowOpen = (c: Conv, now: number): boolean =>
  c.lastInboundAt !== undefined && now - c.lastInboundAt < WINDOW_MS;

export const seenUpTo = (c: Conv): number => Math.max(c.seenSeq, c.claimSeq);
export const hasUnseen = (c: Conv): boolean => c.inSeq > seenUpTo(c);

export function unseenMessages(c: Conv) {
  const s = seenUpTo(c);
  return c.messages.filter((m) => m.dir === "in" && (m.seq ?? 0) > s);
}

/**
 * Schedule a wake unless a live one exists. Returns true if THIS call armed it: the caller must then start a
 * wake task for c.wake.runner (only the holder of that token may fire it). A scheduled wake whose dueAt+30s is
 * still in the future is never pushed back (burst window anchored to the first message); a stale one is
 * re-armed. `force` re-arms regardless (admin wake, conversation just re-entered "pending").
 */
export const WAKE_LIVE_MS = 30000;
export function armWake(c: Conv, now: number, dueAt: number, force = false): boolean {
  const w = c.wake;
  if (!force && w.status === "scheduled" && w.dueAt !== undefined && w.dueAt + WAKE_LIVE_MS > now) return false;
  w.status = "scheduled";
  w.dueAt = dueAt;
  w.runner = randomHex(8);
  return true;
}

/** Re-wake due time after release/finish: min(now + debounce, max(now, lastInbound + debounce)). */
export function rewakeDue(c: Conv, cfg: Config, now: number): number {
  return Math.min(now + cfg.wakeDebounceMs, Math.max(now, (c.lastInboundAt ?? now) + cfg.wakeDebounceMs));
}

export const capMessages = (c: Conv, max: number) => {
  if (c.messages.length > max) c.messages.splice(0, c.messages.length - max);
};

/** dedupe ring size (ids are stored as 12-hex hashes, see seenKey) */
export const MAX_SEEN_IDS = 200;
export const MAX_OUTS = 20;
/** short stable hash of a wamid (keeps the single state document small) */
export const seenKey = (wamid: string): string => sha256hex(wamid).slice(0, 12);

export function pruneOuts(c: Conv) {
  const keys = Object.keys(c.outs);
  if (keys.length <= MAX_OUTS) return;
  keys
    .filter((k) => c.outs[k]!.status !== "uncertain" && c.outs[k]!.status !== "sending")
    .sort((a, b) => c.outs[a]!.createdAt - c.outs[b]!.createdAt)
    .slice(0, keys.length - MAX_OUTS)
    .forEach((k) => delete c.outs[k]);
}

const DAY = 86400000;
export const IDLE_TRIM_MS = 14 * DAY;
export const IDLE_DROP_MS = 180 * DAY;

/**
 * Retention for the single state document (it is re-sent on every write, so it must stay small).
 * Idle replied conversations: after 14 days keep only the last 10 messages and drop dedupe ids/old outbound
 * records (Meta redelivers for days, not weeks); after 180 days drop the record. Returns a trimmed COPY,
 * null (drop) or undefined (unchanged). Only idle+replied conversations are trimmed; any conversation idle > 180 days, or flagged `deleted`, is dropped.
 */
export function compactConv(c: Conv, now: number): Conv | null | undefined {
  if (c.deleted) return null; // admin "delete_conversation": erased on the next commit
  const idle = now - Math.max(c.updatedAt, c.lastInboundAt ?? 0);
  if (idle > IDLE_DROP_MS) return null; // any state: nothing is kept past 180 idle days
  if (c.state !== "replied") return undefined;
  if (idle <= IDLE_TRIM_MS) return undefined;
  if (c.messages.length <= 10 && c.seenIds.length === 0 && Object.keys(c.outs).length === 0 && c.wake.log.length === 0) return undefined;
  return {
    ...c,
    messages: c.messages.slice(-10),
    seenIds: [],
    sends: [],
    outs: {},
    wake: { ...c.wake, log: [] },
  };
}
