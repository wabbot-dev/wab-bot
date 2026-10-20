import type { CallSession } from "./call-do";
import type { BridgeState } from "./state-do";

/** Bindings: one Durable Object namespace plus plain-text vars / secrets (names only here; values never live in files). */
export interface Env {
  STATE: DurableObjectNamespace<BridgeState>;
  CALLS: DurableObjectNamespace<CallSession>;
  // Workers AI ([ai] binding in wrangler.toml): voice-note transcription and image description (docs/MEDIA.md). Optional.
  AI?: Ai;
  MEDIA_TRANSCRIBE?: string;
  MEDIA_DESCRIBE?: string;
  MEDIA_MAX_AUDIO_SECONDS?: string;
  MEDIA_MAX_AUDIO_BYTES?: string;
  MEDIA_MAX_IMAGE_BYTES?: string;
  MEDIA_TIMEOUT_MS?: string;
  MEDIA_STT_MODEL?: string;
  MEDIA_VISION_MODEL?: string;
  MEDIA_SELFTEST?: string;
  VOICE_REPLIES?: string;
  VOICE_TTS_MODEL?: string;
  VOICE_MAX_CHARS?: string;
  VOICE_MAX_SECONDS?: string;
  VOICE_TIMEOUT_MS?: string;
  // secrets (wrangler secret put)
  WA_ACCESS_TOKEN?: string;
  WA_APP_SECRET?: string;
  WA_VERIFY_TOKEN?: string;
  MCP_TOKEN?: string;
  ADMIN_TOKEN?: string;
  CRON_SECRET?: string;
  // owner-held bearer secret that switches on the admin MCP route (/admin/mcp); a binding only, not part of self-provisioning
  ADMIN_MCP_TOKEN?: string;
  WAKE_KEY?: string;
  // voice calling (docs/VOICE-CALLS.md). XAI_API_KEY may be self-provisioned; the CALLING_* gate and options are bindings/vars only.
  XAI_API_KEY?: string;
  CALLING_MODE?: string;
  CALLING_GO_NUMBER?: string;
  CALLING_BV_DONE?: string;
  CALLING_PHONE_NUMBER_ID?: string;
  CALL_ALLOWED_CALLERS?: string;
  CALL_MAX_SECONDS?: string;
  CALL_SIP_WEBHOOKS?: string;
  CALL_BUDGET_SECONDS?: string;
  CALL_VOICE?: string;
  CALL_LANGUAGE_HINT?: string;
  CALL_DISCLOSE_AI?: string;
  CALL_RECORDING_LINE?: string;
  CALL_TRANSCRIPTS?: string;
  CALL_TRANSCRIPT_RETENTION_DAYS?: string;
  CALL_BUSINESS_NAME?: string;
  CALL_GREETING?: string;
  CALL_INSTRUCTIONS?: string;
  // self-provisioning (plain-text var, NOT a secret): one-time key for POST /api/setup; ignored once setup is locked
  SETUP_NONCE?: string;
  // plain vars / optional secrets (see .env.example)
  WAKE_URL?: string;
  WAKE_HEADER?: string;
  WAKE_AUTH?: string;
  WAKE_DEBOUNCE_MS?: string;
  WAKE_TYPES?: string;
  WA_PHONE_NUMBER_IDS?: string;
  WA_TEMPLATE_ALLOWLIST?: string;
  WA_WABA_ID?: string;
  WA_APP_ID?: string;
  // owner-only binding (never self-provisioned): numbers a bot-started message may reach before they ever wrote in
  OUTREACH_ALLOWLIST?: string;
  GRAPH_VERSION?: string;
  LAUNCH_MODE?: string;
  TEST_RECIPIENTS?: string;
  LEASE_MS?: string;
  MAX_MESSAGES?: string;
  STALE_WAKE_MS?: string;
  RATE_CONV_MAX?: string;
  RATE_CONV_WINDOW_MS?: string;
  RATE_GLOBAL_PER_HOUR?: string;
  SEND_TIMEOUT_MS?: string;
  META_SETUP_ENABLED?: string;
  META_SETUP_DRY_RUN?: string;
}
