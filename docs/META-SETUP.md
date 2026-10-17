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

`/api/admin/meta-setup` is **off by default** (404). Set `META_SETUP_ENABLED=1` only while you use it, then remove it. It needs `ADMIN_TOKEN` and can mint a non-expiring token, which is why it is not left on. The local script above is the recommended path. `META_SETUP_DRY_RUN=1` makes the route answer from a built-in stub and never call `graph.facebook.com`.

## Call details

[META-API-CONFORMANCE.md](META-API-CONFORMANCE.md) lists each Graph call, what the documentation says and where it is ambiguous. Apart from the calls named on that page as run live, all of it is tested against a fake only.
