/**
 * In-memory fake of the slice of the Meta Graph API the setup route uses. It is a `fetch` replacement and has TWO jobs:
 *  1. the engine behind META_SETUP_DRY_RUN=1 (the route then never touches graph.facebook.com), and
 *  2. the mock in tests (stateful, so idempotency / resume can be asserted).
 * Everything it returns is fake; ids start with 999 so they can never be mistaken for real ones. It models only what
 * the route relies on; it is NOT a statement about how real Meta behaves.
 */
export const DRY_RUN_TOKEN = "DRYRUN_USER_TOKEN";
export const DRY_RUN_MINTED = "DRYRUN_MINTED_TOKEN_NOT_REAL";

export interface FakeFailure { match: RegExp; times?: number; status?: number; code?: number; message?: string }
export interface FakeTokenInfo { type: string; scopes: string[]; expiresAt: number; appId?: string; userId?: string; valid?: boolean }
export interface FakePhone {
  id: string; display_phone_number: string; verified_name: string; code_verification_status: string; status: string;
  platform_type: string; name_status: string; quality_rating: string; new_display_name?: string; pin?: string;
}
export interface FakeMetaOpts {
  dryRun?: boolean;
  appId?: string; appSecret?: string; userId?: string; businessId?: string; wabaId?: string;
  tokens?: Record<string, FakeTokenInfo>;
  noBusiness?: boolean; businessCount?: number; wabaCount?: number;
  phones?: Partial<FakePhone>[];
  otp?: string;
  mintedToken?: string;
  allowedRecipients?: string[];
  /** called when a webhook callback is set, like Meta's live GET handshake; return false = verification failed */
  handshake?: (callbackUrl: string, verifyToken: string) => boolean | Promise<boolean>;
  appWebhookSupported?: boolean;
  installReadable?: boolean;
  mintViaSuEdge?: boolean;
  mintedScopes?: string[];
  mintedExpiresAt?: number;
  failures?: FakeFailure[];
}
export interface FakeCall { method: string; path: string; token: string; query: Record<string, string>; form: Record<string, string> }

const ALL = ["business_management", "whatsapp_business_management", "whatsapp_business_messaging"];

export class FakeMeta {
  calls: FakeCall[] = [];
  failures: FakeFailure[];
  appId: string; appSecret?: string; userId: string; businessId: string; wabaId: string;
  tokens: Record<string, FakeTokenInfo>;
  businesses: { id: string; name: string; verification_status: string }[] = [];
  wabas: { id: string; name: string; account_review_status: string }[] = [];
  systemUsers: { id: string; name: string; role: string }[] = [];
  installed: Record<string, string[]> = {};
  assigned: Record<string, string[]> = {};
  phones: FakePhone[] = [];
  templates: { id: string; name: string; status: string; language: string; category: string }[] = [];
  subscribedApps: string[] = [];
  appSub: { object: string; callback_url: string; verify_token: string; fields: string[] } | null = null;
  /** WABA-level callback override (POST /{waba}/subscribed_apps override_callback_uri) */
  wabaOverride: string | null = null;
  /** phone-number-level callback overrides (POST /{phone-number-id} webhook_configuration) */
  phoneOverride: Record<string, string> = {};
  sends: { to: string; template: string }[] = [];
  otp: string; mintedToken: string;
  private n = 0;
  private registerCalls = 0;

  constructor(public o: FakeMetaOpts = {}) {
    const d = !!o.dryRun;
    this.appId = o.appId ?? "9990000000001";
    this.userId = o.userId ?? "9990000000002";
    this.businessId = o.businessId ?? "9990000000003";
    this.wabaId = o.wabaId ?? "9990000000004";
    this.appSecret = o.appSecret;
    this.otp = o.otp ?? "123456";
    this.mintedToken = o.mintedToken ?? DRY_RUN_MINTED;
    this.failures = [...(o.failures ?? [])];
    this.tokens = { ...(o.tokens ?? {}) };
    if (d) this.tokens[DRY_RUN_TOKEN] = { type: "USER", scopes: ALL, expiresAt: Math.floor(Date.now() / 1000) + 7200, appId: this.appId, userId: this.userId };
    if (!o.noBusiness) {
      for (let i = 0; i < (o.businessCount ?? 1); i++) {
        this.businesses.push({ id: i === 0 ? this.businessId : `${this.businessId}${i}`, name: i === 0 ? "Fake Portfolio" : `Fake Portfolio ${i + 1}`, verification_status: "not_verified" });
      }
      for (let i = 0; i < (o.wabaCount ?? 1); i++) {
        this.wabas.push({ id: i === 0 ? this.wabaId : `${this.wabaId}${i}`, name: i === 0 ? "Fake WABA" : `Fake WABA ${i + 1}`, account_review_status: "PENDING" });
      }
    }
    for (const p of o.phones ?? (d ? [{}] : [])) this.addPhone(p);
  }

  addPhone(p: Partial<FakePhone> = {}): FakePhone {
    const ph: FakePhone = {
      id: p.id ?? `${this.wabaId.slice(0, 10)}${String(50 + this.phones.length).padStart(3, "0")}`,
      display_phone_number: "+1 555 010 4444", verified_name: "Fake Business", code_verification_status: "VERIFIED", status: "CONNECTED",
      platform_type: "CLOUD_API", name_status: "APPROVED", quality_rating: "GREEN", ...p,
    };
    this.phones.push(ph);
    return ph;
  }

  post(re: RegExp) { return this.calls.filter((c) => c.method === "POST" && re.test(c.path)); }
  get graph() { return this.calls; }

  private nextId = () => `9990000001${String(++this.n).padStart(5, "0")}`;
  private json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  private err = (status: number, code: number, message: string) =>
    this.json(status, { error: { message, type: "OAuthException", code, fbtrace_id: "FAKE" } });

  fetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname !== "graph.facebook.com") throw new Error(`FakeMeta: refusing non-Meta host ${u.hostname}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname.replace(/^\/v\d+\.\d+/, "");
    const query: Record<string, string> = Object.fromEntries(u.searchParams);
    const form: Record<string, string> = {};
    const raw = init?.body ? String(init.body) : "";
    if (raw) {
      try { for (const [k, v] of Object.entries(JSON.parse(raw))) form[k] = typeof v === "string" ? v : JSON.stringify(v); }
      catch { for (const [k, v] of new URLSearchParams(raw)) form[k] = v; }
    }
    const h = new Headers(init?.headers as HeadersInit);
    const bearer = /^Bearer\s+(.+)$/i.exec(h.get("authorization") ?? "")?.[1] ?? "";
    const token = bearer || query.access_token || form.access_token || "";
    this.calls.push({ method, path, token, query, form });
    return this.handle(method, path, token, query, form);
  };

  private tokenInfo(token: string): FakeTokenInfo | null {
    const t = this.tokens[token];
    if (t) return t;
    if (token === this.mintedToken && this.minted) return this.minted;
    return null;
  }
  minted: FakeTokenInfo | null = null;

  private async handle(method: string, path: string, token: string, q: Record<string, string>, f: Record<string, string>): Promise<Response> {
    const key = `${method} ${path}`;
    for (const fl of this.failures) {
      if (fl.match.test(key) && (fl.times === undefined || fl.times > 0)) {
        if (fl.times !== undefined) fl.times--;
        return this.err(fl.status ?? 400, fl.code ?? 100, fl.message ?? "Injected failure");
      }
    }
    const isAppToken = token.startsWith(`${this.appId}|`);
    const info = this.tokenInfo(token);
    if (isAppToken) {
      if (this.appSecret && token !== `${this.appId}|${this.appSecret}`) return this.err(400, 190, "Invalid OAuth access token - app secret mismatch");
    } else if (!info || info.valid === false) {
      const msg = this.o.dryRun ? "Invalid OAuth access token (DRY RUN stub: only DRYRUN_USER_TOKEN is accepted; nothing was sent to Meta)" : "Invalid OAuth access token - Cannot parse access token";
      return this.err(400, 190, msg);
    }
    const need = (scope: string): Response | null =>
      isAppToken || info?.scopes.includes(scope) ? null : this.err(403, 200, `(#200) Requires ${scope} permission to manage the object`);
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/debug_token") {
      const t = q.input_token === token ? info : this.tokenInfo(q.input_token ?? "");
      if (!t) return this.json(200, { data: { is_valid: false, error: { code: 190, message: "Invalid token" } } });
      return this.json(200, { data: {
        app_id: t.appId ?? this.appId, type: t.type, application: "Fake App", expires_at: t.expiresAt, data_access_expires_at: 0, is_valid: t.valid !== false,
        scopes: t.scopes, user_id: t.userId ?? this.userId,
      } });
    }
    if (method === "GET" && path === "/me/businesses") {
      const e = need("business_management"); if (e) return e;
      return this.json(200, { data: this.businesses });
    }
    if (method === "POST" && (m = /^\/(me|\d+)\/businesses$/.exec(path))) {
      const e = need("business_management"); if (e) return e;
      if (!f.name) return this.err(400, 100, "Missing name");
      const b = { id: this.nextId(), name: f.name, verification_status: "not_verified" };
      this.businesses.push(b);
      return this.json(200, { id: b.id });
    }
    if (method === "GET" && (m = /^\/(\d+)$/.exec(path))) {
      const id = m[1]!;
      const b = this.businesses.find((x) => x.id === id); if (b) return this.json(200, b);
      const w = this.wabas.find((x) => x.id === id); if (w) { const e = need("whatsapp_business_management"); return e ?? this.json(200, w); }
      const p = this.phones.find((x) => x.id === id);
      if (p && q.fields === "webhook_configuration") {
        const e = need("whatsapp_business_management"); if (e) return e;
        const wc: Record<string, string> = {};
        if (this.phoneOverride[id]) wc.phone_number = this.phoneOverride[id]!;
        if (this.wabaOverride) wc.whatsapp_business_account = this.wabaOverride;
        if (this.appSub?.callback_url) wc.application = this.appSub.callback_url;
        return this.json(200, { webhook_configuration: wc, id });
      }
      if (p) { const e = need("whatsapp_business_management"); const { pin: _p, ...pub } = p; return e ?? this.json(200, pub); }
      return this.err(400, 100, `Unsupported get request. Object with ID '${id}' does not exist or you lack permission`);
    }
    if (method === "GET" && (m = /^\/(\d+)\/owned_whatsapp_business_accounts$/.exec(path))) {
      const e = need("whatsapp_business_management"); if (e) return e;
      return this.json(200, { data: m[1] === this.businessId || this.businesses.some((b) => b.id === m![1]) ? this.wabas : [] });
    }
    // Field lists below follow the Meta Business SDK specs: SystemUser has no `role` field, AssignedUser has no `tasks` field.
    const badField = (allowed: string[]): Response | null => {
      const bad = (q.fields ?? "").split(",").filter(Boolean).find((x) => !allowed.includes(x));
      return bad ? this.err(400, 100, `(#100) Tried accessing nonexisting field (${bad}) on node type`) : null;
    };
    if (m = /^\/(\d+)\/system_users$/.exec(path)) {
      const e = need("business_management"); if (e) return e;
      if (method === "GET") { const bf = badField(["id", "name", "created_by", "created_time", "finance_permission", "ip_permission"]); if (bf) return bf; }
      if (method === "GET") return this.json(200, { data: this.systemUsers });
      if (method === "POST") {
        if (!f.name) return this.err(400, 100, "Missing name");
        const su = { id: this.nextId(), name: f.name, role: f.role ?? "EMPLOYEE" };
        this.systemUsers.push(su);
        return this.json(200, { id: su.id });
      }
    }
    if (m = /^\/(\d+)\/applications$/.exec(path)) {
      const e = need("business_management"); if (e) return e;
      const su = m[1]!;
      if (method === "GET") {
        if (this.o.installReadable === false) return this.err(400, 100, "Unsupported get request");
        return this.json(200, { data: (this.installed[su] ?? []).map((id) => ({ id, name: "Fake App" })) });
      }
      if (method === "POST") {
        if (f.business_app !== this.appId) return this.err(400, 100, "Invalid business_app");
        (this.installed[su] ??= []).includes(f.business_app) || this.installed[su]!.push(f.business_app);
        return this.json(200, { success: true });
      }
    }
    if (m = /^\/(\d+)\/assigned_users$/.exec(path)) {
      const e = need("whatsapp_business_management"); if (e) return e;
      const waba = m[1]!;
      if (method === "GET") { const bf = badField(["id", "name", "business", "user_type"]); if (bf) return bf; }
      if (method === "GET") return this.json(200, { data: (this.assigned[waba] ?? []).map((id) => ({ id, name: "su" })) });
      if (method === "POST") {
        if (!this.systemUsers.some((s) => s.id === f.user)) return this.err(400, 100, "Unknown user");
        (this.assigned[waba] ??= []).includes(f.user!) || this.assigned[waba]!.push(f.user!);
        return this.json(200, { success: true });
      }
    }
    if (method === "POST" && (m = /^\/(\d+)\/access_tokens$/.exec(path))) {
      const e = need("business_management"); if (e) return e;
      if (this.o.mintViaSuEdge === false) return this.err(400, 100, "Unsupported post request (access_tokens)");
      return this.mint(m[1]!, f.business_app, f.scope);
    }
    if (method === "POST" && (m = /^\/(\d+)\/system_user_access_tokens$/.exec(path))) {
      const e = need("business_management"); if (e) return e;
      if (f.app_id !== undefined || f.business_app !== undefined) return this.err(400, 100, "(#100) Unknown parameter for business/system_user_access_tokens (the app is the one that owns the calling token)");
      return this.mint(f.system_user_id ?? "", this.appId, f.scope);
    }
    if (m = /^\/(\d+)\/phone_numbers$/.exec(path)) {
      const e = need("whatsapp_business_management"); if (e) return e;
      if (method === "GET") return this.json(200, { data: this.phones.map(({ pin: _p, ...p }) => p) });
      if (method === "POST") {
        if (!f.cc || !f.phone_number || !f.verified_name) return this.err(400, 100, "Missing cc/phone_number/verified_name");
        const ph = this.addPhone({ display_phone_number: `+${f.cc} ${f.phone_number}`, verified_name: f.verified_name, code_verification_status: "NOT_VERIFIED", status: "PENDING", platform_type: "NOT_APPLICABLE", name_status: "PENDING_REVIEW" });
        return this.json(200, { id: ph.id });
      }
    }
    if (method === "POST" && (m = /^\/(\d+)\/(request_code|verify_code|register)$/.exec(path))) {
      const e = need("whatsapp_business_management"); if (e) return e;
      const ph = this.phones.find((p) => p.id === m![1]);
      if (!ph) return this.err(400, 100, "Unknown phone number id");
      if (m[2] === "request_code") {
        if (!["SMS", "VOICE"].includes(f.code_method ?? "")) return this.err(400, 100, "Invalid code_method");
        return this.json(200, { success: true });
      }
      if (m[2] === "verify_code") {
        if (f.code !== this.otp) return this.err(400, 136024, "Invalid verification code");
        ph.code_verification_status = "VERIFIED";
        return this.json(200, { success: true });
      }
      if (ph.code_verification_status !== "VERIFIED") return this.err(400, 100, "Phone number is not verified");
      if (!/^\d{6}$/.test(f.pin ?? "")) return this.err(400, 100, "Invalid pin");
      if (++this.registerCalls > 10) return this.err(400, 133016, "Account register/deregister rate limit");
      ph.status = "CONNECTED"; ph.platform_type = "CLOUD_API"; ph.pin = f.pin;
      return this.json(200, { success: true });
    }
    if (method === "POST" && (m = /^\/(\d+)$/.exec(path)) && f.webhook_configuration) {
      const e = need("whatsapp_business_management"); if (e) return e;
      const ph = this.phones.find((p) => p.id === m![1]);
      if (!ph) return this.err(400, 100, "Unknown phone number id");
      if (!this.subscribedApps.includes(this.appId)) return this.err(400, 100, "App is not subscribed to the WhatsApp Business Account");
      let wc: { override_callback_uri?: string; verify_token?: string };
      try { wc = JSON.parse(f.webhook_configuration); } catch { return this.err(400, 100, "Invalid webhook_configuration"); }
      const uri = wc.override_callback_uri ?? "";
      if (uri.length > 200) return this.err(400, 100, "override_callback_uri too long");
      if (!uri) { delete this.phoneOverride[ph.id]; return this.json(200, { success: true }); }
      const ok = this.o.handshake ? await this.o.handshake(uri, wc.verify_token ?? "") : true;
      if (!ok) return this.err(400, 2200, "Callback verification failed");
      this.phoneOverride[ph.id] = uri;
      return this.json(200, { success: true });
    }
    if (method === "POST" && (m = /^\/(\d+)$/.exec(path)) && (q.new_display_name || f.new_display_name)) {
      const ph = this.phones.find((p) => p.id === m![1]);
      if (!ph) return this.err(400, 100, "Unknown phone number id");
      ph.new_display_name = q.new_display_name ?? f.new_display_name;
      return this.json(200, { success: true });
    }
    if (m = /^\/(\d+)\/subscribed_apps$/.exec(path)) {
      const e = need("whatsapp_business_management"); if (e) return e;
      if (method === "GET") return this.json(200, { data: this.subscribedApps.map((id) => ({ whatsapp_business_api_data: { id, name: "Fake App" }, ...(id === this.appId && this.wabaOverride ? { override_callback_uri: this.wabaOverride } : {}) })) });
      if (method === "POST") {
        if (!isAppToken && info?.appId && info.appId !== this.appId) return this.err(400, 100, "wrong app");
        if (!this.subscribedApps.includes(this.appId)) this.subscribedApps.push(this.appId);
        if (f.override_callback_uri !== undefined) {
          const ok = f.override_callback_uri && this.o.handshake ? await this.o.handshake(f.override_callback_uri, f.verify_token ?? "") : true;
          if (!ok) return this.err(400, 2200, "Callback verification failed");
          this.wabaOverride = f.override_callback_uri || null;
        }
        return this.json(200, { success: true });
      }
    }
    if (m = /^\/(\d+)\/subscriptions$/.exec(path)) {
      if (!isAppToken) return this.err(400, 190, "App access token required");
      if (this.o.appWebhookSupported === false) return this.err(400, 100, "Webhooks for WhatsApp is not supported. WhatsApp webhooks must be configured using the App Dashboard.");
      if (method === "GET") return this.json(200, { data: this.appSub ? [{ object: this.appSub.object, callback_url: this.appSub.callback_url, active: true, fields: this.appSub.fields.map((name) => ({ name, version: "v21.0" })) }] : [] });
      if (method === "POST") {
        const ok = this.o.handshake ? await this.o.handshake(f.callback_url ?? "", f.verify_token ?? "") : true;
        if (!ok) return this.err(400, 2200, "Callback verification failed with the following errors: HTTP Status Code = 403");
        this.appSub = { object: f.object ?? "", callback_url: f.callback_url ?? "", verify_token: f.verify_token ?? "", fields: (f.fields ?? "").split(",").filter(Boolean) };
        return this.json(200, { success: true });
      }
    }
    if (m = /^\/(\d+)\/message_templates$/.exec(path)) {
      const e = need("whatsapp_business_management"); if (e) return e;
      if (method === "GET") return this.json(200, { data: this.templates.filter((t) => !q.name || t.name === q.name) });
      if (method === "POST") {
        if (!f.name || !f.category || !f.language || !f.components) return this.err(400, 100, "Missing template fields");
        const t = { id: this.nextId(), name: f.name, status: "PENDING", language: f.language, category: f.category };
        this.templates.push(t);
        return this.json(200, { id: t.id, status: t.status, category: t.category });
      }
    }
    if (method === "POST" && (m = /^\/(\d+)\/messages$/.exec(path))) {
      const e = need("whatsapp_business_messaging"); if (e) return e;
      const ph = this.phones.find((p) => p.id === m![1]);
      if (!ph || ph.status !== "CONNECTED") return this.err(400, 133010, "Account not registered");
      if (this.o.allowedRecipients && !this.o.allowedRecipients.includes(f.to ?? "")) return this.err(400, 131030, "Recipient phone number not in allowed list");
      const tpl = JSON.parse(f.template ?? "{}").name ?? "";
      this.sends.push({ to: f.to ?? "", template: tpl });
      return this.json(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.FAKE${this.sends.length}` }] });
    }
    return this.err(400, 100, `FakeMeta: unsupported ${method} ${path}`);
  }

  private mint(suId: string, appId: string | undefined, scope: string | undefined): Response {
    if (!this.systemUsers.some((s) => s.id === suId)) return this.err(400, 100, "Unknown system user");
    if (appId !== this.appId) return this.err(400, 100, "Invalid app");
    if (!(this.installed[suId] ?? []).includes(this.appId)) return this.err(400, 100, "App is not installed for this system user");
    this.minted = { type: "SYSTEM_USER", scopes: this.o.mintedScopes ?? (scope ?? "").split(",").filter(Boolean), expiresAt: this.o.mintedExpiresAt ?? 0, appId: this.appId };
    this.tokens[this.mintedToken] = this.minted;
    return this.json(200, { access_token: this.mintedToken });
  }
}
