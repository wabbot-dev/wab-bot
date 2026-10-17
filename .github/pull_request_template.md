<!--
PR title: type(optional-scope): imperative outcome   (Conventional Commits; it becomes the squash-merge subject and changelog entry)
-->

## Summary

<!-- What problem does this solve for an importer, an agent or a maintainer? Link the issue with "Fixes #123" when applicable.
Keep the prior behaviour, the expected contract and the new behaviour understandable without private context. -->

## Problem and expected behavior

<!-- For fixes: the smallest trigger and the violated invariant. For features: the use case and the observable outcome. -->

## Change and scope

<!-- The chosen approach, why it fits the architecture (docs/ARCHITECTURE.md) and what is intentionally NOT included. -->

Follow the [contribution scope](https://github.com/wabbot-dev/wab-bot/blob/main/CONTRIBUTING.md#contribution-scope).
Unresolved scope, authority, side-effect or verification questions block integration, not opening a draft PR.

## Contract and boundary impact

<!-- Short answers are welcome; mark unresolved facts "unknown". Use "none" only when established. -->

- Endpoint, MCP tool or `send_reply` guard contract:
- Configuration names (`.env.example`, `docs/CONFIGURATION.md`, `lib/config.ts` kept in sync):
- Stored data and retention (`docs/PRIVACY.md`):
- Meta Graph API calls added or changed (`docs/META-API-CONFORMANCE.md`):
- Secrets handling (nothing real in files, argv, logs or tests):
- Cloudflare plan limits or cost impact (`docs/CLOUDFLARE.md`):

Expected effects (check known effects; unchecked items do not establish absence):

- [ ] Reads or writes stored conversation data.
- [ ] Sends a message through Meta, or can cause one to be sent.
- [ ] Contacts a network service other than Meta, the wake URL or Cloudflare.
- [ ] Changes who can access data (tokens, authentication, setup route).
- [ ] Creates or changes an account, a billing setting or a deployment.
- [ ] Documentation or tests only; no runtime effect.
- [ ] Not sure yet; maintainer guidance needed.

## Evidence and regression coverage

<!-- State whether evidence is executed, source-derived or proposed. For fixes, show the original failure and explain how the
regression test fails on the base revision. Documentation-only changes can use link and rendered-document checks. -->

- Tests added or updated:
- Base reproduction or other evidence:
- Remaining proof gaps (anything not run against live Meta or a live Cloudflare account must say so):

For evidence-bearing changes:

- [ ] Observed, derived and inferred claims remain distinguishable.
- [ ] Claims that were not run live are labelled (tested against fakes, owner-reported, unverified).
- [ ] Unsupported, incomplete or uncertain outcomes remain visible.

## Validation performed

<!-- List only commands that actually ran, with observed results. A command without its result is incomplete. -->

- `npm run check` — result
- `npm run build` — result
- `npm run hygiene` — result

## Compatibility, safety and release

<!-- Breaking changes, migrations, security/privacy implications, platform limits. Breaking changes use "!" or a
"BREAKING CHANGE:" footer in the commit message. -->

- Breaking changes or migration steps:
- Security or privacy review:

## Author readiness

<!-- The human owner completes these declarations before requesting review. The PR author is the owner by default.
AI agents must leave these declarations to a human to dictate to them. Draft PRs may leave them unchecked. -->

Human owner: <!-- @GitHub-handle -->

- [ ] I reviewed the final diff and the relevant existing code, understand the change and its edge cases, and take responsibility for the complete PR, including AI-assisted work.
- [ ] I checked the evidence above, confirmed it supports the current change, and recorded meaningful validation gaps.
- [ ] I declare this PR ready for initial maintainer review.

## Before merge

<!-- Draft PRs may leave pending items unchecked. -->

- [ ] This PR addresses a concrete problem or an agreed enhancement.
- [ ] Material scope and authority questions are resolved.
- [ ] The PR has one focused outcome and the title follows `type(scope): outcome`.
- [ ] Tests cover changed observable behaviour and meaningful failure paths.
- [ ] Owning docs are updated, and nothing is claimed that was not verified.
- [ ] I checked the final diff for secrets, phone numbers, message text and unrelated cleanup.
