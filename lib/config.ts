export interface Config {
  waAccessToken?: string;
  waAppSecret?: string;
  waVerifyToken?: string;
  phoneNumberIds: string[]; // empty = accept all
  templateAllowlist: string[]; // empty = no templates
  /** WA_WABA_ID: the WhatsApp Business Account id. Needed to address a number that has no conversation yet (start_conversation with `to`). */
  wabaId?: string;
  /** WA_APP_ID: the owner's Meta app id (optional). setup_check uses it to confirm that this app is subscribed to the WABA. */
  appId?: string;
  /** OUTREACH_ALLOWLIST (owner-only binding, digits, empty by default): numbers a bot-started message may reach before they ever wrote in */
  outreachAllowlist: string[];
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
}

export const DEFAULT_WAKE_TYPES = [
  "text", "interactive", "button", "image", "audio", "video", "document", "location", "contacts", "sticker",
];

export type Env = Record<string, string | undefined>;

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const digits = (s: string): string => s.replace(/\D/g, "");

function intIn(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

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
    phoneNumberIds: list(env.WA_PHONE_NUMBER_IDS),
    templateAllowlist: list(env.WA_TEMPLATE_ALLOWLIST),
    wabaId: /^\d{5,25}$/.test(env.WA_WABA_ID?.trim() ?? "") ? env.WA_WABA_ID!.trim() : undefined,
    appId: /^\d{5,25}$/.test(env.WA_APP_ID?.trim() ?? "") ? env.WA_APP_ID!.trim() : undefined,
    outreachAllowlist: list(env.OUTREACH_ALLOWLIST).map(digits).filter(Boolean),
    graphVersion: env.GRAPH_VERSION?.trim() || "v25.0",
    // Fail-safe: anything other than exactly "live" is test mode.
    launchMode: env.LAUNCH_MODE?.trim().toLowerCase() === "live" ? "live" : "test",
    testRecipients: list(env.TEST_RECIPIENTS).map(digits),
    wakeUrl: safeWakeUrl(env.WAKE_URL),
    wakeKey: env.WAKE_KEY || undefined,
    wakeHeader: env.WAKE_HEADER?.trim() || undefined,
    wakeAuth: env.WAKE_AUTH?.trim().toLowerCase() === "header" ? "header" : "bearer",
    wakeDebounceMs: intIn(env.WAKE_DEBOUNCE_MS, 8000, 0, 25000),
    wakeTypes: wakeTypes.length ? wakeTypes : DEFAULT_WAKE_TYPES,
    leaseMs: intIn(env.LEASE_MS, 300000, 1000, 3600000),
    rateConvMax: intIn(env.RATE_CONV_MAX, 5, 1, 1000),
    rateConvWindowMs: intIn(env.RATE_CONV_WINDOW_MS, 600000, 1000, 86400000),
    rateGlobalPerHour: intIn(env.RATE_GLOBAL_PER_HOUR, 60, 1, 100000),
    sendTimeoutMs: intIn(env.SEND_TIMEOUT_MS, 15000, 1000, 55000),
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
    callingPhoneNumberId: env.CALLING_PHONE_NUMBER_ID?.trim() || list(env.WA_PHONE_NUMBER_IDS)[0] || undefined,
    callAllowedCallers: list(env.CALL_ALLOWED_CALLERS).map(digits).filter(Boolean),
    callMaxSeconds: intIn(env.CALL_MAX_SECONDS, 120, 10, 600),
    callBudgetSeconds: intIn(env.CALL_BUDGET_SECONDS, 1200, 0, 10_000_000),
    callVoice: /^[A-Za-z0-9_-]{1,80}$/.test(env.CALL_VOICE?.trim() ?? "") ? env.CALL_VOICE!.trim() : "eve",
    callLanguageHint: /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(env.CALL_LANGUAGE_HINT?.trim() ?? "") ? env.CALL_LANGUAGE_HINT!.trim() : "auto",
    callDiscloseAi: /^(1|true|yes|on)$/i.test(env.CALL_DISCLOSE_AI?.trim() ?? ""),
    callSipWebhooks: env.CALL_SIP_WEBHOOKS?.trim() === "1",
    callRecordingLine: /^(1|true|yes|on)$/i.test(env.CALL_RECORDING_LINE?.trim() ?? ""),
    callTranscripts: !/^(0|false|no|off)$/i.test(env.CALL_TRANSCRIPTS?.trim() ?? ""),
    callTranscriptDays: intIn(env.CALL_TRANSCRIPT_RETENTION_DAYS, 30, 1, 365),
    callBusinessName: (env.CALL_BUSINESS_NAME?.trim() || "our business").slice(0, 80),
    callGreeting: env.CALL_GREETING?.trim().slice(0, 600) || undefined,
    callInstructions: env.CALL_INSTRUCTIONS?.trim().slice(0, 4000) || undefined,
    metaSetupEnabled: env.META_SETUP_ENABLED?.trim() === "1",
    metaSetupDryRun: env.META_SETUP_DRY_RUN?.trim() === "1",
  };
}

export const normDigits = digits;
