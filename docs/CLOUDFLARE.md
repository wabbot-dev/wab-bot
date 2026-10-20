# Hosting on Cloudflare: account, plan, limits and terms

This template runs as one Cloudflare Worker plus one SQLite-backed Durable Object in **your own Cloudflare account**. This page is the place for everything about that account. Cloudflare facts were read from Cloudflare's own pages on **2026-10-17** (links below) and change; re-check the pages before you rely on a number.

## Who owns the account

- **You own the Cloudflare account.** It is registered with your email address, you accept Cloudflare's terms yourself, you keep the login and recovery details (2FA, recovery codes), you are the party Cloudflare bills, and you can delete it at any time. Nothing in this repository creates, shares or resells accounts.
- **You pay Cloudflare directly, if you pay at all.** The Workers **Free** plan used by this template needs no payment method (observed on a throwaway account on 2026-10-16). If you ever move to Workers Paid, **you** enter the card in Cloudflare's own page. No assistant, product or maintainer should see, type or store your card number.
- **Optional assisted sign-up.** An assistant or product you use (for example a bot that sets up the deployment for you) *may* offer to create the Cloudflare and xAI accounts the setup needs (never your Meta accounts, see below), **only with your explicit, written consent**. The assistant may use an email address it controls as the first sign-up identity so that verification links reach it; in that case the model is: you are made owner/admin of the account with **your own email**, you personally do any email verification, security check, 2FA and terms acceptance that the provider requires of an account holder, you add any payment method or credits yourself in the provider's console, and you can revoke the assistant at any time (it then deletes its stored references). You can always decline and sign up yourself at `dash.cloudflare.com`; it takes a few minutes and the deploy scripts work the same either way. The deploy scripts in this repository never create accounts; they use whichever account you log in to or hold an API token for.
- **Meta accounts are always yours.** The Meta developer, Business and WhatsApp accounts, Business Verification (with your own legal documents) and the SMS or voice code for your number are done by you personally. No assistant creates them or sees the code ([META-CHECKLIST.md](META-CHECKLIST.md)).
- **Terms note.** Cloudflare's Self-Serve Subscription Agreement (last updated 2025-09-12, [cloudflare.com/terms](https://www.cloudflare.com/terms/), section 2.2.1) says that *unless Cloudflare expressly permits it in writing* you may not "sign up for the Services on behalf of a third party" (2.2.1(a)) or use scripts "so as to produce multiple accounts" (2.2.1(e)). Whether an assisted sign-up for you fits that wording is a question between you, the assistant's provider and Cloudflare. **This project does not claim Cloudflare has approved assisted sign-up**; an assistant should stop if Cloudflare objects. If that matters to you, sign up yourself, or ask Cloudflare for written permission. Hosting several unrelated businesses' bridges in one account is a different matter and is not what this template is for: one deployment per business, in that business's own account.

## Commercial use

Cloudflare's Self-Serve Subscription Agreement (checked 2026-10-17) has no "personal or non-commercial use only" restriction on Free services, and neither do the Workers [pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/) pages. A business may therefore run this bridge on the Workers Free plan; Free Services are provided at Cloudflare's discretion with no liability (section 2.6) and can be changed or ended. This is not legal advice.

Two restrictions in the same agreement matter for a messaging bridge:

- Section 2.2.1(h): you may not "process or collect personal or business credit card information on any web property that is receiving Free Services". Never use the bridge or its agent to collect card numbers.
- Section 2.2.1(i): you may not store or transmit "protected health information" (45 C.F.R. 160.103) without Cloudflare's written consent. If your business is a healthcare provider covered by those rules, get that consent or do not run it here.

## Limits that matter on the Free plan

From Cloudflare's [limits](https://developers.cloudflare.com/workers/platform/limits/) (updated 2026-10-12), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (2026-10-02) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (2026-09-30):

| Item | Workers Free |
|---|---|
| Worker requests | 100,000 per day (resets 00:00 UTC; over the limit Cloudflare returns error 1027) |
| CPU time per HTTP request / per Cron Trigger | 10 ms (waiting on network or storage does not count) |
| Durable Object requests (each RPC call is one) | 100,000 per day |
| SQLite Durable Object rows read / written | 5,000,000 / 100,000 per day (deletes count as writes) |
| SQLite stored data | 5 GB total |
| Cron Triggers per account | 5 |
| Workers Logs | 200,000 events per day, 3 days retention (Observability pricing applies from 2026-12-01) |
| Workers AI (voice notes and images, [MEDIA.md](MEDIA.md)) | 10,000 Neurons per day (resets 00:00 UTC; past it requests fail with error 3036, nothing is billed on Free). About 214 minutes of voice notes or about 190 photos a day with the default models; optional voice replies with MeloTTS cost about 19 Neurons per minute of speech ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), 2026-10-20) |

Past a Free limit the operation fails until 00:00 UTC; there is no automatic charge. A customer message costs about 3 Durable Object calls and about 3 rows written in our live test, so the Durable Object limit allows very roughly 30,000 messages a day. The upgrade path is Workers Paid (from $5 per month); the code does not change. Handlers are light (HMAC check, small JSON, one Durable Object hop) and measured Worker CPU stayed flat as stored data grew (see [STATUS.md](STATUS.md)), but individual requests (cold starts, contended retries) exceeded 10 ms in our runs without being terminated. That does not prove the limit is never enforced on Free; do not rely on it.

Other things to know:

- **No SLA on Free.** Cloudflare may limit or suspend free accounts at its discretion.
- **`WAKE_URL` on your own `workers.dev`.** A Worker cannot `fetch` another Worker on the same zone unless the `global_fetch_strictly_public` compatibility flag is set (error 1042 otherwise). It is set in `wrangler.toml`; an external agent URL is unaffected.
- **Do not use KV as the state store** (eventually consistent, no compare-and-swap, 1,000 writes per day on Free) and avoid R2 (needs a payment method even on its free tier). This template uses neither.
- **Data location.** Workers run near the caller; Free has no data-residency guarantee. Message text is stored in your Durable Object ([PRIVACY.md](PRIVACY.md)).
- **Workers AI needs no extra setup and no extra token permission**: the `[ai]` binding in `wrangler.toml` is uploaded with the Worker (the 2026-10-20 test deploy with a Workers Scripts: Edit token worked). On the Free plan the bridge cannot cause a Workers AI charge; on Workers Paid, usage past the 10,000 daily Neurons is billed ($0.011 per 1,000), so set `MEDIA_TRANSCRIBE=0` / `MEDIA_DESCRIBE=0` (and leave `VOICE_REPLIES` off) if you do not want that.
- **CPU on the Free plan**: a Worker request gets 10 ms of CPU. Encoding a voice-note reply needs about 5.5 ms per second of audio, so it runs in a Durable Object invocation (30 s of CPU), not in the request ([VOICE-REPLIES.md](VOICE-REPLIES.md#the-encoder-and-the-cpu-budget)). Measured live: 5 to 7 ms in the request, 43 to 175 ms in the Durable Object.
- **Cloudflare is your processor** for customer personal data under its terms and Data Processing Addendum; you are the controller.

## API token permissions

Only needed when you deploy with a Cloudflare API token instead of `wrangler login` (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment; [DEPLOY.md](DEPLOY.md) paths A and B). Create a **custom token** in the dashboard (My Profile, API Tokens; or Manage Account, API Tokens for an account-owned token) with exactly this:

| Permission | Needed? | Why |
|---|---|---|
| Account, **Workers Scripts, Edit** | **Yes, and sufficient** | The 2026-10-17 dry run deployed a Worker with it (upload, secrets, Cron Trigger, Durable Object migrations) and registered the account's workers.dev subdomain. Per Cloudflare docs the API call that registers a subdomain (`PUT /accounts/{id}/workers/subdomain`) accepts "Workers Scripts Write", which the dashboard calls Edit |
| Account, Workers Scripts, Read | Only to read | Per Cloudflare docs it can read the subdomain (`GET`) but not register one, upload or deploy. Not tested |
| Account, Account Settings, Read | **No** | The scripts do not use it: Cloudflare's API reference lists only the Workers Scripts permissions for the subdomain endpoints (per Cloudflare docs, not tested with a token that lacks it). Add it only if a call fails and its error asks for it |

- **Scope the token to the one account** (Account Resources: include only your account). No zone, user or "all accounts" scope: the template needs none, and this bridge does not touch domains, DNS, KV, R2 or D1.
- **Do not create the token broader than needed.** No Global API Key, no Edit on Account Settings, DNS, Zone, KV, R2 or D1, no "all accounts". Cloudflare's "Edit Cloudflare Workers" template bundles more permissions than Workers Scripts: Edit (compare its list with the table before you use it; per Cloudflare docs, not checked line by line here). Set a TTL (expiry) and delete the token in the dashboard when you are done.
- A brand-new account may refuse to create tokens until you have **verified your email address** (the dry run got an HTTP 400 and a "please verify your email" toast first). Open the verification link in full as soon as it arrives.
- **workers.dev subdomain.** A brand-new account has none, so the Worker has no workers.dev URL and a non-interactive `wrangler deploy` stops. With the token and `CLOUDFLARE_ACCOUNT_ID` exported, `scripts/deploy-cloudflare.sh` and `scripts/cf-api-deploy.mjs deploy` first read it (`GET /accounts/{id}/workers/subdomain`); if none is registered they register `<worker name>-<random suffix>` (or the name from `--subdomain NAME`), retry another suffix if the name is taken, read it back and use it for the URL. An existing subdomain is **never** changed. If Cloudflare rejects the registration the script stops with the reason and deploys nothing. This step is unit-tested against a mocked API only; it has not been run against Cloudflare. How Cloudflare answers the first `GET` on an account without a subdomain is not documented in the API reference: the code accepts an empty result, a 404 or error code 10007 as "none" and stops on anything else.

## Show-once token handling

Cloudflare shows the token secret **only once**, on the page that follows "Create Token" ([Cloudflare docs](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)). Copying it can fail: in the dry run the clipboard copy from a remote desktop did not work.

1. **Keep that page open** (do not navigate away, reload or let a tool move the browser) until the token is stored **and** verified.
2. Copy it into the place where it will live (a password manager, or the masked secret field of the tool that deploys), never into chat, a ticket, a file in the repository or a shell history. Do not retype it from a screenshot.
3. **Verify** it before closing the page, with the test command that page shows (a `curl` to the token-verify endpoint; it must report an active token).
4. **If the copy failed or the page is gone, roll the token** (My Profile, API Tokens, the three dots next to it, Roll; per [Cloudflare docs](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/) the old secret stops working and the permissions stay the same) and take the new secret from the new page. A lost secret cannot be shown again.
5. If anyone or anything other than you captured the secret from your screen (only ever with your explicit say-so), treat it as exposed and roll it once the deploy is done.

## Existing accounts

Do not assume the Cloudflare account is new. The owner may already have an account with Workers on it.

- **List before you deploy; touch only what you created.** Run `npx wrangler whoami` and list the account's Workers (dashboard, Workers & Pages; or `GET /accounts/{id}/workers/scripts`). Pick a Worker name that is **not** in the list: deploying under an existing name replaces that Worker, and `teardown` deletes it with its data. Never modify, redeploy, delete or read the secrets of a Worker you did not create. An existing workers.dev subdomain is shared by all of the account's Workers and is never changed by these scripts.
- **The owner signs in, and does 2FA, themselves.** Sign-in, 2FA, recovery codes, email verification and terms acceptance are done by the account owner personally; no assistant enters a password or a 2FA code for them and none works around a 2FA or recovery prompt.
- **Use the owner's own plain email address**, the one their Cloudflare (and Facebook) account is registered with, or one they control. Do not invent a "plus-tag" alias such as `name+anything@example.com`: in the dry run Cloudflare refused one ("a variation of this email address is already taken") and a Facebook sign-up with one never got past the form (cause not proven). If the email already has an account, the owner signs in or recovers it; do not try to create a second one.

## Webhook URL shape

`https://<worker-name>.<your-account-subdomain>.workers.dev/api/webhook`. The subdomain is per account (Workers & Pages, Subdomain); a brand-new account has none until one is registered (see [API token permissions](#api-token-permissions)).
