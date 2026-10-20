# Deploy

Deploys the bridge to **your own** Cloudflare account. Read [CLOUDFLARE.md](CLOUDFLARE.md) first (account ownership, plan, limits). Nothing here spends money: the scripts never change a plan and the Free plan needs no payment method.

Prerequisites: Node.js 20+ (22 recommended, see `.nvmrc`), `openssl` for the wrangler path, and a Cloudflare account you own. If the account already has Workers, read [Existing accounts](#existing-accounts) first.

## Path A: `wrangler` login (default)

```bash
npm ci
bash scripts/deploy-cloudflare.sh --dry-run                       # prints the plan, makes no call
bash scripts/deploy-cloudflare.sh --slug acme                    # Worker name wab-bot-acme (one Worker per bot)
```

The script (read it first) checks Node, logs you in with `wrangler login --device` if needed (a URL and code you approve in any browser; it never sees your password and never creates an account), deploys, generates `MCP_TOKEN`, `ADMIN_TOKEN`, `CRON_SECRET` and `WA_VERIFY_TOKEN` with `openssl`, saves them to a mode-0600 file under `.deploy/` (git-ignored) and uploads them with `wrangler secret put` (value on **stdin**: never in argv, never echoed, never in `wrangler.toml`). It then asks, at hidden prompts, for `WA_APP_SECRET` and `WA_ACCESS_TOKEN` (or reads them if exported; empty = skip, add later with `--set-secret NAME`). If either was skipped, the script ends with a warning that names the skipped secrets and exits with code 3, because the Worker cannot verify Meta's webhooks or send replies without them. `--allow-missing-secrets` accepts that for a test setup (same warning, exit 0). `--no-secrets` sets nothing by your own choice and is not reported.

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exported (see [API token permissions](#api-token-permissions)), the script first makes sure the account has a workers.dev subdomain: a brand-new account has none and `wrangler deploy` cannot finish without one in a non-interactive shell. It registers one only if there is none (`--subdomain NAME`, or `<worker name>-<random suffix>`), never changes an existing one and stops with the reason if Cloudflare refuses. With `wrangler login` and no account id exported, wrangler asks for the subdomain itself.

## Path B: Cloudflare API, no `wrangler login`

For CI and locked-down machines: `node scripts/cf-api-deploy.mjs deploy --name my-business-wa --secrets-file my.secrets.env --var LAUNCH_MODE=test --var WA_PHONE_NUMBER_IDS=<id> --cron "0 5 * * *"` uploads the bundle, secrets (from a mode-0600 `KEY=VALUE` file), the workers.dev route and the Cron schedule through the Cloudflare API, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. `--emit-plugin-js FILE` writes the same steps for a tool that already holds a Cloudflare session. `node scripts/cf-api-deploy.mjs verify --url <url> --secrets-file my.secrets.env` checks the handshake (right and wrong token), the closed meta-setup route, unsigned and signed POSTs; `... teardown --name my-business-wa` deletes the Worker with force. Zero dependencies; it never changes a plan. Before the first upload it reads the account's workers.dev subdomain and, only when none is registered (a brand-new account), registers `<worker name>-<random suffix>` or the name given with `--subdomain NAME` (another suffix is tried a few times when a name is taken); `node scripts/cf-api-deploy.mjs subdomain --name my-business-wa` runs just that step. An existing subdomain is never changed, and a failed step exits with code 1 and the reason. This step is unit-tested with a mocked API and has not been run against Cloudflare.

### API token permissions

Create a custom token for **your one account** with **Account, Workers Scripts, Edit**, and nothing else: that is sufficient per the dry run of 2026-10-17 (deploy, secrets, Cron Trigger, Durable Object migrations, registering the workers.dev subdomain). Registering a subdomain needs that same permission per Cloudflare docs (the API lists "Workers Scripts Write" for it). Account Settings: Read is **not** used by the scripts (per Cloudflare docs, not tested without it). **Do not create the token broader than needed**: no Global API Key, no "all accounts", no zone, DNS, KV, R2 or D1 permissions; set an expiry and delete it when done. A new account must have its email verified before Cloudflare lets you create a token. The secret is shown once, so keep the page open until it is stored and verified, and roll the token if it is lost. Details, the table and the show-once steps: [CLOUDFLARE.md](CLOUDFLARE.md#api-token-permissions) and [CLOUDFLARE.md](CLOUDFLARE.md#show-once-token-handling).

## Path C: self-provisioned secrets

When a deploy route cannot carry secret values (some tool integrations redact them), the Worker can receive its secrets itself, once: see [SELF-PROVISIONING.md](SELF-PROVISIONING.md).

## One Worker per bot (a second bot in the same account)

Every bot gets its own Worker, named `wab-bot-<business>` (`--slug <business>`, or any name with `--name`). Each Worker has its own
Durable Object (conversations), tokens, numbers (`WA_PHONE_NUMBER_IDS`) and webhook route, so a consumer bot and a business bot of the
same company never share state. Before deploying, both scripts check whether a Worker of that name already exists in the account:

- `deploy-cloudflare.sh`: if it exists and this folder did not create it (no `.deploy/<name>.secrets.env`, `.setup.env` or `.owner`
  file), it **refuses** and deploys nothing. `--update` deploys over it on purpose (only when that Worker is this bot). After a deploy it
  writes `.deploy/<name>.owner` (no secrets in it). The check uses the Cloudflare API with `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` (`node scripts/cf-api-deploy.mjs check-name --name <name>`: exit 0 free, 3 taken), or `wrangler deployments list`.
- `cf-api-deploy.mjs deploy`: refuses to upload over an existing Worker of that name unless `--update`.

Then give this bot its own Meta app (a new app in the same business portfolio when another bot already uses yours): see [META-SETUP.md](META-SETUP.md#one-bot-per-meta-app-a-second-bot-gets-a-new-meta-app).

**Shared Workers AI allowance.** The free 10,000 Neurons per day (voice notes, images, documents, voice replies) belong to the **Cloudflare
account**, not to a Worker. Two bots in one account share them: when one bot uses them up (error 3036, until 00:00 UTC) the other falls back
to plain markers too. Each bot's `get_overview` shows only its own estimate; add them up, or use separate Cloudflare accounts for bots that
need the full allowance each ([MEDIA.md](MEDIA.md#cost-the-free-daily-allowance)).

## Existing accounts

The Cloudflare account may already have Workers: list them before you deploy (`npx wrangler whoami`, the dashboard, or `GET /accounts/{id}/workers/scripts`), choose a Worker name that is not in the list (the scripts refuse an existing name unless `--update`), and never touch a Worker you did not create. The account owner signs in and does any 2FA personally. Use the owner's own plain email address: Cloudflare refused a plus-tag alias in the dry run, and a Facebook sign-up with one did not go through either. Full text: [CLOUDFLARE.md](CLOUDFLARE.md#existing-accounts).

## After the deploy

1. `bash scripts/smoke.sh https://<worker>.<your-subdomain>.workers.dev` (unauthenticated checks; sends no secret; each check is retried with backoff for up to about 3 minutes in total, set by `SMOKE_RETRY_SECONDS`, so a brand-new route does not fail falsely). For a bare liveness probe, `GET /api/health` answers 200 `{"ok":true,"version":"<package version>"}`: no secrets, counts or message data, and no storage read.
2. Finish the Meta side: [META-CHECKLIST.md](META-CHECKLIST.md), tooling in [META-SETUP.md](META-SETUP.md).
3. Connect your agent: [WAKE-ROUTINE.md](WAKE-ROUTINE.md).
4. Stay in test mode until a message round-trips: `LAUNCH_MODE=test`, auto-reply paused, `TEST_RECIPIENTS` set. Only then set `LAUNCH_MODE=live` and activate auto-reply in `/admin`.

Safe defaults: `LAUNCH_MODE=test` (only exactly `live` sends to non-allowlisted recipients), auto-reply **paused** until an admin activates it, templates off until `WA_TEMPLATE_ALLOWLIST` is set, `/api/admin/meta-setup` **off** until `META_SETUP_ENABLED=1`.

## Offline check before you deploy anything

`npm run build` bundles the Worker with `wrangler deploy --dry-run` (no upload, no login). `npm run smoke:local` runs the Worker under `wrangler dev --local` with random fake secrets (generated, git-ignored, deleted on exit) and checks the handshake, signature rejection, a signed POST, an MCP claim, the admin overview and the erase endpoint, all offline.

## Teardown

`bash scripts/teardown-cloudflare.sh` (asks you to type the Worker name) deletes the Worker **and every stored conversation**. It deletes nothing else (no domains, no other Workers). To delete one customer only, see [PRIVACY.md](PRIVACY.md).

## Updating an existing deployment to a version with voice calling and the admin MCP

This version adds a second Durable Object class (`CallSession`, migration `v2`). With `wrangler` nothing extra is needed: `wrangler deploy` applies the migration from `wrangler.toml`. With the API path on a Worker created by an earlier version, add `--migrate-from v1` once. Nothing new is reachable until you set `ADMIN_MCP_TOKEN` ([mcp.md](mcp.md)) or open the calling gate ([VOICE-CALLS.md](VOICE-CALLS.md)). `bash scripts/deploy-cloudflare.sh --set-secret ADMIN_MCP_TOKEN` (and `XAI_API_KEY`) uses a hidden prompt.
