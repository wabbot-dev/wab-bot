export type ConvState = "replied" | "pending" | "claimed" | "escalated" | "human_takeover" | "held_for_review";

export type MsgDir = "in" | "out";

export interface Msg {
  id: string;
  dir: MsgDir;
  type: string;
  text: string;
  ts: number; // epoch ms
  status?: string;
  /** inbound sequence number (inbound only; reactions have none) */
  seq?: number;
  /** reply key for outbound messages (links to Conv.outs) */
  rk?: string;
}

/**
 * none | scheduled (armed; the runner holding `runner` fires it, a successful POST is NOT persisted, the
 * next claim records it as "sent") | sent | failed (backoff, retried).
 */
export type WakeStatus = "none" | "scheduled" | "sent" | "failed";

export interface WakeState {
  status: WakeStatus;
  dueAt?: number;
  /** token of the single invocation allowed to fire this scheduled wake */
  runner?: string;
  /** stale-scheduled re-fires so far (capped, reset on claim) */
  rearms?: number;
  attempts: number;
  nextRetryAt?: number;
  lastError?: string;
  log: { at: number; ok: boolean; code: number }[];
}

export type OutStatus = "sending" | "sent" | "uncertain" | "failed" | "delivered" | "read";

export interface OutRec {
  key: string;
  status: OutStatus;
  wamid?: string;
  kind: "text" | "template";
  template?: string;
  error?: string;
  metaErrorCode?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Conv {
  id: string;
  phone_number_id: string;
  waba_id: string;
  wa_id: string;
  name?: string;
  state: ConvState;
  prevState?: ConvState;
  lease?: string;
  leaseExpiry?: number;
  claimedAt?: number;
  lastInboundAt?: number;
  lastInboundHandledAt?: number;
  unhandled: number;
  inSeq: number;
  seenSeq: number;
  claimSeq: number;
  messages: Msg[];
  /** recent wamids for dedupe (superset of messages[] window) */
  seenIds: string[];
  /** send timestamps for the per-conversation rate limit */
  sends: number[];
  /** outbound records by reply key (capped) */
  outs: Record<string, OutRec>;
  wake: WakeState;
  escalation?: { reason: string; at: number };
  hold?: { reason: string; at: number; replyKey?: string };
  createdAt: number;
  updatedAt: number;
  /** set by the admin delete_conversation action; the store drops the record on that same commit */
  deleted?: true;
}

export interface Controls {
  autoReply: "paused" | "active";
  updatedAt: number;
}

export interface Rejections {
  count: number;
  last: number;
}

export interface HourCounter {
  c: number;
}
