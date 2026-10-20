# Meta (WhatsApp Cloud API) setup: tooling notes

The click-by-click path through Meta's dashboard is in [META-CHECKLIST.md](META-CHECKLIST.md). This page covers the values you need and the helper script. Meta's own documentation and dashboard are authoritative and change often.

**What has run against Meta:** on the maintainer's test app, `scripts/meta-setup.mjs` set the webhook callback and subscribed the app, and one real message round trip followed ([STATUS.md](STATUS.md)). The other steps in the script and in the optional in-Worker route have only run against a Meta fake.

**Prerequisite that cannot be skipped:** the WhatsApp number must be a **new number that has never been registered in the WhatsApp or WhatsApp Business phone app**.
The Cloud API number cannot also be used in the phone app. Coexistence (phone app and API on one number) is out of scope for this template.

## What you need from Meta (and where each value goes)

| Value | Secret? | Where it goes |
|---|---|---|
| App ID | no | only used by `scripts/meta-setup.mjs` (it can read it from `debug_token`) |
| App secret | **yes** | Worker secret `WA_APP_SECRET` (verifies every webhook signature) |
| WhatsApp Business Account (WABA) ID | no | `scripts/meta-setup.mjs --waba-id` |
| Phone number ID | no | env `WA_PHONE_NUMBER_IDS` (recommended) and `--phone-number-id` |
| System-user access token (never expiring) | **yes** | Worker secret `WA_ACCESS_TOKEN` (only the bridge holds it, never the agent) |
| Webhook verify token (you choose it, >= 16 chars) | **yes** | Worker secret `WA_VERIFY_TOKEN`; you type the same value into Meta's webhook form |

**Self-provisioning (no dashboard, API token or `wrangler login` step).** If the Worker was deployed without secret bindings ([SELF-PROVISIONING.md](SELF-PROVISIONING.md)), the values in the table above are not set with `wrangler secret put`: put `WA_APP_SECRET`, `WA_ACCESS_TOKEN` and `WA_VERIFY_TOKEN` (plus `TEST_RECIPIENTS`, `LAUNCH_MODE=test`) into a mode-0600 `KEY=VALUE` file or the environment, run `node scripts/cf-api-deploy.mjs init ...` and `provision ...` once, and the Worker stores them itself and locks setup. Change one later with `rotate` (needs `ADMIN_TOKEN`). The webhook verify token you give Meta must be the same value you provisioned as `WA_VERIFY_TOKEN`; Meta's callback and verify token can be set programmatically with `scripts/meta-setup.mjs` before or after provisioning (until the app secret is provisioned every signed POST from Meta gets 401 and nothing is stored). `--push-cloudflare` (wrangler) is not needed in this mode.

Never paste a secret into a chat or a command line. The deploy script and `scripts/meta-setup.mjs` read secrets from hidden prompts or environment variables and hand them to Cloudflare on stdin.

## Steps

1. Deploy the bridge first (`bash scripts/deploy-cloudflare.sh`, or `--self-provision`, or `node scripts/cf-api-deploy.mjs deploy --self-provision ...`), so you have the callback URL `https://<worker>.<your-subdomain>.workers.dev/api/webhook` and the generated `WA_VERIFY_TOKEN` (in `.deploy/<name>.secrets.env`, mode 0600).
2. In Meta for Developers create an app of the business type, add the **WhatsApp** product, and create or select the WhatsApp Business Account that will own your new number.
3. Add the new number, verify it (SMS or voice code) and register it for the Cloud API. **You** type the code yourself, from your own SIM or line, in Meta's form: an assistant driving the other screens never sees it and never asks for it. Set a display name; Meta reviews display names.
4. Create a **system user** in the business portfolio, give it the WhatsApp permissions (`whatsapp_business_management`, `whatsapp_business_messaging`) on the WABA and the app, and generate a token that does not expire.
5. Run the helper on **your own computer** (so Meta sees your IP, not a third party's):
   `node scripts/meta-setup.mjs --waba-id <id> --phone-number-id <id> --webhook-url https://<worker>/api/webhook --verify-token <your verify token> --push-cloudflare`
   It asks for the token and app secret at hidden prompts, checks scopes, tests your webhook handshake, subscribes the app, and with `--push-cloudflare` stores the two secrets in your Worker with `wrangler secret put` (stdin). Add `--test-to <number>` to send one template message to one recipient (it asks for confirmation unless you pass `--yes`).
6. In the Meta dashboard (Use cases > Customize the WhatsApp use case > Configuration; older UI: WhatsApp > Configuration) check the callback URL and verify token, and subscribe to the **messages** field.
7. Keep `LAUNCH_MODE=test` and auto-reply paused until a message round-trips (inbound reaches `/admin`, the agent claims it, a reply is delivered to an allowlisted test recipient). Then set `LAUNCH_MODE=live` and activate auto-reply in `/admin`.

## Optional: the in-Worker setup route

`/api/admin/meta-setup` is **off by default** (404). Set `META_SETUP_ENABLED=1` only while you use it, then remove it. It needs `ADMIN_TOKEN` and can mint a non-expiring token, which is why it is not left on. The local script above is the recommended path. `META_SETUP_DRY_RUN=1` makes the route answer from a built-in stub and never call `graph.facebook.com`. With the stub, the bootstrap token `DRYRUN_USER_TOKEN_APP_IN_USE` (shown by `GET` as `dry_run_token_app_in_use`) makes the stub's app look as if it already served another bot, so you can see the one-bot-per-app answer (`new_app_required`) without Meta.

## Subscribe your app to the WABA (always), then read it back

The most common reason the first WhatsApp message never arrives: the webhook is configured, but the owner's app is not subscribed to the WhatsApp Business Account (often only Meta's own test app is). The `subscribed_apps` step is in the default run; to run it alone:

```bash
curl -s -X POST https://<worker>/api/admin/meta-setup -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data '{"action":"subscribed_apps","waba_id":"<WABA_ID>"}'
```

It reads `GET /{WABA_ID}/subscribed_apps`, subscribes with `POST` only if your app is missing, and reads it back. The step's facts list `before_app_ids` and `after_app_ids` (ids only); a `WARN` (`subscribed_apps_other_apps`) says when other apps were subscribed but yours was not. PASS only when your app id is listed afterwards. Later, the admin MCP `setup_check` repeats the read (GET only) when `WA_WABA_ID` is set (`WA_APP_ID` makes it exact).

## One bot per Meta app (a second bot gets a new Meta app)

A Meta app has ONE app-level webhook callback, ONE app secret and its own system-user tokens for every WhatsApp number it serves.
So the default is **one bot per Meta app**: when you add another bot (for example a business line next to an existing consumer
line, or a second import of this template), it gets a **new Meta app** in the **same business portfolio**, with its own webhook,
app secret and system-user token. The number can live under the same portfolio (a new WhatsApp Business Account there keeps the
bots' events apart). Setup never moves or shares another bot's webhook on its own.

### A second bot on the same Meta app (never overwrite the first bot's webhook)

What the setup does when the target app may already serve a bot:

- **The setup reads what Meta routes today first**: `GET /{phone-number-id}?fields=webhook_configuration` (the number's own view:
  `phone_number`, `whatsapp_business_account`, `application`, needs no app secret) and `GET /{app-id}/subscriptions`.
- **Free app (first bot):** the app-level callback is set, as before.
- **App already serving another deployment (default `auto`):** nothing is changed. The in-Worker route stops right after the token
  check with `app_in_use` FAIL (`mode: new_app_required`, showing only that deployment's host) before any write, skips the other
  steps and returns a `new_app_required` block (why, the steps to create the new app, what was left untouched). The CLI reports
  `webhook_app_level` FAIL, sets the bundle's `webhook.mode` to `new_app_required`, prints **NEW META APP REQUIRED** with the same
  steps, and does not print the dashboard values (typing them into the shared app would move the other bot's numbers). Then:
  1. developers.facebook.com > My Apps > Create app: type Business, WhatsApp use case, the **same** business portfolio.
  2. Add this bot's number on the new app's WhatsApp > API Setup.
  3. Give a system user full control of the new app and its WhatsApp account; generate a never-expiring token for the new app.
  4. Re-run the setup with the new app's token and app secret (CLI: `--app-id` of the new app). The webhook is then set at the
     new app's level.
- **Fallback, only on purpose: one bot answering several numbers on a shared app.** Ask for Meta's per-number override explicitly:
  `webhook_scope: "phone"` (route) or `--phone-override` (CLI). The app level stays unchanged and only this number is routed here:
  `POST /{phone-number-id}` with `webhook_configuration.override_callback_uri` (at most 200 characters) and `verify_token`, then read
  back. Meta sends this number's events there and every other number's events to the app-level URL. The app must be subscribed to
  the WABA (the `subscribed_apps` step). Source: Meta's "Override callback URL" guide for the WhatsApp Cloud API. A later `auto`
  re-run on a number already routed here this way is recognised and left as it is.
- **This number or its WABA already routed to another deployment:** refused (FAIL), nothing changed.
- **Replacing on purpose** (the other deployment is retired): send `replace_webhook: true` (route) or `--replace-webhook` (CLI). The
  step then reports WARN with the old host.
- **Choosing the level yourself:** `webhook_scope`: `auto` (default, as above), `phone`, `waba` (every number in this WABA:
  `POST /{waba}/subscribed_apps` with `override_callback_uri`; `waba_override: true` still works) or `app`. CLI: `--phone-override`,
  `--waba-override`.
- `webhook_effective` reports where Meta now sends this number's events (this deployment or another host).

Each deployment also answers **only its own numbers**: `WA_PHONE_NUMBER_IDS` lists them. An empty list answers **no** number (fail
closed), and the setup route stores the setup number there when the list is empty (`phone_number_ids_stored`). `*` accepts any
number on the app; use it only when one bot serves the whole app. Give each bot its own Worker name too ([DEPLOY.md](DEPLOY.md)).

## Keep the minted token inside the Worker (`store_token`)

With `mint_token: true, store_token: true` (instead of `return_token: true`) the system-user token is minted, verified with `debug_token`, and written straight into this Worker's own secret store (the same store as `POST /api/admin/secrets`). It never appears in the response, a log or a chat; the step `system_user_token_stored` reports PASS, or WARN if a `WA_ACCESS_TOKEN` secret binding overrides it. If storing fails, the token falls back to the one-time `secret_delivery`.

## Call details

[META-API-CONFORMANCE.md](META-API-CONFORMANCE.md) lists each Graph call, what the documentation says and where it is ambiguous. Apart from the calls named on that page as run live, all of it is tested against a fake only.
