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

Past a Free limit the operation fails until 00:00 UTC; there is no automatic charge. A customer message costs about 3 Durable Object calls and about 3 rows written in our live test, so the Durable Object limit allows very roughly 30,000 messages a day. The upgrade path is Workers Paid (from $5 per month); the code does not change. Handlers are light (HMAC check, small JSON, one Durable Object hop) and measured Worker CPU stayed flat as stored data grew (see [STATUS.md](STATUS.md)), but individual requests (cold starts, contended retries) exceeded 10 ms in our runs without being terminated. That does not prove the limit is never enforced on Free; do not rely on it.

Other things to know:

- **No SLA on Free.** Cloudflare may limit or suspend free accounts at its discretion.
- **`WAKE_URL` on your own `workers.dev`.** A Worker cannot `fetch` another Worker on the same zone unless the `global_fetch_strictly_public` compatibility flag is set (error 1042 otherwise). It is set in `wrangler.toml`; an external agent URL is unaffected.
- **Do not use KV as the state store** (eventually consistent, no compare-and-swap, 1,000 writes per day on Free) and avoid R2 (needs a payment method even on its free tier). This template uses neither.
- **Data location.** Workers run near the caller; Free has no data-residency guarantee. Message text is stored in your Durable Object ([PRIVACY.md](PRIVACY.md)).
- **Cloudflare is your processor** for customer personal data under its terms and Data Processing Addendum; you are the controller.

## Webhook URL shape

`https://<worker-name>.<your-account-subdomain>.workers.dev/api/webhook`. The subdomain is per account (Workers & Pages, Subdomain).
