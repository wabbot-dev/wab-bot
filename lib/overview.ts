import type { Ctx } from "./ctx";
import { normalize } from "./conv";
import { CONTROLS_KEY, controlsOf } from "./controls";
import { readAll, REJECTIONS_KEY } from "./store";
import type { Conv, ConvState, Rejections } from "./types";

/**
 * get_overview: ONE read-only health snapshot for routines and staff. Counts, ages, NAMES and booleans only.
 * It never returns message text, phone numbers, names, conversation leases, secret values, or the values of
 * list-type settings (TEST_RECIPIENTS, WAKE_URL, ...): those are reported as counts / present flags.
 * It writes nothing and changes nothing (no controls, no conversation state).
 */

export const CONV_STATES: readonly ConvState[] = ["pending", "claimed", "replied", "held_for_review", "escalated", "human_takeover"];

/** Names and sources of the managed credentials/settings, supplied by the host (the Worker knows bindings vs stored). Names only. */
export interface SecretsInfo {
  setup_locked: boolean;
  setup_nonce_present: boolean;
  names: Record<string, { source: "env" | "stored" | "unset"; kind: "secret" | "setting" }>;
}

type Json = Record<string, unknown>;
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

export async function getOverview(ctx: Ctx, secrets: SecretsInfo | null): Promise<Json> {
  const now = ctx.now();
  const { snap, items } = await readAll<Conv>(ctx.store, "conv/", [CONTROLS_KEY, REJECTIONS_KEY]); // 1 read, same cost as the admin overview
  const controls = controlsOf(snap);
  const rej = snap.get<Rejections>(REJECTIONS_KEY);

  const byState = Object.fromEntries(CONV_STATES.map((s) => [s, 0])) as Record<ConvState, number>;
  let oldestPending: { id: string; since: number } | null = null;
  let failedWakes = 0;
  let scheduledWakes = 0;
  let earliestRetry: number | undefined;
  let lastInbound: number | undefined;
  for (const r of items) {
    const c = normalize(structuredClone(r.value), now);
    byState[c.state] = (byState[c.state] ?? 0) + 1;
    if (c.lastInboundAt !== undefined && (lastInbound === undefined || c.lastInboundAt > lastInbound)) lastInbound = c.lastInboundAt;
    if (c.wake.status === "failed") {
      failedWakes++;
      if (c.wake.nextRetryAt !== undefined && (earliestRetry === undefined || c.wake.nextRetryAt < earliestRetry)) earliestRetry = c.wake.nextRetryAt;
    } else if (c.wake.status === "scheduled") scheduledWakes++;
    if (c.state === "pending") {
      // waiting since the first inbound message nobody has seen yet; falls back to the last inbound, then to the last change
      const seen = Math.max(c.seenSeq, c.claimSeq);
      const firstUnseen = c.messages.find((m) => m.dir === "in" && (m.seq ?? 0) > seen)?.ts;
      const since = firstUnseen ?? c.lastInboundAt ?? c.updatedAt;
      if (!oldestPending || since < oldestPending.since) oldestPending = { id: c.id, since };
    }
  }

  const cfg = ctx.cfg;
  return {
    generated_at: iso(now),
    read_only: true,
    conversations: {
      total: items.length,
      by_state: byState,
      pending: byState.pending,
      held_for_review: byState.held_for_review,
      escalated: byState.escalated,
      human_takeover: byState.human_takeover,
      oldest_pending_age_seconds: oldestPending ? Math.max(0, Math.floor((now - oldestPending.since) / 1000)) : null,
      oldest_pending_conversation_id: oldestPending?.id ?? null,
      last_inbound_at: iso(lastInbound),
    },
    wake: {
      failed_count: failedWakes,
      scheduled_count: scheduledWakes,
      earliest_next_retry_at: iso(earliestRetry),
      url_configured: !!cfg.wakeUrl,
      key_present: !!cfg.wakeKey,
      auth_mode: cfg.wakeHeader ? "custom_header" : cfg.wakeAuth,
      debounce_ms: cfg.wakeDebounceMs,
    },
    controls: {
      launch_mode: cfg.launchMode,
      auto_reply: controls.autoReply,
      auto_reply_updated_at: controls.updatedAt ? iso(controls.updatedAt) : null,
      test_recipients_count: cfg.testRecipients.length,
      template_allowlist_count: cfg.templateAllowlist.length,
      phone_number_ids_count: cfg.phoneNumberIds.length,
      meta_setup_enabled: cfg.metaSetupEnabled,
    },
    rejections: { count: (rej?.value.count ?? 0) + ctx.state.rejPending, last: iso(rej?.value.last) },
    secrets: secrets
      ? {
          setup_locked: secrets.setup_locked,
          setup_nonce_present: secrets.setup_nonce_present,
          present: Object.keys(secrets.names).filter((k) => secrets.names[k]!.source !== "unset").sort(),
          missing: Object.keys(secrets.names).filter((k) => secrets.names[k]!.source === "unset").sort(),
          names: secrets.names,
        }
      : null,
  };
}
