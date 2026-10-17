# Releasing

Versions follow [SemVer](https://semver.org/). Before 1.0.0, a breaking change bumps the minor version. Releases are tagged `vMAJOR.MINOR.PATCH`.

## Conventions

- Commit subjects and PR titles use [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `ci`, `chore`. A breaking change uses `!` or a `BREAKING CHANGE:` footer. The `PR title` workflow rejects other titles.
- `release-please-config.json` maps those types to changelog sections (`chore` is hidden). `CHANGELOG.md` is generated from merged PRs by release-please; do not hand-edit released sections.
- Every user-visible claim in the changelog must already be true in [STATUS.md](STATUS.md).

## Before tagging

1. `npm ci && npm run check && npm run build && npm run smoke:local && npm run hygiene && npm run hygiene:selftest` from a clean clone, all passing.
2. Re-read [STATUS.md](STATUS.md): every row still matches what you ran. Update dates and counts.
3. Re-check the Cloudflare facts in [CLOUDFLARE.md](CLOUDFLARE.md) against Cloudflare's current pages and update the "read on" date.
4. `git grep` for tokens, emails, phone numbers (also the number inside a WhatsApp call id), personal names and local paths is what `npm run hygiene` does (put your own list of names, one regex per line grouped by category, in `HYGIENE_NAMES` or an untracked `.hygiene-names` file; it also checks commit authors, messages and diffs, and `HYGIENE_HISTORY=strict` makes a history match fail); run it on the exact tree you tag.
5. Tag from the commit you verified. Do not publish a package: the repository is marked `private` in `package.json`.

## v0.1.0

The first commit was made locally with a neutral author and tagged `v0.1.0` locally. Pushing it, creating a remote or publishing the repository is a separate decision for the maintainer.
