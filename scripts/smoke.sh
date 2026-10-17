#!/usr/bin/env bash
# Unauthenticated smoke checks. Usage: scripts/smoke.sh https://<worker>.<subdomain>.workers.dev
# Sends no secrets. Exit code 1 if any check fails.
set -u
BASE="${1:?usage: smoke.sh BASE_URL}"
BASE="${BASE%/}"
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1 (expected $2, got $3)"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
check "GET /"                              200 "$(code "$BASE/")"
check "GET /api/admin  (no token)"         401 "$(code "$BASE/api/admin")"
check "POST /mcp       (no token)"         401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/mcp")"
check "GET /api/webhook wrong verify token" 403 "$(code "$BASE/api/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong-token&hub.challenge=1")"
check "GET /api/cron/retry-wakes (no token)" 401 "$(code "$BASE/api/cron/retry-wakes")"
check "POST /api/webhook unsigned"         401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/webhook")"
check "GET /api/admin/meta-setup (off by default)" 404 "$(code "$BASE/api/admin/meta-setup")"
check "DELETE /api/admin/conversations/<id> (no token)" 401 "$(code -X DELETE "$BASE/api/admin/conversations/c_00000000000000000000")"
exit $fail
