#!/usr/bin/env bash
# Deploy WAB bot to YOUR OWN Cloudflare account (Workers + a SQLite Durable Object).
#
#   bash scripts/deploy-cloudflare.sh [--slug <business> | --name <worker-name>] [--subdomain <name>] [--dry-run] [--no-secrets] [--update]
#     --slug acme gives the Worker the name wab-bot-acme: one Worker per bot, so a second bot never lands on the first one.
#     Before deploying, the script checks whether a Worker of that name already exists in the account. If it does and this folder did
#     not create it (no .deploy/<name>.* file), it REFUSES: that Worker may be another bot. --update deploys over it on purpose.
#   bash scripts/deploy-cloudflare.sh --set-secret WA_APP_SECRET        # add/rotate ONE secret later (hidden prompt)
#   bash scripts/deploy-cloudflare.sh --self-provision [--name N]       # NO `wrangler secret put`: the Worker receives its secrets once, itself
#
# What it does, in order:
#   1. checks Node >= 20 and installs dependencies (npm ci) if needed
#   2. checks you are logged in; if not, runs `wrangler login --device` (a URL + code you approve in ANY browser; the
#      script never sees your password and never creates an account: log in to a Cloudflare account that YOU own, see docs/CLOUDFLARE.md)
#      With CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID exported, it then makes sure the account has a workers.dev subdomain (a brand-new
#      account has none and `wrangler deploy` cannot ask in a non-interactive shell): reads it, and only if none is registered registers
#      "<worker-name>-<random>" (or --subdomain NAME). An existing subdomain is never changed. Without those variables wrangler asks itself.
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

NAME=""; SLUG=""; SUBDOMAIN=""; DRY=0; NOSECRETS=0; ONLY=""; SELF=0; UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --slug) SLUG="${2:?--slug needs a value}"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --subdomain) SUBDOMAIN="${2:?--subdomain needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-secrets) NOSECRETS=1; shift ;;
    --self-provision) SELF=1; shift ;;
    --set-secret) ONLY="${2:?--set-secret needs a secret name}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
# Names (never values) of required secrets that were skipped or failed to upload. Any entry makes the script exit non-zero.
NOT_SET=()
not_set() { NOT_SET+=("$1"); }
fail_if_not_set() { # context
  [ "${#NOT_SET[@]}" -eq 0 ] && return 0
  printf 'ERROR: %s, but these required secrets were NOT set: %s\n' "$1" "${NOT_SET[*]}" >&2
  return 1
}
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
WR() { WRANGLER_SEND_METRICS="${WRANGLER_SEND_METRICS:-false}" npx --no-install wrangler "$@"; }

[ -f wrangler.toml ] && [ -f src/worker.ts ] || die "run this from the template folder (wrangler.toml and src/worker.ts not found)"
command -v node >/dev/null || die "Node.js >= 20 is required"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js >= 20 is required"
command -v openssl >/dev/null || die "openssl is required (used to generate random tokens)"

TOML_NAME="$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
if [ -n "$SLUG" ]; then
  [ -z "$NAME" ] || die "use --slug OR --name, not both"
  [[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] || die "--slug must be lowercase letters, digits and dashes (got '$SLUG')"
  NAME="wab-bot-$SLUG"
fi
NAME="${NAME:-$TOML_NAME}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$ ]] || die "worker name must be lowercase letters, digits and dashes (got '$NAME')"
NAME_ARGS=(--name "$NAME")
[ -z "$SUBDOMAIN" ] || [[ "$SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "--subdomain must be 1-63 lowercase letters, digits and dashes, not starting or ending with a dash (got '$SUBDOMAIN')"

GEN_SECRETS=(MCP_TOKEN ADMIN_TOKEN CRON_SECRET WA_VERIFY_TOKEN)
META_SECRETS=(WA_APP_SECRET WA_ACCESS_TOKEN)
ALLOWED=" ${GEN_SECRETS[*]} ${META_SECRETS[*]} WAKE_KEY WAKE_URL XAI_API_KEY ELEVENLABS_API_KEY ADMIN_MCP_TOKEN ALERT_WEBHOOK_KEY "

if [ "$DRY" = 1 ] && [ "$SELF" = 1 ]; then
  say "DRY RUN (no Cloudflare call, nothing written). Self-provisioning plan for Worker '$NAME':"
  say "  1. npm ci (if node_modules is missing); wrangler whoami || wrangler login --device; with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID: register a workers.dev subdomain if the account has none"
  say "  2. node scripts/cf-api-deploy.mjs init  -> .deploy/$NAME.setup.env (mode 0600): random SETUP_NONCE and bridge tokens; Meta values from exported WA_APP_SECRET / WA_ACCESS_TOKEN"
  say "  3. wrangler deploy ${NAME_ARGS[*]} --var SETUP_NONCE:<random>   (a plain-text var; NO secret bindings)"
  say "  4. node scripts/cf-api-deploy.mjs provision  -> POST /api/setup once over HTTPS; the Worker stores the values in its Durable Object and locks setup"
  exit 0
fi
if [ "$DRY" = 1 ]; then
  say "DRY RUN (no Cloudflare call, nothing written). Plan for Worker '$NAME':"
  say "  1. npm ci (if node_modules is missing)"
  say "  2. wrangler whoami || wrangler login --device"
  say "  3. with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported: read the account's workers.dev subdomain; register one only if none exists"
  say "  4. wrangler deploy ${NAME_ARGS[*]}"
  say "  5. generate + wrangler secret put: ${GEN_SECRETS[*]} (values saved to .deploy/$NAME.secrets.env, mode 0600)"
  say "  6. prompt + wrangler secret put: ${META_SECRETS[*]} (hidden input, stdin only)"
  exit 0
fi

[ -d node_modules ] || { say "Installing dependencies (npm ci)..."; npm ci --no-audit --no-fund >/dev/null; }

# Put one secret: value on STDIN only, never in argv, never echoed.
put_secret() { # name value
  [[ "$ALLOWED" == *" $1 "* ]] || die "unknown secret name: $1"
  if printf '%s' "$2" | WR secret put "$1" "${NAME_ARGS[@]}" >/dev/null; then
    say "  set $1"
  else
    say "  FAILED to set $1 (retry with: bash scripts/deploy-cloudflare.sh --set-secret $1)"
    not_set "$1"
  fi
}

# Hidden prompt (value stays in this shell only). Uses the exported variable of the same name when present.
ask_secret() { # name label
  local n="$1" v="${!1:-}"
  if [ -z "$v" ]; then
    [ -t 0 ] || { say "  skipped $n (no terminal; export $n or run: bash scripts/deploy-cloudflare.sh --set-secret $n)"; not_set "$n"; return 0; }
    printf '%s (input hidden, empty = skip): ' "$2" >&2
    IFS= read -rs v || true
    printf '\n' >&2
  fi
  [ -n "$v" ] || { say "  skipped $n (set it later with: bash scripts/deploy-cloudflare.sh --set-secret $n)"; not_set "$n"; return 0; }
  put_secret "$n" "$v"
  v=""
}

login_if_needed() {
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then say "Using CLOUDFLARE_API_TOKEN from the environment."; return 0; fi
  if WR whoami >/dev/null 2>&1; then say "Already logged in to Cloudflare."; return 0; fi
  say "You are not logged in. Starting the device login: open the URL it prints in any browser, sign in to YOUR Cloudflare account and approve."
  WR login --device
}

# A brand-new account has no workers.dev subdomain and `wrangler deploy` then cannot finish without asking. With an API token and the
# account id in the environment, check it through the API (never changes an existing one). Otherwise wrangler handles it itself.
ensure_subdomain() {
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || say "CLOUDFLARE_ACCOUNT_ID is not set: not checking the workers.dev subdomain. On a brand-new account, export it (or run: node scripts/cf-api-deploy.mjs subdomain --name $NAME) before deploying."
    return 0
  fi
  local sub_args=(--name "$NAME"); [ -z "$SUBDOMAIN" ] || sub_args+=(--subdomain "$SUBDOMAIN")
  node scripts/cf-api-deploy.mjs subdomain "${sub_args[@]}" || die "could not make sure the account has a workers.dev subdomain (see above); nothing was deployed"
}

# One Worker per bot. A Worker of this name that this folder did not create may be ANOTHER bot (each has its own conversations, tokens
# and number): refuse unless --update. "Created here" = a .deploy/<name>.secrets.env, .setup.env or .owner file in this folder.
owned_here() { [ -f ".deploy/$NAME.secrets.env" ] || [ -f ".deploy/$NAME.setup.env" ] || [ -f ".deploy/$NAME.owner" ]; }
worker_exists() { # prints exists | absent | unknown
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    local rc=0; node scripts/cf-api-deploy.mjs check-name --name "$NAME" >/dev/null 2>&1 || rc=$?
    case "$rc" in 0) echo absent ;; 3) echo exists ;; *) echo unknown ;; esac; return 0
  fi
  local out rc=0; out="$(WR deployments list --name "$NAME" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then echo exists
  elif printf '%s' "$out" | grep -qiE '10007|does not exist|not found'; then echo absent
  else echo unknown; fi
}
check_name() {
  [ "$NAME" != "$TOML_NAME" ] || [ -n "$SLUG" ] || say "Note: using the default Worker name '$NAME'. For a second bot in the same Cloudflare account use --slug <business> (wab-bot-<business>)."
  owned_here && return 0
  [ "$UPDATE" = 1 ] && { say "--update: deploying over the existing Worker '$NAME' on purpose."; return 0; }
  case "$(worker_exists)" in
    absent) return 0 ;;
    exists) die "a Worker named '$NAME' already exists in this Cloudflare account and was not created from this folder: it may be ANOTHER bot. Nothing was deployed. Pick a unique name (--slug <business>), or pass --update if '$NAME' is this bot." ;;
    *) die "could not check whether a Worker named '$NAME' already exists (see the login above). Nothing was deployed. Pass --update only if you are sure '$NAME' is this bot or does not exist yet." ;;
  esac
}
mark_owned() { mkdir -p .deploy; chmod 700 .deploy; printf 'worker=%s\ncreated_from_this_folder=%s\n' "$NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ".deploy/$NAME.owner"; }

if [ "$SELF" = 1 ]; then
  login_if_needed
  ensure_subdomain
  check_name
  mkdir -p .deploy; chmod 700 .deploy
  F=".deploy/$NAME.setup.env"
  node scripts/cf-api-deploy.mjs init --secrets-file "$F" --from-env
  for n in "${META_SECRETS[@]}"; do
    if ! grep -q "^$n=." "$F"; then
      if [ -t 0 ]; then
        printf '%s (input hidden, empty = skip, add later with scripts/cf-api-deploy.mjs rotate): ' "$n" >&2
        IFS= read -rs v || true; printf '\n' >&2
        if [ -n "$v" ]; then printf '%s=%s\n' "$n" "$v" >> "$F"; else say "  skipped $n (add it later with scripts/cf-api-deploy.mjs rotate)"; not_set "$n"; fi
        v=""
      else
        say "  no $n in the environment and no terminal: skipped (add it later with scripts/cf-api-deploy.mjs rotate)"
        not_set "$n"
      fi
    fi
  done
  NONCE="$(sed -n 's/^SETUP_NONCE=//p' "$F" | head -1)"
  say "Deploying Worker '$NAME' with only a one-time setup nonce (no secret bindings)..."
  OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
  WR deploy "${NAME_ARGS[@]}" --var "SETUP_NONCE:$NONCE" 2>&1 | tee "$OUT"
  mark_owned
  URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$OUT" | head -1 || true)"
  [ -n "$URL" ] || die "could not find the workers.dev URL in the wrangler output"
  sleep 3
  node scripts/cf-api-deploy.mjs provision --url "$URL" --secrets-file "$F"
  if ! fail_if_not_set "Setup was provisioned and is now locked"; then
    printf '  Add them with: node scripts/cf-api-deploy.mjs rotate --url %s --admin-token-file %s --secrets-file <file with the missing KEY=VALUE lines>\n' "$URL" "$F" >&2
    exit 1
  fi
  say "Done. Setup is locked. Webhook callback URL: $URL/api/webhook"
  say "  Your values stay in $F (mode 0600, git-ignored). Later changes: node scripts/cf-api-deploy.mjs rotate --url $URL --admin-token-file $F --secrets-file <file with the new KEY=VALUE lines>"
  exit 0
fi

if [ -n "$ONLY" ]; then
  login_if_needed
  ask_secret "$ONLY" "$ONLY"
  fail_if_not_set "--set-secret did not complete" || exit 1
  exit 0
fi

login_if_needed
ensure_subdomain
check_name

say "Deploying Worker '$NAME' (free plan; workers.dev URL; no custom domain)..."
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
WR deploy "${NAME_ARGS[@]}" 2>&1 | tee "$OUT"
mark_owned
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

if ! fail_if_not_set "The Worker was deployed${URL:+ to $URL}"; then
  printf '  Set each one with: bash scripts/deploy-cloudflare.sh --name %s --set-secret <NAME>   (until then the matching endpoints fail closed)\n' "$NAME" >&2
  exit 1
fi

say
say "Done. Worker: ${URL:-<see the wrangler output above>}"
[ -n "$URL" ] && say "  Meta webhook callback URL:  $URL/api/webhook"
[ -n "$URL" ] && say "  Agent MCP endpoint:         $URL/mcp   (Authorization: Bearer <MCP_TOKEN>)"
[ -n "$URL" ] && say "  Team inbox:                 $URL/admin (staff sign in with a one-time code: POST /api/admin {\"action\":\"staff_invite\"})"
[ "$NOSECRETS" = 0 ] && say "  Your generated tokens are in .deploy/$NAME.secrets.env (mode 0600, git-ignored). Never paste them into chat or commit them."
say "  Next: bash scripts/smoke.sh ${URL:-<url>}   |   docs/DEPLOY.md."
