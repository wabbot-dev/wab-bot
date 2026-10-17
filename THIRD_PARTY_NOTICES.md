# Third-party notices

## Runtime dependencies

**None.** The Worker bundle contains this repository's code only (`dependencies` in `package.json` is empty; the MCP endpoint is hand-written). The Cloudflare Workers runtime is provided by Cloudflare and is not distributed here.

## Development dependencies (not shipped)

`package-lock.json` lists 155 packages, all development-only, installed by `npm ci` for tests, type checking and `wrangler`. Licenses by count (read from the lock file on 2026-10-17):

| License | Packages | Notes |
|---|---|---|
| MIT | 98 | |
| Apache-2.0 | 22 | |
| MPL-2.0 | 12 | `lightningcss` and its platform binaries, pulled in by `wrangler`'s tooling. Used at build time only |
| LGPL-3.0-or-later | 10 | `@img/sharp-libvips-*` platform binaries, optional packages pulled in by `wrangler`'s image tooling. Not used by this project and not part of the Worker bundle. If you redistribute a build that contains them, follow LGPL-3.0 |
| Apache-2.0 AND LGPL-3.0-or-later (and MIT) | 4 | `@img/sharp-*` |
| MIT OR Apache-2.0 | 4 | `wrangler`, `@cloudflare/workers-types`, `@cloudflare/unenv-preset`, `@cloudflare/kv-asset-handler` |
| ISC | 2 | |
| CC0-1.0, BSD-3-Clause, 0BSD | 1 each | |

These counts are a convenience summary, not a legal opinion. Regenerate them from `package-lock.json` (`packages[*].license`) and verify against the installed packages before redistributing.

## External services

The template calls, but does not bundle, the Meta Graph API, Cloudflare (Workers, Durable Objects, Cron Triggers, and the Cloudflare API from the deploy script) and whatever agent platform you point `WAKE_URL` and the MCP endpoint at. The voice-calling guide describes xAI's API. Their terms apply to your use of them. This project is independent and is not affiliated with or endorsed by Meta, WhatsApp, Cloudflare, xAI or any agent provider.
