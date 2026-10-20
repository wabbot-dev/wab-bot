#!/usr/bin/env bash
# Repository hygiene scan: fails (exit 1) if a tracked file looks like it contains a secret, a personal email address,
# a local path, a personal/company name (from your own private list), a stale host reference, or an unexpected phone-number-like string.
# Runs on tracked files only (git ls-files), no network. Documented placeholders and the reserved fictional
# 555-01xx / 15550000xxx test numbers are allowed.
#   bash scripts/hygiene-scan.sh
# scripts/hygiene-selftest.sh proves the detectors fire.
set -u
cd "$(dirname "$0")/.."
files=$(git ls-files | grep -v -E '(^|/)package-lock\.json$')
fail=0
check() { # name, regex, optional allow-regex, optional grep flags
  local name="$1" re="$2" allow="${3:-}" flags="${4:--nIE}" out
  out=$(echo "$files" | xargs -r grep -H "$flags" -- "$re" 2>/dev/null | grep -v -F 'scripts/hygiene-scan.sh' | grep -v -F 'scripts/hygiene-selftest.sh' || true)
  if [ -n "$allow" ] && [ -n "$out" ]; then
    out=$(echo "$out" | grep -vE -- "$allow"); local rc=$?
    if [ $rc -gt 1 ]; then echo "HYGIENE ERROR: bad allow-pattern for $name"; fail=1; fi
  fi
  if [ -n "$out" ]; then echo "HYGIENE FAIL: $name"; echo "$out" | sed 's/^/   /' | cut -c1-200; fail=1; fi
}
check "private key block"            '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "AWS access key id"            'AKIA[0-9A-Z]{16}'
check "GitHub token"                 '(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}'
check "Slack token"                  'xox[abprs]-[A-Za-z0-9-]{10,}'
check "OpenAI/xAI/Stripe style key"  '\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}|\bxai-[A-Za-z0-9]{20,}'
check "sk_ style API key"            '\bsk_[A-Za-z0-9]{24,}'
check "webhook signing secret"       'whsec_[A-Za-z0-9+/=]{8,}'
check "Meta access token"            '\bEAA[A-Za-z0-9]{40,}'
check "Cloudflare API token value"   'CLOUDFLARE_API_TOKEN["'\'']?[:=] *["'\'']?[A-Za-z0-9_-]{30,}'
check "bearer token literal"         '\bBearer +[A-Za-z0-9_.~+/=-]{24,}' '\$\{|<[A-Za-z_ -]+>|\[REDACTED|\.\.\.|x{6,}|your[-_]|example|placeholder|test|fake|abcdefghij'
check "API key assignment"           '(api[_-]?key|apikey|secret|token|password)["'\'']?[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9_+/=-]{24,}["'\'']' 'process\.env|\$\{|your[-_]|example|placeholder|test|fake|x{6,}|0{6,}|<[A-Za-z_ -]+>' '-niIE'
check "JWT"                          'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
check "long hex secret literal"      '(TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*["'\'']?[:=] *["'\''][0-9a-fA-F]{32,}["'\'']'
check "email address"                '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' '@example\.(com|test|invalid|org)|users\.noreply\.github\.com|@types/|@cloudflare/'
check "local path"                   '(/home/[a-z][a-z0-9_-]+/|/Users/[A-Za-z][A-Za-z0-9_-]+/|/workspace/|C:\\Users\\)'
check "phone-like number"            '(\+|\b)[1-9][0-9]{10,13}\b' '15550000[0-9]{3}|15551000000|1555010[0-9]{4}|15559999999|15550999999|100000000000001|phone_number_id|\b[0-9]{10,13}\b[^0-9]*(ms|bytes)|sha256|[0-9a-f]{16,}|0{6}|1{6}|2{6}|3{6}|4{6}|5{6}|9{6}|9990000|1000000000001|2000000000002|123456789012|99123456789'
check "formatted phone number"       '(\+[0-9]{1,3}[ .-]?\(?[0-9]{2,4}\)?[ .-][0-9]{3,4}[ .-][0-9]{3,4}|\([0-9]{3}\) [0-9]{3}-[0-9]{4})' '\+1 555[ -](010|000|100)|\(555\) (010|123)|\+49 70 123 456'
# WhatsApp call ids (wacid.<base64>) carry the caller's phone number inside the base64: decode each one, allow only the fictional 555 numbers.
callid_number() { local id="${1#wacid.}"; echo "$id" | tr '_-' '/+' | base64 -d 2>/dev/null | tr -c '0-9' ' ' | grep -o -E '[0-9]{8,}' | head -n 1; }
callid_real() { case "$(callid_number "$1")" in ""|1555*|555*) return 1;; *) return 0;; esac; }
out=$(echo "$files" | xargs -r grep -H -n -I -o -E 'wacid\.[A-Za-z0-9+/=_-]{16,}' 2>/dev/null | grep -v -F 'scripts/hygiene-s' | while IFS= read -r l; do callid_real "${l##*:wacid.}" && echo "${l%%:wacid.*}: call id with an embedded phone number"; done)
if [ -n "$out" ]; then echo "HYGIENE FAIL: call id with embedded phone number"; echo "$out" | sed 's/^/   /'; fail=1; fi
hist_ids=$(git log --all -p --format= 2>/dev/null | grep -o -E 'wacid\.[A-Za-z0-9+/=_-]{16,}' | sort -u | while IFS= read -r id; do callid_real "$id" && echo x; done | wc -l | tr -d ' ')
if [ "${hist_ids:-0}" -gt 0 ]; then
  echo "HYGIENE HISTORY: $hist_ids call id(s) with an embedded phone number appear in commit diffs"
  [ "${HYGIENE_HISTORY:-}" = strict ] && fail=1
fi
# Personal or business names that must not appear in tracked text, in commit authors/messages or in any commit's diff.
# The list is NOT kept in the repository (it would be a list of the very names it protects). Put the regexes in the
# untracked, git-ignored file .hygiene-names, ONE REGEX PER LINE (ERE; blank lines and lines starting with # are ignored;
# a line starting with "cs:" is matched case-sensitively, every other line case-insensitively). Group the lines by category:
# people (owner, staff, clients and their email handles), companies and projects, places, private infrastructure and test
# names (worker names, mailbox addresses and plus-tags), account or zone ids. Alternatively set HYGIENE_NAMES to one regex.
# Without either, these checks are skipped.
name_lines=""
if [ -n "${HYGIENE_NAMES:-}" ]; then name_lines="$HYGIENE_NAMES"
elif [ -f .hygiene-names ]; then name_lines=$(grep -v -E '^[[:space:]]*(#|$)' .hygiene-names || true); fi
if [ -n "$name_lines" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ci="-niIE"; gi="-i"; re="$line"
    case "$line" in cs:*) ci="-nIE"; gi=""; re="${line#cs:}";; esac
    check "personal or business name"  "$re" '' "$ci"
    # History: commit authors, committers and messages, then any commit whose diff adds or removes a match. History cannot
    # be rewritten silently, so these are warnings; HYGIENE_HISTORY=strict turns them into failures.
    hist=$(git log --all --format='%an %ae %cn %ce %s %b' 2>/dev/null | grep -c $gi -E -- "$re" || true)
    pick=$(git log --all $gi -E -G"$re" --format=%h 2>/dev/null | tr '\n' ' ' || true)
    if [ "${hist:-0}" -gt 0 ] || [ -n "$pick" ]; then
      echo "HYGIENE HISTORY: a name pattern matches commit metadata ($hist) or commit diffs (${pick:-none})"
      [ "${HYGIENE_HISTORY:-}" = strict ] && fail=1
    fi
  done <<< "$name_lines"
fi
# Cloudflare account and zone ids are 32 hex characters; the documented all-sequence test value is allowed.
check "account or zone id (32 hex)" '\b[0-9a-f]{32}\b' '0123456789abcdef0123456789abcdef'
# The Vercel/Next.js version was replaced; no stale host references may remain.
check "stale host reference"         'vercel|next\.js|nextjs|@vercel/|blob store|\.vercel\.app' '' '-niIE'
# Voice calls are Grok Voice (xAI) only; voice-note replies are Workers AI or, by the owner's choice, ElevenLabs (docs/VOICE-REPLIES.md).
# No other voice provider may be mentioned. Allowed: the Workers AI speech-to-text model id (@cf/openai/whisper-...), which runs in the
# owner's own Cloudflare account, not an outside provider.
check "out-of-scope voice provider"  'openai|gpt-realtime|gpt-live' '@cf/openai/whisper' '-niIE'
check "internal tooling name"        '/workspace|\bbus/|rea-src|spike-a|spike-b|mailbox alias' '' '-niIE'
[ $fail -eq 0 ] && echo "hygiene: clean ($(echo "$files" | wc -l) tracked files scanned)"
exit $fail
