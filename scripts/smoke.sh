#!/usr/bin/env bash
# Unauthenticated smoke checks. Usage: scripts/smoke.sh https://<worker>.<subdomain>.workers.dev [--wait SECONDS]
# Sends no secrets. Exit code 0 only if every check passes, 1 if any check still fails when the wait is over.
#
# A new Worker, and a new workers.dev subdomain, can take a few minutes to answer (TLS errors, 404 or 5xx at first), so the whole
# suite is retried every SMOKE_INTERVAL seconds (default 10) until it passes or --wait seconds (default 300) have passed.
# --wait 0 runs it once. A check that fails for a real reason is therefore only reported after the wait; use --wait 0 on a
# Worker that has been up for a while.
set -u
BASE=""; WAIT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="${2:?--wait needs a number of seconds}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$BASE" ] || { echo "usage: smoke.sh BASE_URL [--wait SECONDS]" >&2; exit 2; }; BASE="$1"; shift ;;
  esac
done
[ -n "$BASE" ] || { echo "usage: smoke.sh BASE_URL [--wait SECONDS]" >&2; exit 2; }
case "$WAIT" in ''|*[!0-9]*) echo "--wait must be a whole number of seconds" >&2; exit 2 ;; esac
INTERVAL="${SMOKE_INTERVAL:-10}"
case "$INTERVAL" in ''|*[!0-9]*|0) echo "SMOKE_INTERVAL must be a positive whole number of seconds" >&2; exit 2 ;; esac
BASE="${BASE%/}"
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1 (expected $2, got $3)"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
run_checks() {
  check "GET /"                              200 "$(code "$BASE/")"
  check "GET /api/health"                    200 "$(code "$BASE/api/health")"
  check "GET /api/admin  (no token)"         401 "$(code "$BASE/api/admin")"
  check "POST /mcp       (no token)"         401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/mcp")"
  check "GET /api/webhook wrong verify token" 403 "$(code "$BASE/api/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong-token&hub.challenge=1")"
  check "GET /api/cron/retry-wakes (no token)" 401 "$(code "$BASE/api/cron/retry-wakes")"
  check "POST /api/webhook unsigned"         401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/webhook")"
  check "GET /api/admin/meta-setup (off by default)" 404 "$(code "$BASE/api/admin/meta-setup")"
  check "DELETE /api/admin/conversations/<id> (no token)" 401 "$(code -X DELETE "$BASE/api/admin/conversations/c_00000000000000000000")"
}

attempt=1
while :; do
  out="$(run_checks)"
  if printf '%s\n' "$out" | grep -q '^FAIL'; then fail=1; else fail=0; fi
  if [ "$fail" = 0 ] || [ "$SECONDS" -ge "$WAIT" ]; then break; fi
  echo "attempt $attempt: $(printf '%s\n' "$out" | grep -c '^FAIL') check(s) not passing yet; retrying in ${INTERVAL}s (${SECONDS}s of ${WAIT}s used)"
  attempt=$((attempt + 1)); sleep "$INTERVAL"
done
printf '%s\n' "$out"
if [ "$fail" = 0 ]; then echo "SMOKE PASS (attempt $attempt, ${SECONDS}s)"; else echo "SMOKE FAIL after $attempt attempt(s), ${SECONDS}s: see the FAIL lines above"; fi
exit "$fail"
