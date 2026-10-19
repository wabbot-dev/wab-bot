# Deploy

Deploys the bridge to **your own** Cloudflare account. Read [CLOUDFLARE.md](CLOUDFLARE.md) first (account ownership, plan, limits). Nothing here spends money: the scripts never change a plan and the Free plan needs no payment method.

Prerequisites: Node.js 20+ (22 recommended, see `.nvmrc`), `openssl` for the wrangler path, and a Cloudflare account you own.

## Path A: `wrangler` login (default)

```bash
npm ci
bash scripts/deploy-cloudflare.sh --dry-run                       # prints the plan, makes no call
bash scripts/deploy-cloudflare.sh --name my-business-wa           # lowercase letters, digits, dashes
```

The script (read it first) checks Node, logs you in with `wrangler login --device` if needed (a URL and code you approve in any browser; it never sees your password and never creates an account), deploys, generates `MCP_TOKEN`, `ADMIN_TOKEN`, `CRON_SECRET` and `WA_VERIFY_TOKEN` with `openssl`, saves them to a mode-0600 file under `.deploy/` (git-ignored) and uploads them with `wrangler secret put` (value on **stdin**: never in argv, never echoed, never in `wrangler.toml`). It then asks, at hidden prompts, for `WA_APP_SECRET` and `WA_ACCESS_TOKEN` (or reads them if exported; empty = skip, add later with `--set-secret NAME`).

## Path B: Cloudflare API, no `wrangler login`

For CI and locked-down machines: `node scripts/cf-api-deploy.mjs deploy --name my-business-wa --secrets-file my.secrets.env --var LAUNCH_MODE=test --var WA_PHONE_NUMBER_IDS=<id> --cron "0 5 * * *"` uploads the bundle, secrets (from a mode-0600 `KEY=VALUE` file), the workers.dev route and the Cron schedule through the Cloudflare API, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. `--emit-plugin-js FILE` writes the same steps for a tool that already holds a Cloudflare session. `node scripts/cf-api-deploy.mjs verify --url <url> --secrets-file my.secrets.env` checks the handshake (right and wrong token), the closed meta-setup route, unsigned and signed POSTs; `... teardown --name my-business-wa` deletes the Worker with force. Zero dependencies; it never changes a plan.

## Path C: self-provisioned secrets

When a deploy route cannot carry secret values (some tool integrations redact them), the Worker can receive its secrets itself, once: see [SELF-PROVISIONING.md](SELF-PROVISIONING.md).

## After the deploy

1. `bash scripts/smoke.sh https://<worker>.<your-subdomain>.workers.dev` (unauthenticated checks; sends no secret; each check is retried with backoff for up to about 3 minutes in total, set by `SMOKE_RETRY_SECONDS`, so a brand-new route does not fail falsely).
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
