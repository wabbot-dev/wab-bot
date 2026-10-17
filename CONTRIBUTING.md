# Contributing

Focused bug fixes, documentation corrections, tests and small, well-argued features are welcome. For a large contract or architecture change, explain the scope first in an issue or a [design discussion](.github/ISSUE_TEMPLATE/design_discussion.yml).

## Contribution scope

In scope: the single-tenant WhatsApp Cloud API bridge on Cloudflare Workers (webhook receiver, claim/lease, guarded send, MCP tools, admin console, wake, retention, deploy and setup scripts) and the documentation that describes it.

Out of scope, and not accepted: bulk or unsolicited messaging, anything that evades Meta's rules, multi-tenant hosting of unrelated businesses in one account, reselling or sharing provider accounts, collecting card numbers, and features that give the agent the WhatsApp token or the choice of recipient. The voice-calling Worker, outbound calls and preset routines are not included in v0.1.0 ([docs/ROADMAP.md](docs/ROADMAP.md)); open a design discussion before working on them.

**Fail-closed integration rule.** A capability is not integrated while a material scope, authority, side-effect or verification question about it is unresolved. Opening a draft PR or an issue is always fine; merging waits for the answers. Anything that sends a message, spends money, creates or changes an account, or changes who can access data needs an explicit maintainer scope decision first.

## Choosing a contribution

Explain the concrete problem, keep related corrections together, and report what you verified and what you could not. Contributions should justify their review and maintenance cost. Confusing or incorrect user instructions warrant standalone corrections; collect other cosmetic suggestions in an issue.

## Reporting issues

Use the issue form that fits the report and keep it concise. For bugs: the actual result, the shortest reproduction you ran, the release and where you observed it (local tests, `wrangler dev`, a deployed Worker with fake secrets, a deployed Worker with a real Meta number), and the smallest useful redacted output. Ground the expected behaviour in a documentation page or a source line. State observed impact and frequency; keep untested scope and suspected causes explicit.

Incomplete reports and intermittent failures are welcome. If a narrative answer or evidence is unavailable, write `NOT_ENOUGH_INFO` and explain the gap. Label source-only findings and proposed checks; do not claim a reproduction or measurement you did not make. A root cause or a fix is not required to report a problem. **Never include tokens, app secrets, phone numbers or message text**; security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Development

```bash
npm ci
npm run check            # typecheck, logic tests, Worker tests (workerd), docs check
npm run build            # wrangler deploy --dry-run, no upload and no login
npm run smoke:local      # offline run under wrangler dev --local with fake secrets
npm run hygiene          # scan tracked files for secrets, personal data, stale references
```

Use Node.js from [`.nvmrc`](.nvmrc) (22; Node 20+ is the minimum in `package.json`). Nothing in the test suite calls a real service, needs a Cloudflare login or needs a Meta account. See [docs/TESTING.md](docs/TESTING.md) for what each layer proves and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the boundaries.

## Pull requests

- One focused outcome per PR; add or update tests for behaviour changes, and show that a regression test fails on the base revision.
- Use a Conventional Commit PR title (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`, `perf:`, `chore:`; `!` or a `BREAKING CHANGE:` footer for breaking changes). The `PR title` workflow checks it ([docs/RELEASING.md](docs/RELEASING.md)).
- Never commit secrets, `.env*` files (except `.env.example`), `.deploy/`, `.dev.vars`, `.wrangler/` or real phone numbers and message text. `npm run hygiene` runs in CI.
- Keep `.env.example`, [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and `lib/config.ts` in sync.
- **Do not add a claim that you have not verified.** Label each claim in the docs as tested locally, run live (and against what), owner-reported, or unverified, and update [docs/STATUS.md](docs/STATUS.md) when a claim changes.
- Describe what you ran (`npm run check`, `npm run build`, `npm run hygiene`) with the observed result.

## Pull request ownership and readiness

AI-assisted contributions are welcome. Every PR has a human owner who takes responsibility for the complete change, including code, tests, documentation and claims produced with AI assistance. The PR author is the owner unless another human is named in the PR and accepts ownership. This applies to maintainer-authored PRs too.

Before requesting maintainer review the human owner must review the final diff and the relevant existing code, be able to explain the problem, the approach and the edge cases, summarise the evidence and its gaps in the PR body, and complete the **Author readiness** section of the PR template. Documentation-only changes can use link and rendered-document checks. Never report an unrun check as passing.

Draft PRs may ask for early feedback and leave the declaration unchecked. AI agents must leave the declaration to the human owner and must not attest to a human review on their behalf. The `PR readiness` check reports pending for drafts and, for non-drafts, requires a named human owner and all three declarations; it checks that the declaration is filled in, not whether the code or the evidence is correct. Readiness requests maintainer review; it does not grant scope approval or permission to merge. Open PRs must have distinct head commits because GitHub shares commit statuses.

## Releases

See [docs/RELEASING.md](docs/RELEASING.md). Versions follow SemVer; `CHANGELOG.md` is generated by release-please from Conventional Commits.
