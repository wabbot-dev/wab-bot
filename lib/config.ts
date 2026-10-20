import { parsePronunciations } from "./voice-pronounce";
import { styleTagOf } from "./voice-style";
import { parseDictionaries, parseLangMap, type DictLocator, type LangMap } from "./voice-map";
/** Workers AI defaults for inbound media (docs/MEDIA.md). */
export const DEFAULT_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const DEFAULT_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** Workers AI text-to-speech default for optional voice-note replies (docs/VOICE-REPLIES.md). */
export const DEFAULT_TTS_MODEL = "@cf/myshell-ai/melotts";
export type VoiceRepliesMode = "off" | "mirror" | "on";
/** VOICE_REPLY_PROVIDER: who speaks voice-note replies. `workers-ai` (default) = Workers AI only (no Arabic); `xai` (the owner's xAI
 *  key, same as calls) or `elevenlabs` (the owner's ElevenLabs key and voices) speak EVERY language by default (VOICE_REPLY_ROUTING=all),
 *  or only Arabic and the languages the Workers AI model lacks with VOICE_REPLY_ROUTING=non-workers-ai (docs/VOICE-REPLIES.md). */
export type VoiceReplyProvider = "workers-ai" | "elevenlabs" | "xai";
/** VOICE_REPLY_ROUTING (xai / elevenlabs only): `all` (default since 0.5.0) or `non-workers-ai` (the 0.4.x behaviour: Workers AI keeps its languages). */
export type VoiceReplyRouting = "all" | "non-workers-ai";
/** ElevenLabs voice ids are letters and digits; model ids lower-case words (eleven_v4). Anything else is ignored, never sent. */
export const ELEVENLABS_VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
export const ELEVENLABS_MODEL_ID_RE = /^[a-z0-9_]{3,60}$/;
/** ELEVENLABS_MODEL_ID default (tested live on the public API on 2026-10-20; eleven_v3 also works). */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_v4";
/** XAI_TTS_VOICE default (docs.x.ai text-to-speech: every voice speaks every supported language) */
export const DEFAULT_XAI_TTS_VOICE = "eve";
/** ARABIC_REPLY_DIALECT: optional preset for spoken Arabic replies (lib/voice-style.ts). Default none. */
export type ArabicReplyDialect = "none" | "msa" | "lebanese" | "gulf" | "egyptian";
export const ARABIC_DIALECTS: readonly ArabicReplyDialect[] = ["none", "msa", "lebanese", "gulf", "egyptian"];

export interface Config {
  waAccessToken?: string;
  waAppSecret?: string;
  waVerifyToken?: string;
  /** WA_PHONE_NUMBER_IDS: the numbers this deployment serves. Empty = NONE (fail closed; meta-setup fills it with the setup number).
   *  "*" = any number on the Meta app (explicit opt-in, for a single-bot app only). */
  phoneNumberIds: string[];
  acceptAnyPhoneNumber: boolean;
  templateAllowlist: string[]; // empty = no templates
  /** WA_WABA_ID: the WhatsApp Business Account id. Needed to address a number that has no conversation yet (start_conversation with `to`). */
  wabaId?: string;
  /** WA_APP_ID: the owner's Meta app id (optional). setup_check uses it to confirm that this app is subscribed to the WABA. */
  appId?: string;
  /** OUTREACH_ALLOWLIST (owner-only binding, digits, empty by default): numbers a bot-started message may reach before they ever wrote in */
  outreachAllowlist: string[];
  /** OUTBOUND_MEDIA_HOSTS: if set, documents/images sent by URL must come from these hosts (or their subdomains) */
  outboundMediaHosts: string[];
  graphVersion: string;
  launchMode: "live" | "test";
  testRecipients: string[];
  wakeUrl?: string;
  wakeKey?: string;
  wakeHeader?: string;
  wakeAuth: "bearer" | "header";
  wakeDebounceMs: number;
  wakeTypes: string[];
  leaseMs: number;
  rateConvMax: number;
  rateConvWindowMs: number;
  rateGlobalPerHour: number;
  sendTimeoutMs: number;
  /** SEND_RETRIES (default 2, 0..4): extra attempts after a rate-limited send; SEND_RETRY_BASE_MS (default 1000) the first pause (x3 each time) */
  sendRetries: number;
  sendRetryBaseMs: number;
  /** READ_RECEIPTS / TYPING_INDICATOR (default on): when the agent claims a conversation it may answer, mark the customer's message read
   *  and show "typing..." (Meta dismisses it when the reply arrives or after 25 s) */
  readReceipts: boolean;
  typingIndicator: boolean;
  /** instant owner/staff alerts (lib/alerts.ts, docs/ALERTS.md): webhook and/or WhatsApp to the owner's own numbers */
  alertWebhookUrl?: string;
  alertWebhookKey?: string;
  alertWhatsappTo: string[];
  alertTemplate?: string;
  alertTemplateLanguage: string;
  alertEvents: string[];
  alertAdminUrl?: string;
  /** business mode and profile settings (lib/business.ts, docs/BUSINESS-MODE.md) */
  businessMode: "consumers" | "businesses" | "both";
  /** BOT_LANGUAGE: "auto" (answer in the customer's language) or preferred language codes, first = default (e.g. "ar,en") */
  botLanguages: string[];
  /** IDENTITY_CHECK: none (default) | known_number (account details only to numbers in the directory) | details (also confirm CUSTOMER_DETAILS) */
  identityCheck: "none" | "known_number" | "details";
  /** CUSTOMER_DETAILS: fields the agent collects before an order/booking/account request, e.g. name,company,email */
  customerDetails: string[];
  bookingWebhookUrl?: string;
  bookingWebhookKey?: string;
  /** PAYMENT_CHECK: off (default) | staff: customers' "I paid" claims are recorded, staff are alerted and verify in /admin */
  paymentCheck: "off" | "staff";
  maxMessages: number;
  staleWakeMs: number;
  mcpToken?: string;
  adminToken?: string;
  cronSecret?: string;
  /** ADMIN_MCP_TOKEN (a real Worker secret binding only; never self-provisioned): enables the owner-only /admin/mcp route. Absent or shorter than 32 chars = route is off (404). */
  adminMcpToken?: string;
  /** XAI_API_KEY: the importer's own xAI key (calling only). Never returned or logged. */
  xaiApiKey?: string;
  /**
   * Owner gate for voice calling (all three are Worker bindings/vars only, never self-provisioned, never settable through MCP):
   * CALLING_MODE off (default) | test (allowlisted callers only) | live (needs CALLING_BV_DONE=1 and CALLING_GO_NUMBER).
   */
  callingMode: "off" | "test" | "live";
  /** digits of the one business number the owner has explicitly approved for live calling */
  callingGoNumber?: string;
  /** owner attestation that Meta Business Verification is complete */
  callingBvDone: boolean;
  /** which WhatsApp phone number id calling is armed on (default: the first WA_PHONE_NUMBER_IDS entry) */
  callingPhoneNumberId?: string;
  /** caller numbers (digits) the voice agent answers; required in test mode, optional filter in live mode */
  callAllowedCallers: string[];
  callMaxSeconds: number;
  /** most call seconds per calendar month (UTC) before new calls are turned away */
  callBudgetSeconds: number;
  callVoice: string;
  /** xAI ASR language hint ("auto" or a BCP-47 code); "auto" = automatic detection */
  callLanguageHint: string;
  callDiscloseAi: boolean;
  /** CALL_SIP_WEBHOOKS=1: ask Meta for SIP call webhooks (call_created / terminate) while armed, and log their type, call id, status and times. Test aid, off by default. */
  callSipWebhooks: boolean;
  /** CALL_SIP_TARGET: "xai" (default: the built-in xAI voice agent) or "host[:port]" of another SIP voice agent (docs/VOICE-CALLS.md) */
  callSipTarget: { kind: "xai" } | { kind: "custom"; host: string; port: number };
  callRecordingLine: boolean;
  /** CALL_TRANSCRIPTS (default ON): keep a text transcript of each call in this Worker's own Durable Object. Never audio. */
  callTranscripts: boolean;
  /** CALL_TRANSCRIPT_RETENTION_DAYS (default 30, 1 to 365): transcripts expire by themselves after this many days */
  callTranscriptDays: number;
  callBusinessName: string;
  callGreeting?: string;
  callInstructions?: string;
  /** META_SETUP_ENABLED=1 mounts /api/admin/meta-setup (default OFF: the route answers 404). Enable only while running setup. */
  metaSetupEnabled: boolean;
  /** META_SETUP_DRY_RUN=1: the /api/admin/meta-setup route talks to a built-in Meta stub and NEVER to graph.facebook.com */
  metaSetupDryRun: boolean;
  /** MEDIA_TRANSCRIBE (default ON): transcribe inbound voice notes / audio with Workers AI (docs/MEDIA.md) */
  mediaTranscribe: boolean;
  /** MEDIA_DESCRIBE (default ON): describe inbound images with a Workers AI vision model */
  mediaDescribe: boolean;
  /** MEDIA_MAX_AUDIO_SECONDS (default 120, 5 to 600): longer voice notes are not transcribed (Ogg Opus duration is read from the file) */
  mediaMaxAudioSeconds: number;
  /** MEDIA_MAX_AUDIO_BYTES (default 2 MB, up to 16 MB) */
  mediaMaxAudioBytes: number;
  /** MEDIA_MAX_IMAGE_BYTES (default 3 MB, up to 5 MB, Meta's own image limit) */
  mediaMaxImageBytes: number;
  /** MEDIA_READ_DOCUMENTS (default on): extract the text of inbound PDF / Office / CSV / text documents with Workers AI toMarkdown (free for non-image files) */
  mediaReadDocuments: boolean;
  /** MEDIA_MAX_DOC_BYTES (default 2 MB, max 10 MB) and the most document characters handed to the agent (MEDIA_MAX_DOC_CHARS, default 3000) */
  mediaMaxDocBytes: number;
  mediaMaxDocChars: number;
  /** MEDIA_TIMEOUT_MS (default 18000, 2000 to 20000): Workers AI call timeout (each Graph request has its own 5 s) */
  mediaTimeoutMs: number;
  mediaSttModel: string;
  mediaVisionModel: string;
  /** MEDIA_SELFTEST=1 mounts the owner-only POST /api/admin/media-selftest and /api/admin/voice-selftest (default OFF: 404) */
  mediaSelftest: boolean;
  /**
   * VOICE_REPLIES (default off): `mirror` (recommended) answers by voice note only when the customer's latest message was a voice
   * note; `on` also lets the agent ask for a voice reply with send_reply reply_as "voice". The text is always stored, and any
   * failure sends the text instead (docs/VOICE-REPLIES.md).
   */
  voiceReplies: VoiceRepliesMode;
  voiceTtsModel: string;
  /** VOICE_MAX_CHARS (default 400, 20 to 1500): longer replies go as text */
  voiceMaxChars: number;
  /** VOICE_MAX_SECONDS (default 45, 5 to 120): longer synthesized audio goes as text */
  voiceMaxSeconds: number;
  /** VOICE_TIMEOUT_MS (default 15000, 2000 to 20000): text-to-speech call timeout */
  voiceTimeoutMs: number;
  /** VOICE_REPLY_PROVIDER (default workers-ai): `elevenlabs` speaks Arabic (and languages Workers AI lacks) with ElevenLabs */
  voiceReplyProvider: VoiceReplyProvider;
  /** ELEVENLABS_API_KEY (secret): sent only to api.elevenlabs.io (xi-api-key header). Never logged or returned. */
  elevenlabsApiKey?: string;
  /** VOICE_REPLY_ROUTING (default all): with xai or elevenlabs, `all` languages go to that provider; `non-workers-ai` keeps Workers AI for its own */
  voiceReplyRouting: VoiceReplyRouting;
  /** ELEVENLABS_VOICE_ID: the owner's chosen ElevenLabs voice (letters and digits); the fallback for every language without its own voice */
  elevenlabsVoiceId?: string;
  /** ELEVENLABS_VOICE_IDS (optional, e.g. "ar=<id>,en=<id>" or JSON): a voice per language; ids are not secret */
  elevenlabsVoiceIds: LangMap;
  /** ELEVENLABS_MODEL_IDS (optional, e.g. "ar=eleven_v3"): a model per language; ELEVENLABS_MODEL_ID for the rest */
  elevenlabsModelIds: LangMap;
  /** VOICE_STYLE_TAGS (optional, e.g. "ar=[warm]; en=[calm, friendly]"): a style tag per language; VOICE_STYLE_TAG for the rest */
  voiceStyleTags: LangMap;
  /** ELEVENLABS_PRONUNCIATION_DICTIONARIES (optional): the owner's dictionaries, for every language (`all`) and per language */
  elevenlabsDictionaries: { all: DictLocator[]; byLang: Readonly<Record<string, DictLocator[]>> };
  /** malformed entries skipped in the maps above (logged as voice_map_ignored, shown in get_overview; never fatal) */
  voiceMapIgnored: { voice_ids: number; model_ids: number; style_tags: number; pronunciation_dictionaries: number };
  /** ELEVENLABS_MODEL_ID (default eleven_v4) */
  elevenlabsModelId: string;
  /** ELEVENLABS_MAX_CHARS (default 600, 20 to 1500): longer replies go as text (ElevenLabs bills per character) */
  elevenlabsMaxChars: number;
  /** VOICE_STYLE_TAG (optional, e.g. "[warm, friendly]"): the owner's delivery direction for tag-aware ElevenLabs models (eleven_v3/v4) */
  voiceStyleTag?: string;
  /** VOICE_PRONUNCIATIONS (optional): the owner's "written => spoken" pairs for the spoken copy (lib/voice-pronounce.ts) */
  voicePronunciations: Record<string, string>;
  /** XAI_TTS_VOICE (default eve): the xAI voice for VOICE_REPLY_PROVIDER=xai (a built-in name or the owner's custom voice id) */
  xaiTtsVoice: string;
  /** XAI_TTS_ARABIC_LOCALE (optional ar-EG | ar-SA | ar-AE): overrides the locale picked from the dialect preset */
  xaiTtsArabicLocale?: string;
  /** ARABIC_REPLY_DIALECT (default none): optional preset (msa, lebanese, gulf, egyptian) for Arabic replies that will be spoken */
  arabicReplyDialect: ArabicReplyDialect;
}

export const DEFAULT_WAKE_TYPES = [
  "text", "interactive", "button", "image", "audio", "video", "document", "location", "contacts", "sticker",
];

export type Env = Record<string, string | undefined>;

/** "xai" / empty = built-in; otherwise a public SIP host name with an optional port (default 5061, TLS). Anything else falls back to xai. */
export function sipTargetOf(v: string | undefined): Config["callSipTarget"] {
  const t = (v ?? "").trim().toLowerCase();
  if (!t || t === "xai") return { kind: "xai" };
  const m = /^(?:sips?:)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{2,5}))?$/.exec(t);
  if (!m || /^[0-9.]+$/.test(m[1]!)) return { kind: "xai" };
  const port = m[5] ? Number(m[5]) : 5061;
  if (port < 1 || port > 65535) return { kind: "xai" };
  return { kind: "custom", host: m[1]!, port };
}
const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const digits = (s: string): string => s.replace(/\D/g, "");

function intIn(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function voiceMode(v: string | undefined): VoiceRepliesMode {
  const t = v?.trim().toLowerCase() ?? "";
  if (t === "mirror") return "mirror";
  if (/^(1|true|yes|on|always)$/.test(t)) return "on";
  return "off";
}

const modelName = (v: string | undefined, def: string): string => (/^@(cf|hf)\/[A-Za-z0-9._\/-]{3,100}$/.test(v?.trim() ?? "") ? v!.trim() : def);

/** The wake key travels to WAKE_URL, so only https is accepted (http only for localhost dev). Anything else disables wake. */
export function safeWakeUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "https:") return v;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return v;
  } catch { /* fall through */ }
  return undefined;
}

export function loadConfig(env: Env): Config {
  const wakeTypes = list(env.WAKE_TYPES);
  return {
    waAccessToken: env.WA_ACCESS_TOKEN || undefined,
    waAppSecret: env.WA_APP_SECRET || undefined,
    waVerifyToken: env.WA_VERIFY_TOKEN || undefined,
    phoneNumberIds: list(env.WA_PHONE_NUMBER_IDS).filter((x) => x !== "*"),
    acceptAnyPhoneNumber: list(env.WA_PHONE_NUMBER_IDS).includes("*"),
    templateAllowlist: list(env.WA_TEMPLATE_ALLOWLIST),
    wabaId: /^\d{5,25}$/.test(env.WA_WABA_ID?.trim() ?? "") ? env.WA_WABA_ID!.trim() : undefined,
    appId: /^\d{5,25}$/.test(env.WA_APP_ID?.trim() ?? "") ? env.WA_APP_ID!.trim() : undefined,
    outreachAllowlist: list(env.OUTREACH_ALLOWLIST).map(digits).filter(Boolean),
    outboundMediaHosts: list(env.OUTBOUND_MEDIA_HOSTS).map((h) => h.toLowerCase().replace(/^\*\./, "")).filter(Boolean),
    graphVersion: env.GRAPH_VERSION?.trim() || "v25.0",
    // Fail-safe: anything other than exactly "live" is test mode.
    launchMode: env.LAUNCH_MODE?.trim().toLowerCase() === "live" ? "live" : "test",
    testRecipients: list(env.TEST_RECIPIENTS).map(digits),
    wakeUrl: safeWakeUrl(env.WAKE_URL),
    wakeKey: env.WAKE_KEY || undefined,
    wakeHeader: env.WAKE_HEADER?.trim() || undefined,
    wakeAuth: env.WAKE_AUTH?.trim().toLowerCase() === "header" ? "header" : "bearer",
    wakeDebounceMs: intIn(env.WAKE_DEBOUNCE_MS, 3000, 0, 25000),
    wakeTypes: wakeTypes.length ? wakeTypes : DEFAULT_WAKE_TYPES,
    leaseMs: intIn(env.LEASE_MS, 300000, 1000, 3600000),
    rateConvMax: intIn(env.RATE_CONV_MAX, 8, 1, 1000),
    rateConvWindowMs: intIn(env.RATE_CONV_WINDOW_MS, 600000, 1000, 86400000),
    rateGlobalPerHour: intIn(env.RATE_GLOBAL_PER_HOUR, 300, 1, 100000),
    sendTimeoutMs: intIn(env.SEND_TIMEOUT_MS, 15000, 1000, 55000),
    sendRetries: intIn(env.SEND_RETRIES, 2, 0, 4),
    sendRetryBaseMs: intIn(env.SEND_RETRY_BASE_MS, 1000, 0, 10000),
    readReceipts: !/^(0|false|no|off)$/i.test(env.READ_RECEIPTS?.trim() ?? ""),
    typingIndicator: !/^(0|false|no|off)$/i.test(env.TYPING_INDICATOR?.trim() ?? ""),
    alertWebhookUrl: /^https:\/\/[^\s]{4,500}$/.test(env.ALERT_WEBHOOK_URL?.trim() ?? "") ? env.ALERT_WEBHOOK_URL!.trim() : undefined,
    alertWebhookKey: env.ALERT_WEBHOOK_KEY?.trim() || undefined,
    alertWhatsappTo: list(env.ALERT_WHATSAPP_TO).map(normDigits).filter((x) => /^\d{7,15}$/.test(x)),
    alertTemplate: /^[a-z0-9_]{1,512}$/.test(env.ALERT_TEMPLATE?.trim() ?? "") ? env.ALERT_TEMPLATE!.trim() : undefined,
    alertTemplateLanguage: /^[a-z]{2}(_[A-Z]{2})?$/.test(env.ALERT_TEMPLATE_LANGUAGE?.trim() ?? "") ? env.ALERT_TEMPLATE_LANGUAGE!.trim() : "en",
    alertEvents: env.ALERT_EVENTS?.trim() ? list(env.ALERT_EVENTS).map((x) => x.toLowerCase()) : ["escalation", "payment_claimed", "booking_failed", "test"],
    alertAdminUrl: /^https:\/\/[^\s]{4,300}$/.test(env.ALERT_ADMIN_URL?.trim() ?? "") ? env.ALERT_ADMIN_URL!.trim() : undefined,
    businessMode: (["consumers", "businesses", "both"] as const).find((m) => m === env.BUSINESS_MODE?.trim().toLowerCase()) ?? "consumers",
    botLanguages: (() => {
      const l = list(env.BOT_LANGUAGE).map((x) => x.toLowerCase()).filter((x) => /^[a-z]{2}$/.test(x));
      return l.length ? l.slice(0, 5) : ["auto"];
    })(),
    identityCheck: (["none", "known_number", "details"] as const).find((m) => m === env.IDENTITY_CHECK?.trim().toLowerCase()) ?? "none",
    customerDetails: list(env.CUSTOMER_DETAILS).map((x) => x.toLowerCase().replace(/[^a-z0-9_ ]/g, "").trim()).filter((x) => x && x !== "none").slice(0, 10),
    bookingWebhookUrl: /^https:\/\/[^\s]{4,500}$/.test(env.BOOKING_WEBHOOK_URL?.trim() ?? "") ? env.BOOKING_WEBHOOK_URL!.trim() : undefined,
    bookingWebhookKey: env.BOOKING_WEBHOOK_KEY?.trim() || undefined,
    paymentCheck: env.PAYMENT_CHECK?.trim().toLowerCase() === "staff" ? "staff" : "off",
    maxMessages: intIn(env.MAX_MESSAGES, 50, 20, 200),
    staleWakeMs: intIn(env.STALE_WAKE_MS, 300000, 60000, 86400000),
    mcpToken: env.MCP_TOKEN || undefined,
    adminToken: env.ADMIN_TOKEN || undefined,
    cronSecret: env.CRON_SECRET || undefined,
    adminMcpToken: env.ADMIN_MCP_TOKEN || undefined,
    xaiApiKey: env.XAI_API_KEY || undefined,
    callingMode: ((m) => (m === "test" || m === "live" ? m : "off"))(env.CALLING_MODE?.trim().toLowerCase()),
    callingGoNumber: digits(env.CALLING_GO_NUMBER ?? "") || undefined,
    callingBvDone: env.CALLING_BV_DONE?.trim() === "1",
    callingPhoneNumberId: env.CALLING_PHONE_NUMBER_ID?.trim() || list(env.WA_PHONE_NUMBER_IDS).filter((x) => x !== "*")[0] || undefined,
    callAllowedCallers: list(env.CALL_ALLOWED_CALLERS).map(digits).filter(Boolean),
    callMaxSeconds: intIn(env.CALL_MAX_SECONDS, 120, 10, 600),
    callBudgetSeconds: intIn(env.CALL_BUDGET_SECONDS, 1200, 0, 10_000_000),
    callVoice: /^[A-Za-z0-9_-]{1,80}$/.test(env.CALL_VOICE?.trim() ?? "") ? env.CALL_VOICE!.trim() : "eve",
    callLanguageHint: /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(env.CALL_LANGUAGE_HINT?.trim() ?? "") ? env.CALL_LANGUAGE_HINT!.trim() : "auto",
    callDiscloseAi: /^(1|true|yes|on)$/i.test(env.CALL_DISCLOSE_AI?.trim() ?? ""),
    callSipWebhooks: env.CALL_SIP_WEBHOOKS?.trim() === "1",
    callSipTarget: sipTargetOf(env.CALL_SIP_TARGET),
    callRecordingLine: /^(1|true|yes|on)$/i.test(env.CALL_RECORDING_LINE?.trim() ?? ""),
    callTranscripts: !/^(0|false|no|off)$/i.test(env.CALL_TRANSCRIPTS?.trim() ?? ""),
    callTranscriptDays: intIn(env.CALL_TRANSCRIPT_RETENTION_DAYS, 30, 1, 365),
    callBusinessName: (env.CALL_BUSINESS_NAME?.trim() || "our business").slice(0, 80),
    callGreeting: env.CALL_GREETING?.trim().slice(0, 600) || undefined,
    callInstructions: env.CALL_INSTRUCTIONS?.trim().slice(0, 4000) || undefined,
    metaSetupEnabled: env.META_SETUP_ENABLED?.trim() === "1",
    metaSetupDryRun: env.META_SETUP_DRY_RUN?.trim() === "1",
    mediaTranscribe: !/^(0|false|no|off)$/i.test(env.MEDIA_TRANSCRIBE?.trim() ?? ""),
    mediaDescribe: !/^(0|false|no|off)$/i.test(env.MEDIA_DESCRIBE?.trim() ?? ""),
    mediaMaxAudioSeconds: intIn(env.MEDIA_MAX_AUDIO_SECONDS, 120, 5, 600),
    mediaMaxAudioBytes: intIn(env.MEDIA_MAX_AUDIO_BYTES, 2_000_000, 10_000, 16_000_000),
    mediaMaxImageBytes: intIn(env.MEDIA_MAX_IMAGE_BYTES, 3_000_000, 10_000, 5_000_000),
    mediaReadDocuments: !/^(0|false|no|off)$/i.test(env.MEDIA_READ_DOCUMENTS?.trim() ?? ""),
    mediaMaxDocBytes: intIn(env.MEDIA_MAX_DOC_BYTES, 2_000_000, 10_000, 10_000_000),
    mediaMaxDocChars: intIn(env.MEDIA_MAX_DOC_CHARS, 3000, 200, 3800),
    mediaTimeoutMs: intIn(env.MEDIA_TIMEOUT_MS, 18000, 2000, 20000),
    mediaSttModel: modelName(env.MEDIA_STT_MODEL, DEFAULT_STT_MODEL),
    mediaVisionModel: modelName(env.MEDIA_VISION_MODEL, DEFAULT_VISION_MODEL),
    mediaSelftest: env.MEDIA_SELFTEST?.trim() === "1",
    voiceReplies: voiceMode(env.VOICE_REPLIES),
    voiceTtsModel: modelName(env.VOICE_TTS_MODEL, DEFAULT_TTS_MODEL),
    voiceMaxChars: intIn(env.VOICE_MAX_CHARS, 400, 20, 1500),
    voiceMaxSeconds: intIn(env.VOICE_MAX_SECONDS, 45, 5, 120),
    voiceTimeoutMs: intIn(env.VOICE_TIMEOUT_MS, 15000, 2000, 20000),
    voiceReplyProvider: ((p) => (p === "elevenlabs" || p === "xai" ? p : "workers-ai"))(env.VOICE_REPLY_PROVIDER?.trim().toLowerCase()),
    elevenlabsApiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    voiceReplyRouting: /^non-workers-ai$/i.test(env.VOICE_REPLY_ROUTING?.trim() ?? "") ? "non-workers-ai" : "all",
    elevenlabsVoiceId: ELEVENLABS_VOICE_ID_RE.test(env.ELEVENLABS_VOICE_ID?.trim() ?? "") ? env.ELEVENLABS_VOICE_ID!.trim() : undefined,
    ...((v, m, t, d) => ({
      elevenlabsVoiceIds: v.map, elevenlabsModelIds: m.map, voiceStyleTags: t.map, elevenlabsDictionaries: { all: d.all, byLang: d.byLang },
      voiceMapIgnored: { voice_ids: v.ignored, model_ids: m.ignored, style_tags: t.ignored, pronunciation_dictionaries: d.ignored },
    }))(
      parseLangMap(env.ELEVENLABS_VOICE_IDS, (x) => (ELEVENLABS_VOICE_ID_RE.test(x) ? x : undefined)),
      parseLangMap(env.ELEVENLABS_MODEL_IDS, (x) => (ELEVENLABS_MODEL_ID_RE.test(x) ? x : undefined)),
      parseLangMap(env.VOICE_STYLE_TAGS, styleTagOf, { commas: false }),
      parseDictionaries(env.ELEVENLABS_PRONUNCIATION_DICTIONARIES),
    ),
    elevenlabsModelId: ELEVENLABS_MODEL_ID_RE.test(env.ELEVENLABS_MODEL_ID?.trim() ?? "") ? env.ELEVENLABS_MODEL_ID!.trim() : DEFAULT_ELEVENLABS_MODEL_ID,
    elevenlabsMaxChars: intIn(env.ELEVENLABS_MAX_CHARS, 600, 20, 1500),
    voiceStyleTag: styleTagOf(env.VOICE_STYLE_TAG),
    voicePronunciations: parsePronunciations(env.VOICE_PRONUNCIATIONS),
    xaiTtsVoice: /^[A-Za-z0-9_-]{1,80}$/.test(env.XAI_TTS_VOICE?.trim() ?? "") ? env.XAI_TTS_VOICE!.trim() : DEFAULT_XAI_TTS_VOICE,
    xaiTtsArabicLocale: /^ar-(EG|SA|AE)$/.test(env.XAI_TTS_ARABIC_LOCALE?.trim() ?? "") ? env.XAI_TTS_ARABIC_LOCALE!.trim() : undefined,
    arabicReplyDialect: ((d) => ((ARABIC_DIALECTS as readonly string[]).includes(d) ? (d as ArabicReplyDialect) : "none"))(env.ARABIC_REPLY_DIALECT?.trim().toLowerCase() ?? ""),
  };
}

export const normDigits = digits;

/** Does this deployment serve phone number id `pn`? Listed ids only; an empty list serves none (a second bot on the same Meta app
 *  must never answer the first bot's customers). "*" in WA_PHONE_NUMBER_IDS is the explicit opt-in to accept any number. */
export function servesNumber(cfg: Pick<Config, "phoneNumberIds" | "acceptAnyPhoneNumber">, pn: string): boolean {
  return cfg.acceptAnyPhoneNumber || cfg.phoneNumberIds.includes(pn);
}
