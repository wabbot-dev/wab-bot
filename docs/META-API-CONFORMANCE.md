# Meta Graph API conformance of `lib/meta-setup.ts` (re-checked 2026-10-15)

**How this was checked, honestly.** `developers.facebook.com` answered 403 to the research fetcher and the research environment was not
allowed to call any Meta host, so the prose docs were not read directly during that research (2026-10-15). Evidence used instead, in order of authority:

1. **Meta's own machine-readable specs** (`facebook/facebook-business-sdk-codegen`, `api_specs/specs/*.json`, last commit 2026-09-17) and
   Meta's official Java Business SDK 26.0.2 source (Maven Central). These list edges, params, required flags and enum values for Business,
   User, SystemUser, WhatsAppBusinessAccount, Application. They do **not** contain the WhatsApp phone-number node or the
   `register` / `request_code` / `verify_code` edges, nor the SystemUser `applications` / `access_tokens` edges.
2. Third-party mirrors quoting the official docs (Postman WhatsApp collection, api-evangelist OpenAPI, Stack Overflow answers quoting Meta).
3. Press coverage of Meta's changelog (Graph v25.0 = 2026-02-18, v26.0 = 2026-07-29; v21.0 retires 2027-01-21).

Anything resting only on (2)/(3) is marked **doc-ambiguous**: it is what the code does today and it is covered by the dry-run stub, but only a
real call can prove it. Every step re-reads after writing, so a wrong assumption surfaces as a clean FAIL, never as silent success.

| Step / call | Code sends | Evidence | Verdict |
|---|---|---|---|
| list businesses | `GET /me/businesses?fields=id,name,verification_status` | spec User.businesses; `verification_status` is a Business field | OK |
| create business | `POST /{user-id}/businesses` `name`*, `vertical`*, `email`, `timezone_id` | spec User.businesses POST (name, vertical required) | OK. `vertical` now validated against the 23-value enum (default `OTHER`). Whether Meta lets a *new* app create portfolios without Advanced Access: doc-ambiguous (dashboard fallback exists) |
| list system users | `GET /{biz}/system_users?fields=id,name` | spec: SystemUser fields = created_by, created_time, finance_permission, id, ip_permission, name | **FIXED**: code asked for `role`, which is not a SystemUser field (would be a #100 nonexisting-field error) |
| create system user | `POST /{biz}/system_users` `name`*, `role` (ADMIN/EMPLOYEE) | spec Business.system_users POST | OK |
| install app on system user | `POST /{su}/applications` `business_app` ; read-back `GET /{su}/applications` | prose docs only (not in spec) | doc-ambiguous; read-back failure degrades to WARN (token mint proves it) |
| assign WABA | `POST /{waba}/assigned_users` `user`*, `tasks`* (JSON list, `["MANAGE"]`) ; `GET ...?business=`* | spec; task enum = DEVELOP, MANAGE, MANAGE_EXTENSIONS, MANAGE_PHONE, MANAGE_PHONE_ASSETS, MANAGE_TEMPLATES, MESSAGING, VIEW_COST, VIEW_PHONE_ASSETS, VIEW_TEMPLATES | OK. **FIXED** GET fields: `tasks` is not an AssignedUser field (fields: business, id, name, user_type) |
| mint token (primary) | `POST /{su}/access_tokens` `business_app`, `scope`, `set_token_expires_in_60_days=false`, `appsecret_proof` (HMAC-SHA256 of the admin token with the app secret) | prose docs (3 independent quotes); not in spec | doc-ambiguous |
| mint token (fallback) | `POST /{biz}/system_user_access_tokens` `system_user_id`, `scope`, `set_token_expires_in_60_days` | spec Business.system_user_access_tokens (params: asset, fetch_only, scope, set_token_expires_in_60_days, system_user_id) | **FIXED**: no longer sends `app_id` (not a parameter of this edge; the app is the one owning the caller's token) |
| verify token | `GET /debug_token?input_token=` -> `data.type` (`SYSTEM_USER`), `expires_at` (0 = never), `scopes`, `granular_scopes[].target_ids`, `app_id`, `is_valid` | multiple sources; Meta says debug_token is unaffected by the v26 cleanups | OK |
| list WABAs | `GET /{biz}/owned_whatsapp_business_accounts?fields=id,name,account_review_status` | spec (field exists) | OK |
| add phone | `POST /{waba}/phone_numbers` `cc`, `phone_number`, `verified_name` | spec (also: migrate_phone_number, preverified_id) | OK |
| request code | `POST /{phone}/request_code` `code_method` SMS/VOICE, `language` | OpenAPI mirror: language pattern `^[a-z]{2}_[A-Z]{2}$` | **FIXED**: `language` must be a locale such as `en_US` (bare `en` is rejected locally) |
| verify code | `POST /{phone}/verify_code` `code` | Postman collection quoting the docs | OK |
| register | `POST /{phone}/register` `messaging_product=whatsapp`, `pin` (6 digits); optional `data_localization_region` (not used) | OpenAPI mirror + several guides | OK. doc-ambiguous: whether the PIN must pre-exist (two-step verification enabled first) or is set by this call; sources disagree, the code just reports Meta's answer and reads `status` back |
| subscribe app to WABA | `POST /{waba}/subscribed_apps` (no body); `GET` returns `data[].whatsapp_business_api_data.id` | spec (params override_callback_uri, verify_token) | OK |
| WABA callback override | `POST /{waba}/subscribed_apps` `override_callback_uri`, `verify_token` | spec; override applies to message webhooks only, template status still goes to the app-level URL | OK |
| app-level webhook | `POST /{app}/subscriptions` `object=whatsapp_business_account`, `callback_url`, `verify_token`, `fields`, `include_values` with the app token `APP_ID|APP_SECRET` | spec Application.subscriptions; Meta docs: programmatic subscriptions work for all products except Instagram | OK; Meta runs the GET handshake against the callback during the POST (the bridge answers it) |
| templates | `POST /{waba}/message_templates` `name`*, `category` (AUTHENTICATION/MARKETING/UTILITY), `language`, `components` (JSON list) ; `GET ...?name=` | spec | OK |
| display name | `POST /{phone}` `new_display_name`; read `new_display_name`, `new_name_status` | search results (Meta review, `phone_number_name_update` webhook) | doc-ambiguous: phone-node field names are not in Meta's public spec. Wording fixed: review can take up to ~14 days; the old text conflated that with a re-register deadline |
| default Graph version | `GRAPH_VERSION` default **v25.0** (was v21.0) | v21.0 retires 2027-01-21; v26.0 is 11 weeks old | bumped; edges used here did not change between v21 and v26 per the spec. Override with `GRAPH_VERSION` |

**What has since run against Meta (2026-10-16, the maintainer's test app and Meta's free test number, earlier revision of this code):** token validation (`GET /debug_token`, scopes and expiry), reading the phone number and WhatsApp Business Account, setting the app-level webhook (`POST /{app}/subscriptions`) and subscribing the app to the account (`POST /{waba}/subscribed_apps`), with Meta's handshake against the Worker passing, plus one inbound message and one Graph send that returned a message id. Verified by Graph reads. **Never run live:** listing or creating businesses, system users, app installation on a system user, assigning the account, minting tokens, adding or registering a phone number, requesting and verifying codes, templates, display-name changes and the WABA callback override. Those rows keep their verdicts above and are covered by a Meta fake only.

Encoding note: the route sends POST bodies form-encoded (list values as JSON strings); Meta's examples use JSON bodies. Graph accepts both on
these edges, but this is only proven by a real call. `scripts/meta-setup.mjs` (on-device) sends JSON.
