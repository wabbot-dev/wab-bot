# Renaming the product

The product is called **WAB bot** (package and repository slug `wab-bot`). The name is a choice of the maintainer, not a statement by Meta, WhatsApp or xAI: this project is independent and **not affiliated with or endorsed by Meta/WhatsApp or xAI** (see [DISCLAIMER.md](../DISCLAIMER.md)). If a platform owner objects to the name, it is a find-and-replace, not a redesign. There is no runtime dependency on the name; the Worker name is yours to choose at deploy time.

To find every place: `git grep -n -i "wab-bot\|wab bot"`. The places, by kind:

| Kind | Where |
|---|---|
| Package and release | `package.json` (`name`, `description`, `repository`, `bugs`, `homepage`), `package-lock.json` (`name`), `release-please-config.json` (`package-name`) |
| Default Worker name | `wrangler.toml` (`name`); the deploy scripts take `--name` / the `NAME` variable |
| README and translations | `README.md` and the 19 `docs/readme/README_*.md`: title, CI badge, the official-source notice (`scripts/check-docs.mjs` checks the link) |
| Repository URLs | `.github/ISSUE_TEMPLATE/*`, `.github/pull_request_template.md`, `docs/ROADMAP.md`, `scripts/hygiene-scan.sh` (allow-list entry), `tests/admin-mcp.test.ts` |
| Prose | `docs/STATUS.md`, `docs/WAKE-ROUTINE.md`, `docs/PRIVACY.md`, `DISCLAIMER.md`, `SECURITY.md`, `AGENTS.md`, `CHANGELOG.md`, `scripts/deploy-cloudflare.sh` (comment) |
| Names the running code reports | MCP server names in `lib/mcp.ts` (`wab-bot`) and `lib/admin-mcp.ts` (`wab-bot-admin`) with their tests, the update-check `User-Agent` in `lib/admin-mcp.ts`, the wake note in `lib/wake.ts`, the health page title in `src/pages.ts`, the xAI number label in `lib/calls-arm.ts` (`wab-bot-calling`), the default Meta system-user name in `lib/meta-setup.ts` |

Deliberately **not** tied to the name: the Durable Object classes `BridgeState` and `CallSession` (renaming a class needs a Durable Object migration and would orphan stored data), and the names of Workers you have already deployed (a Worker name is only its URL; rename by deploying a new one and tearing down the old one with `scripts/teardown-cloudflare.sh`). The generic word "bridge" in the prose describes what the software does and is not a brand.

After a rename run `npm run check` and `npm run hygiene`, and keep the non-affiliation notice in the README, every translation and `DISCLAIMER.md`.
