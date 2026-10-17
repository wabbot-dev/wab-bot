#!/usr/bin/env bash
# Deploy WAB bot to YOUR OWN Cloudflare account (Workers + a SQLite Durable Object).
#
#   bash scripts/deploy-cloudflare.sh [--name <worker-name>] [--dry-run] [--no-secrets]
#   bash scripts/deploy-cloudflare.sh --set-secret WA_APP_SECRET        # add/rotate ONE secret later (hidden prompt)
#   bash scripts/deploy-cloudflare.sh --self-provision [--name N]       # NO `wrangler secret put`: the Worker receives its secrets once, itself
#
# What it does, in order:
#   1. checks Node >= 20 and installs dependencies (npm ci) if needed
#   2. checks you are logged in; if not, runs `wrangler login --device` (a URL + code you approve in ANY browser; the
#      script never sees your password and never creates an account: log in to a Cloudflare account that YOU own, see docs/CLOUDFLARE.md)
#   3. deploys the Worker (`wrangler deploy`): with no secrets set yet every endpoint fails closed
#   4. generates the bridge's own tokens (MCP_TOKEN, ADMIN_TOKEN, CRON_SECRET, WA_VERIFY_TOKEN) with openssl, writes
#      them ONLY to a mode-0600 file under .deploy/ (git-ignored) and uploads them with `wrangler secret put`
#   5. asks (hidden prompt, or from the environment) for the Meta values WA_APP_SECRET and WA_ACCESS_TOKEN
#
# Secret handling: values are never put in argv (they are piped to `wrangler secret put` on stdin), never echoed and
# never written to wrangler.toml. Environment variables named like the secrets are read if already exported.
# Nothing here touches Meta. Free plan only; this script cannot spend money (it never upgrades a plan).
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."

NAME=""; DRY=0; NOSECRETS=0; ONLY=""; SELF=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-secrets) NOSECRETS=1; shift ;;
    --self-provision) SELF=1; shift ;;
    --set-secret) ONLY="${2:?--set-secret needs a secret name}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
WR() { WRANGLER_SEND_METRICS="${WRANGLER_SEND_METRICS:-false}" npx --no-install wrangler "$@"; }

[ -f wrangler.toml ] && [ -f src/worker.ts ] || die "run this from the template folder (wrangler.toml and src/worker.ts not found)"
command -v node >/dev/null || die "Node.js >= 20 is required"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js >= 20 is required"
command -v openssl >/dev/null || die "openssl is required (used to generate random tokens)"

TOML_NAME="$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
NAME="${NAME:-$TOML_NAME}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$ ]] || die "worker name must be lowercase letters, digits and dashes (got '$NAME')"
NAME_ARGS=(--name "$NAME")

GEN_SECRETS=(MCP_TOKEN ADMIN_TOKEN CRON_SECRET WA_VERIFY_TOKEN)
META_SECRETS=(WA_APP_SECRET WA_ACCESS_TOKEN)
ALLOWED=" ${GEN_SECRETS[*]} ${META_SECRETS[*]} WAKE_KEY WAKE_URL XAI_API_KEY ADMIN_MCP_TOKEN "

if [ "$DRY" = 1 ] && [ "$SELF" = 1 ]; then
  say "DRY RUN (no Cloudflare call, nothing written). Self-provisioning plan for Worker '$NAME':"
  say "  1. npm ci (if node_modules is missing); wrangler whoami || wrangler login --device"
  say "  2. node scripts/cf-api-deploy.mjs init  -> .deploy/$NAME.setup.env (mode 0600): random SETUP_NONCE and bridge tokens; Meta values from exported WA_APP_SECRET / WA_ACCESS_TOKEN"
  say "  3. wrangler deploy ${NAME_ARGS[*]} --var SETUP_NONCE:<random>   (a plain-text var; NO secret bindings)"
  say "  4. node scripts/cf-api-deploy.mjs provision  -> POST /api/setup once over HTTPS; the Worker stores the values in its Durable Object and locks setup"
  exit 0
fi
if [ "$DRY" = 1 ]; then
  say "DRY RUN (no Cloudflare call, nothing written). Plan for Worker '$NAME':"
  say "  1. npm ci (if node_modules is missing)"
  say "  2. wrangler whoami || wrangler login --device"
  say "  3. wrangler deploy ${NAME_ARGS[*]}"
  say "  4. generate + wrangler secret put: ${GEN_SECRETS[*]} (values saved to .deploy/$NAME.secrets.env, mode 0600)"
  say "  5. prompt + wrangler secret put: ${META_SECRETS[*]} (hidden input, stdin only)"
  exit 0
fi

[ -d node_modules ] || { say "Installing dependencies (npm ci)..."; npm ci --no-audit --no-fund >/dev/null; }

# Put one secret: value on STDIN only, never in argv, never echoed.
put_secret() { # name value
  [[ "$ALLOWED" == *" $1 "* ]] || die "unknown secret name: $1"
  printf '%s' "$2" | WR secret put "$1" "${NAME_ARGS[@]}" >/dev/null
  say "  set $1"
}

# Hidden prompt (value stays in this shell only). Uses the exported variable of the same name when present.
ask_secret() { # name label
  local n="$1" v="${!1:-}"
  if [ -z "$v" ]; then
    [ -t 0 ] || { say "  skipped $n (no terminal; export $n or run: bash scripts/deploy-cloudflare.sh --set-secret $n)"; return 0; }
    printf '%s (input hidden, empty = skip): ' "$2" >&2
    IFS= read -rs v || true
    printf '\n' >&2
  fi
  [ -n "$v" ] || { say "  skipped $n (set it later with: bash scripts/deploy-cloudflare.sh --set-secret $n)"; return 0; }
  put_secret "$n" "$v"
  v=""
}

login_if_needed() {
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then say "Using CLOUDFLARE_API_TOKEN from the environment."; return 0; fi
  if WR whoami >/dev/null 2>&1; then say "Already logged in to Cloudflare."; return 0; fi
  say "You are not logged in. Starting the device login: open the URL it prints in any browser, sign in to YOUR Cloudflare account and approve."
  WR login --device
}

if [ "$SELF" = 1 ]; then
  login_if_needed
  mkdir -p .deploy; chmod 700 .deploy
  F=".deploy/$NAME.setup.env"
  node scripts/cf-api-deploy.mjs init --secrets-file "$F" --from-env
  for n in "${META_SECRETS[@]}"; do
    if ! grep -q "^$n=." "$F"; then
      if [ -t 0 ]; then
        printf '%s (input hidden, empty = skip, add later with scripts/cf-api-deploy.mjs rotate): ' "$n" >&2
        IFS= read -rs v || true; printf '\n' >&2
        [ -z "$v" ] || printf '%s=%s\n' "$n" "$v" >> "$F"
        v=""
      else
        say "  no $n in the environment and no terminal: skipped (add it later with scripts/cf-api-deploy.mjs rotate)"
      fi
    fi
  done
  NONCE="$(sed -n 's/^SETUP_NONCE=//p' "$F" | head -1)"
  say "Deploying Worker '$NAME' with only a one-time setup nonce (no secret bindings)..."
  OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
  WR deploy "${NAME_ARGS[@]}" --var "SETUP_NONCE:$NONCE" 2>&1 | tee "$OUT"
  URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$OUT" | head -1 || true)"
  [ -n "$URL" ] || die "could not find the workers.dev URL in the wrangler output"
  sleep 3
  node scripts/cf-api-deploy.mjs provision --url "$URL" --secrets-file "$F"
  say "Done. Setup is locked. Webhook callback URL: $URL/api/webhook"
  say "  Your values stay in $F (mode 0600, git-ignored). Later changes: node scripts/cf-api-deploy.mjs rotate --url $URL --admin-token-file $F --secrets-file <file with the new KEY=VALUE lines>"
  exit 0
fi

if [ -n "$ONLY" ]; then
  login_if_needed
  ask_secret "$ONLY" "$ONLY"
  exit 0
fi

login_if_needed

say "Deploying Worker '$NAME' (free plan; workers.dev URL; no custom domain)..."
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
WR deploy "${NAME_ARGS[@]}" 2>&1 | tee "$OUT"
URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$OUT" | head -1 || true)"

if [ "$NOSECRETS" = 0 ]; then
  mkdir -p .deploy; chmod 700 .deploy
  F=".deploy/$NAME.secrets.env"
  if [ -s "$F" ]; then
    say "Re-using generated tokens from $F"
  else
    : > "$F"; chmod 600 "$F"
    for n in "${GEN_SECRETS[@]}"; do printf '%s=%s\n' "$n" "$(openssl rand -hex 24)" >> "$F"; done
  fi
  say "Uploading generated tokens with 'wrangler secret put' (stdin)..."
  for n in "${GEN_SECRETS[@]}"; do
    v="$(sed -n "s/^$n=//p" "$F" | head -1)"
    put_secret "$n" "$v"
  done
  v=""
  say "Meta values (never leave this machine except to Cloudflare):"
  for n in "${META_SECRETS[@]}"; do ask_secret "$n" "$n"; done
fi

say
say "Done. Worker: ${URL:-<see the wrangler output above>}"
[ -n "$URL" ] && say "  Meta webhook callback URL:  $URL/api/webhook"
[ -n "$URL" ] && say "  Agent MCP endpoint:         $URL/mcp   (Authorization: Bearer <MCP_TOKEN>)"
[ -n "$URL" ] && say "  Staff console:              $URL/admin (token: ADMIN_TOKEN)"
[ "$NOSECRETS" = 0 ] && say "  Your generated tokens are in .deploy/$NAME.secrets.env (mode 0600, git-ignored). Never paste them into chat or commit them."
say "  Next: bash scripts/smoke.sh ${URL:-<url>}   |   docs/DEPLOY.md."
