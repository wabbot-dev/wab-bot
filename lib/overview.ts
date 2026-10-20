import type { Ctx } from "./ctx";
import { normalize } from "./conv";
import { CONTROLS_KEY, controlsOf } from "./controls";
import { readAll, REJECTIONS_KEY } from "./store";
import type { Conv, ConvState, Rejections } from "./types";
import { FREE_NEURONS_PER_DAY, MEDIA_METRICS_KEY, NEURONS_PER_AUDIO_MINUTE, NEURONS_PER_M_TOKENS, NEURONS_PER_TTS_1K_CHARS, NEURONS_PER_TTS_MINUTE, utcDay, zeroCounts, type MediaMetrics } from "./media";
import { voiceLanguagesOf, voiceRoutingOf } from "./voice-reply";
import { ALERTS_KEY, type AlertRecord } from "./alerts";

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
  const { snap, items } = await readAll<Conv>(ctx.store, "conv/", [CONTROLS_KEY, REJECTIONS_KEY, MEDIA_METRICS_KEY, ALERTS_KEY]); // 1 read, same cost as the admin overview
  const controls = controlsOf(snap);
  const rej = snap.get<Rejections>(REJECTIONS_KEY);

  const byState = Object.fromEntries(CONV_STATES.map((s) => [s, 0])) as Record<ConvState, number>;
  let oldestPending: { id: string; since: number } | null = null;
  let failedWakes = 0;
  let scheduledWakes = 0;
  let earliestRetry: number | undefined;
  let lastInbound: number | undefined;
  let optedOut = 0;
  for (const r of items) {
    const c = normalize(structuredClone(r.value), now);
    byState[c.state] = (byState[c.state] ?? 0) + 1;
    if (c.optOut) optedOut++;
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
      opted_out: optedOut,
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
      phone_filter: cfg.acceptAnyPhoneNumber ? "any" : cfg.phoneNumberIds.length ? "listed" : "none_configured_rejecting",
      meta_setup_enabled: cfg.metaSetupEnabled,
    },
    rejections: { count: (rej?.value.count ?? 0) + ctx.state.rejPending, last: iso(rej?.value.last) },
    business: {
      mode: cfg.businessMode, language: cfg.botLanguages, identity_check: cfg.identityCheck, customer_details_count: cfg.customerDetails.length,
      payment_check: cfg.paymentCheck, booking_hook_configured: !!cfg.bookingWebhookUrl, outbound_media_hosts_count: cfg.outboundMediaHosts.length,
      call_sip_target: cfg.callSipTarget.kind,
    },
    alerts: (() => {
      const a = snap.get<AlertRecord>(ALERTS_KEY)?.value;
      return {
        webhook_configured: !!cfg.alertWebhookUrl, whatsapp_recipients_count: cfg.alertWhatsappTo.length, template_set: !!cfg.alertTemplate, events: cfg.alertEvents,
        sent_count: a?.count ?? 0, last_at: iso(a?.at), last_event: a?.event ?? null, last_webhook_status: a?.webhook?.status ?? null,
        last_whatsapp: a?.whatsapp ? { sent: a.whatsapp.sent, failed: a.whatsapp.failed, codes: a.whatsapp.codes } : null,
      };
    })(),
    media: mediaOverview(ctx, snap.get<MediaMetrics>(MEDIA_METRICS_KEY)?.value ?? null, now),
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

/** Voice note / image understanding: switches, caps, models and counters (no content). See docs/MEDIA.md. */
function mediaOverview(ctx: Ctx, m: MediaMetrics | null, now: number): Json {
  const cfg = ctx.cfg;
  const today = m && m.day === utcDay(now) ? { ...zeroCounts(), ...m.today } : zeroCounts();
  const total = m ? { ...zeroCounts(), ...m.total } : zeroCounts();
  const stt = NEURONS_PER_AUDIO_MINUTE[cfg.mediaSttModel];
  const vis = NEURONS_PER_M_TOKENS[cfg.mediaVisionModel];
  const ttsMin = NEURONS_PER_TTS_MINUTE[cfg.voiceTtsModel];
  const tts1k = NEURONS_PER_TTS_1K_CHARS[cfg.voiceTtsModel];
  // Workers AI speech only: replies spoken by ElevenLabs cost no Neurons (they use the owner's ElevenLabs characters instead)
  const waSec = Math.max(0, today.voice_seconds - today.voice_el_seconds);
  const waChars = Math.max(0, today.voice_chars - today.voice_el_chars);
  const waSent = Math.max(0, today.voice_sent - today.voice_el_sent);
  const tts = ttsMin !== undefined ? (waSec / 60) * ttsMin : tts1k !== undefined ? (waChars / 1000) * tts1k : waSent ? null : 0;
  const est = stt !== undefined && vis !== undefined && tts !== null
    ? Math.round((today.audio_seconds / 60) * stt + (today.vision_input_tokens * vis.in + today.vision_output_tokens * vis.out) / 1e6 + tts)
    : null;
  return {
    transcribe_enabled: cfg.mediaTranscribe,
    describe_enabled: cfg.mediaDescribe,
    ai_binding_present: !!ctx.ai,
    stt_model: cfg.mediaSttModel,
    vision_model: cfg.mediaVisionModel,
    max_audio_seconds: cfg.mediaMaxAudioSeconds,
    max_audio_bytes: cfg.mediaMaxAudioBytes,
    max_image_bytes: cfg.mediaMaxImageBytes,
    voice_replies: cfg.voiceReplies,
    voice_tts_model: cfg.voiceTtsModel,
    voice_languages: voiceLanguagesOf(cfg),
    voice_reply_provider: cfg.voiceReplyProvider,
    voice_routing: voiceRoutingOf(cfg),
    ...(cfg.voiceReplyProvider === "elevenlabs"
      ? {
          elevenlabs: {
            key_present: !!cfg.elevenlabsApiKey, voice_id_set: !!cfg.elevenlabsVoiceId, model_id: cfg.elevenlabsModelId, max_chars: cfg.elevenlabsMaxChars, style_tag_set: !!cfg.voiceStyleTag,
            // per-language mapping: voice ids are not secrets (the key never appears here); "*" = the fallback for every other language
            voices: { ...cfg.elevenlabsVoiceIds, "*": cfg.elevenlabsVoiceId ?? null },
            model_ids: { ...cfg.elevenlabsModelIds },
            style_tag_languages: Object.keys(cfg.voiceStyleTags),
            // the owner's pronunciation dictionaries (ids and versions only): "*" = every language, then per language
            pronunciation_dictionaries: { ...Object.fromEntries(Object.entries(cfg.elevenlabsDictionaries.byLang).map(([l, d]) => [l, d.map((x) => `${x.pronunciation_dictionary_id}:${x.version_id ?? "latest"}`)])), "*": cfg.elevenlabsDictionaries.all.map((x) => `${x.pronunciation_dictionary_id}:${x.version_id ?? "latest"}`) },
            ignored_entries: cfg.voiceMapIgnored,
          },
        }
      : {}),
    ...(cfg.voiceReplyProvider === "xai" ? { xai: { key_present: !!cfg.xaiApiKey, voice: cfg.xaiTtsVoice, arabic_locale: cfg.xaiTtsArabicLocale ?? null } } : {}),
    pronunciations_count: Object.keys(cfg.voicePronunciations).length,
    arabic_reply_dialect: cfg.arabicReplyDialect,
    voice_speaker_present: !!ctx.speakVoice,
    voice_max_chars: cfg.voiceMaxChars,
    voice_max_seconds: cfg.voiceMaxSeconds,
    day_utc: utcDay(now),
    today,
    total,
    estimated_neurons_today: est,
    free_neurons_per_day: FREE_NEURONS_PER_DAY,
    last_failure_at: iso(m?.last_failure_at),
    last_failure_code: m?.last_failure_code ?? null,
  };
}
