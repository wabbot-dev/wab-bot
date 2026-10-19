# Testing

What each test layer proves, what it cannot prove, and how to report verification. Nothing in the automated suite calls Meta, Cloudflare's network, a voice provider or any account.

```bash
npm ci
npm run check          # typecheck (3 projects) + logic tests + Worker tests + docs check
npm run build          # wrangler deploy --dry-run: bundle and binding check, no upload, no login
npm run smoke:local    # wrangler dev --local with random FAKE secrets, offline
npm run hygiene        # tracked files: secrets, personal data, stale references
npm run hygiene:selftest   # proves each hygiene detector fires on a planted fake offender
```

## Layers

| Layer | Command | Count at v0.1.0 | What it proves | What it cannot prove |
|---|---|---|---|---|
| Logic and simulation | `npm run test:logic` (`node:test`, fake clock, in-memory store with the Durable Object's compare-and-swap contract, faked Meta) | 240 | Webhook handling, the PR-readiness check, the deploy script's missing-secret exit and the smoke script's retries (fake wrangler, local fake Worker), claim/lease, the 16 send guards, wake and debounce, retention, rate limits, self-provisioning logic, `get_overview` privacy, meta-setup steps against a Meta fake, erase, op budget per customer exchange (at most 5 successful writes), the admin MCP (disabled by default, token compare, Origin check, limits, argument validation, redaction, all 13 tools), voice calling (owner gate, webhook signature, caller rules, budget, arm and disarm against a Meta/xAI fake, call finalisation, persona, no text stored) | That the fake behaves like Meta or Cloudflare |
| Worker tests | `npm run test:workers` (vitest in workerd, real Worker and real SQLite Durable Object) | 62 | Raw-byte HMAC including non-ASCII, idempotency, auth on every route, a full inbound-wake-claim-reply-finish exchange with Meta and the wake URL stubbed, per-row compare-and-swap, 20-way race, no-ABA versions, TTL purge, the meta-setup gate, erase, the admin MCP route through the real Worker with the Durable Object rate limiter, and a full call: arm, signed webhook, call session over a faked realtime socket, AI ends the call, auto-disarm, plus the dead-man alarm | Real network behaviour, quotas, CPU limits on Cloudflare Free |
| Local smoke | `npm run smoke:local` | 19 checks | The built Worker answers over HTTP under `wrangler dev --local`: handshake, bad signature, signed POST, MCP claim, admin overview, erase | The same on Cloudflare |
| Deployment smoke | `bash scripts/smoke.sh <url> [--wait SECONDS]` | n/a | Unauthenticated checks against a deployed URL, retried for up to 300 s by default while a new Worker propagates; sends no secret. The script's own retry and exit codes, and the deploy script's missing-secret exit code, are covered offline by `tests/deploy-script.test.ts`, `tests/smoke-script.test.ts` | Anything that needs a secret |
| Docs check | `npm run docs:check` | n/a | Relative links and anchors resolve; `docs/index.md` links every page; each README translation keeps the English README's code blocks, links and inline code | That the prose is true |
| Hygiene | `npm run hygiene` | n/a | No secret-shaped values, emails, phone-like numbers, local paths, personal or internal names, stale host references in tracked files | That nothing sensitive is phrased in a way the patterns miss |

## Mutation checks

The erase tests and the meta-setup gate tests were checked by breaking the code on purpose (commenting out the line that flags a conversation as deleted; removing the gate): the erase tests then fail and the gate tests fail. Do the same when you add a guard: a test that passes without the guard proves nothing. The same was done for the admin MCP and calling tests: removing the calling gate, the webhook signature check, the caller allowlist, the admin token check, the Origin check, the erase confirmation, the live-number match and the result redactor each made at least one test fail (the redactor needed an extra test, which was added). For transcripts: removing the caller-transcription request, the contact masking, the transcript delete on erase, the in-progress refusal, the per-item de-duplication and the off-switch guard in `finishCall` each made a test fail (the off-switch guard needed an extra test, which was added).

## Reporting verification in a PR or issue

State what you ran and what you saw: the command, the result, the revision. Label each claim as one of: **tested locally**, **run live** (say against what: a Cloudflare account, Meta's test number), **owner-reported**, or **unverified**. Never write "tested" for something that ran against a fake without saying so. For a bug fix, show the failing test on the base revision. If you cannot run something, say that rather than leaving it out.

## Live checks you can run yourself

On a throwaway Cloudflare account with fake secrets: `node scripts/cf-api-deploy.mjs verify --url <url> --secrets-file my.secrets.env` (six checks from outside). With a Meta test app and Meta's free test number: send one message from your own phone and confirm the sequence in [META-CHECKLIST.md](META-CHECKLIST.md). Record the date and what you saw; do not paste tokens, numbers or message text.
