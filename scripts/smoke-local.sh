#!/usr/bin/env bash
# Offline smoke test: starts `wrangler dev --local` (workerd + a local SQLite Durable Object, no Cloudflare login, no deploy,
# no Meta call) with FRESH RANDOM FAKE secrets, then checks the webhook handshake, signature rejection, a signed POST,
# claim over MCP and the admin overview. The fake secrets live only in .dev.vars (git-ignored) and are deleted on exit.
# Usage: scripts/smoke-local.sh [port]
set -Eeuo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8799}"
BASE="http://127.0.0.1:$PORT"
export WRANGLER_SEND_METRICS=false CI=1
rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))'; }
VERIFY="$(rnd)"; APP="$(rnd)"; MCP="$(rnd)"; ADMIN="$(rnd)"; CRON="$(rnd)"
umask 077
cat > .dev.vars <<VARS
WA_VERIFY_TOKEN=$VERIFY
WA_APP_SECRET=$APP
MCP_TOKEN=$MCP
ADMIN_TOKEN=$ADMIN
CRON_SECRET=$CRON
LAUNCH_MODE=test
WA_PHONE_NUMBER_IDS=1000000000001
VARS
LOG="$(mktemp)"
STATE_DIR="$(mktemp -d)"   # fresh local Durable Object storage for every run
cleanup() {
  # stop wrangler and the workerd it spawned (matched by this script'"'"'s port), then remove the fake secrets
  pkill -f "wrangler.* dev --local --port $PORT" 2>/dev/null || true
  pkill -f "socket-addr=entry=127.0.0.1:$PORT" 2>/dev/null || true
  rm -rf .dev.vars "$LOG" "$STATE_DIR"
}
trap cleanup EXIT
npx wrangler dev --local --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE_DIR" >"$LOG" 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null "$BASE/" && break; sleep 1; done
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1 (expected $2, got $3)"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

check "GET /"                                   200 "$(code "$BASE/")"
check "handshake: right token echoes challenge" "424242" "$(curl -s --max-time 20 "$BASE/api/webhook?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=424242")"
check "handshake: wrong token"                  403 "$(code "$BASE/api/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong-token&hub.challenge=1")"
PAYLOAD='{"object":"whatsapp_business_account","entry":[{"id":"2000000000002","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15551000000","phone_number_id":"1000000000001"},"contacts":[{"profile":{"name":"Smoke Customer"},"wa_id":"15550001111"}],"messages":[{"id":"wamid.SMOKE1","from":"15550001111","type":"text","timestamp":"1760000000","text":{"body":"hello from the smoke test"}}]}}]}]}'
SIG="sha256=$(APP="$APP" PAYLOAD="$PAYLOAD" node -e 'const c=require("crypto");process.stdout.write(c.createHmac("sha256",process.env.APP).update(process.env.PAYLOAD).digest("hex"))')"
check "POST unsigned"                           401 "$(code -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$BASE/api/webhook")"
check "POST wrong signature"                    401 "$(code -X POST -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' -d "$PAYLOAD" "$BASE/api/webhook")"
check "POST signed"                             200 "$(code -X POST -H 'Content-Type: application/json' -H "X-Hub-Signature-256: $SIG" -d "$PAYLOAD" "$BASE/api/webhook")"
check "POST signed again (idempotent)"          200 "$(code -X POST -H 'Content-Type: application/json' -H "X-Hub-Signature-256: $SIG" -d "$PAYLOAD" "$BASE/api/webhook")"
OV="$(curl -s --max-time 20 -H "Authorization: Bearer $ADMIN" "$BASE/api/admin")"
check "admin: one conversation, one message"    "1/1" "$(printf '%s' "$OV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.conversations.length+"/"+j.conversations.filter(c=>c.unhandled===1).length)})')"
check "admin: no token"                         401 "$(code "$BASE/api/admin")"
CID="$(printf '%s' "$OV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).conversations[0].id))')"
MCPH=(-H "Authorization: Bearer $MCP" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
check "mcp: no token"                           401 "$(code -X POST -d '{}' "$BASE/mcp")"
check "mcp: tools/list"                         200 "$(code -X POST "${MCPH[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/mcp")"
CLAIM="$(curl -s --max-time 20 -X POST "${MCPH[@]}" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"claim_conversation\",\"arguments\":{\"conversation_id\":\"$CID\"}}}" "$BASE/mcp")"
check "mcp: claim_conversation ok"              true "$(printf '%s' "$CLAIM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(JSON.parse(s).result.content[0].text).ok))')"
OVW="$(curl -s --max-time 20 -X POST "${MCPH[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_overview","arguments":{}}}' "$BASE/mcp")"
check "mcp: get_overview read-only, no secret values" true "$(printf '%s' "$OVW" | MCPV="$MCP" ADMV="$ADMIN" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(JSON.parse(s).result.content[0].text);console.log(t.read_only===true&&typeof t.conversations.pending==="number"&&!s.includes(process.env.MCPV)&&!s.includes(process.env.ADMV))})')"
check "erase: no token"                         401 "$(code -X DELETE "$BASE/api/admin/conversations/$CID")"
check "erase: unknown id"                       404 "$(code -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/api/admin/conversations/c_00000000000000000000")"
check "erase: one conversation"                 200 "$(code -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/api/admin/conversations/$CID")"
check "erase: gone afterwards"                  404 "$(code -H "Authorization: Bearer $ADMIN" "$BASE/api/admin?conversation=$CID")"
check "meta-setup route off by default"         404 "$(code -H "Authorization: Bearer $ADMIN" "$BASE/api/admin/meta-setup")"
echo
if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED (wrangler log tail below)"; tail -n 25 "$LOG"; fi
exit "$fail"
