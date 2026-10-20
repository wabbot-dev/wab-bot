#!/usr/bin/env bash
# Unauthenticated smoke checks. Usage: scripts/smoke.sh https://<worker>.<subdomain>.workers.dev
# Sends no secrets. Exit code 1 if any check fails.
#
# Right after a deploy a new workers.dev route can take a while to answer correctly, so each check is retried with
# backoff (2s, 4s, 8s, ... capped at SMOKE_RETRY_MAX_DELAY seconds) until it passes or the shared retry budget of
# SMOKE_RETRY_SECONDS (default 180, about 3 minutes, for the whole run) is used up. SMOKE_RETRY_SECONDS=0 checks once.
set -u
BASE="${1:?usage: smoke.sh BASE_URL}"
BASE="${BASE%/}"
RETRY_SECONDS="${SMOKE_RETRY_SECONDS:-180}"
MAX_DELAY="${SMOKE_RETRY_MAX_DELAY:-30}"
[[ "$RETRY_SECONDS" =~ ^[0-9]+$ ]] || { echo "SMOKE_RETRY_SECONDS must be a whole number of seconds (got '$RETRY_SECONDS')" >&2; exit 2; }
[[ "$MAX_DELAY" =~ ^[1-9][0-9]*$ ]] || { echo "SMOKE_RETRY_MAX_DELAY must be a positive whole number of seconds (got '$MAX_DELAY')" >&2; exit 2; }
DEADLINE=$(( SECONDS + RETRY_SECONDS ))
fail=0
failed=()
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
check() { # name expected curl-args...
  local name="$1" expected="$2" got delay=2 tries=1 left
  shift 2
  while :; do
    got="$(code "$@")"
    if [ "$got" = "$expected" ]; then
      if [ "$tries" -gt 1 ]; then echo "PASS $name ($got, after $tries attempts)"; else echo "PASS $name ($got)"; fi
      return 0
    fi
    left=$(( DEADLINE - SECONDS ))
    if [ "$left" -le 0 ]; then
      echo "FAIL $name (expected $expected, got $got; $tries attempt(s), retry budget of ${RETRY_SECONDS}s used up)"
      fail=1; failed+=("$name")
      return 0
    fi
    [ "$delay" -gt "$left" ] && delay="$left"
    echo "  retry $name in ${delay}s (expected $expected, got $got)"
    sleep "$delay"
    tries=$(( tries + 1 ))
    delay=$(( delay * 2 )); [ "$delay" -gt "$MAX_DELAY" ] && delay="$MAX_DELAY"
  done
}
check "GET /"                              200 "$BASE/"
check "GET /api/health"                    200 "$BASE/api/health"
check "GET /api/admin  (no token)"         401 "$BASE/api/admin"
check "POST /mcp       (no token)"         401 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/mcp"
check "GET /api/webhook wrong verify token" 403 "$BASE/api/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong-token&hub.challenge=1"
check "GET /api/cron/retry-wakes (no token)" 401 "$BASE/api/cron/retry-wakes"
check "POST /api/webhook unsigned"         401 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/webhook"
check "GET /api/admin/meta-setup (off by default)" 404 "$BASE/api/admin/meta-setup"
check "POST /api/admin/media-selftest (off by default)" 404 -X POST -d 'x' "$BASE/api/admin/media-selftest?kind=audio"
check "POST /api/admin/voice-selftest (off by default)" 404 -X POST -d 'x' "$BASE/api/admin/voice-selftest?lang=en"
check "DELETE /api/admin/conversations/<id> (no token)" 401 -X DELETE "$BASE/api/admin/conversations/c_00000000000000000000"
if [ "$fail" != 0 ]; then
  echo "SMOKE FAILED: ${#failed[@]} check(s) still wrong after retrying for up to ${RETRY_SECONDS}s (SMOKE_RETRY_SECONDS):" >&2
  printf '  - %s\n' "${failed[@]}" >&2
  echo "  If this is a brand-new deploy, wait a minute and re-run, or raise SMOKE_RETRY_SECONDS; see docs/TROUBLESHOOTING.md." >&2
fi
exit $fail
