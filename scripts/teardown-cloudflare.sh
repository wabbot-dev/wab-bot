#!/usr/bin/env bash
# Delete the bridge Worker (and its Durable Object data: ALL stored conversations) from YOUR Cloudflare account.
#   bash scripts/teardown-cloudflare.sh [--name <worker-name>]
# Asks you to type the Worker name to confirm. Deletes nothing else (no domains, no other Workers).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
NAME=""
while [ $# -gt 0 ]; do case "$1" in --name) NAME="${2:?}"; shift 2 ;; *) echo "unknown option: $1" >&2; exit 2 ;; esac; done
NAME="${NAME:-$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)}"
[ -t 0 ] || { echo "ERROR: needs a terminal to confirm" >&2; exit 1; }
printf 'This permanently deletes Worker "%s" and every conversation stored in it. Type the Worker name to confirm: ' "$NAME" >&2
read -r ANSWER
[ "$ANSWER" = "$NAME" ] || { echo "Not confirmed. Nothing deleted." >&2; exit 1; }
WRANGLER_SEND_METRICS=false npx --no-install wrangler delete --name "$NAME"
rm -f ".deploy/$NAME.secrets.env"
echo "Deleted Worker $NAME and removed its local generated-secrets file."
