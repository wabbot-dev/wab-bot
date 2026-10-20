#!/usr/bin/env bash
# Proves the hygiene detectors fire: builds a throwaway git repo in a temp dir, plants one fake offender per detector
# (every value is synthetic) and checks the scan fails and names each one. Needs only bash and git. No network.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts"; cp "$HERE/hygiene-scan.sh" "$TMP/scripts/hygiene-scan.sh"
cd "$TMP"; git init -q . ; git config user.email t@example.invalid; git config user.name t
a=A; b=KIA   # split so this file itself never contains a complete fake key
{
  echo "x = ${a}${b}ABCDEFGHIJKLMNOP"
  echo "t = ghp_$(printf 'a%.0s' $(seq 1 30))"
  echo "k = sk-$(printf 'b%.0s' $(seq 1 30))"
  echo "mail owner@realdomain.org"
  echo "path /home/someone/project/file"
  echo "call +4915112345678"
  echo "dial +44 20 7946 0958"
  echo "id wacid.$(printf '\004\030\01317005551234\025\002\000' | base64 | tr -d '\n')"
  echo "an owner called Zebediah Quux"
  echo "a client named Gloriana Vex"
  echo "account $(printf 'ab12%.0s' $(seq 1 8))"
  echo "auth Bearer $(printf 'q%.0s' $(seq 1 12))$(printf 'r%.0s' $(seq 1 12))"
  echo "api_key = \"$(printf 'm%.0s' $(seq 1 12))$(printf 'n%.0s' $(seq 1 14))\""
  echo "hosted on Vercel"
  echo "uses gpt-realtime voices"
  echo "e = sk_$(printf 'd%.0s' $(seq 1 30))"
  echo "see /workspace/notes"
  echo "CLOUDFLARE_API_TOKEN=$(printf 'c%.0s' $(seq 1 40))"
} > offenders.txt
git add -A; git commit -qm t
fail=0
# the names come from an untracked multi-line file: comments ignored, "cs:" lines case-sensitive, history is checked too
printf '# people\nzebediah|quux\n\n# clients\ncs:Gloriana\n' > .hygiene-names
out=$(bash scripts/hygiene-scan.sh  2>&1); rc=$?
echo "$out" | grep -q "HYGIENE HISTORY: a name" && echo "ok   history match reported" || { echo "FAIL history match not reported"; fail=1; }
echo "$out" | grep -q "HYGIENE HISTORY: 1 call id" && echo "ok   call id in history reported" || { echo "FAIL call id in history not reported"; fail=1; }
HYGIENE_HISTORY=strict bash scripts/hygiene-scan.sh >/dev/null 2>&1 && { echo "FAIL strict history mode passed"; fail=1; } || echo "ok   strict history mode fails"
[ $rc -ne 0 ] || { echo "SELFTEST FAIL: scan passed on planted offenders"; fail=1; }
for need in "AWS access key id" "GitHub token" "OpenAI/xAI/Stripe style key" "email address" "local path" "phone-like number" "personal or business name" "bearer token literal" "API key assignment" "stale host reference" "out-of-scope voice provider" "sk_ style API key" "internal tooling name" "Cloudflare API token value" "account or zone id" "formatted phone number" "call id with embedded phone number"; do
  echo "$out" | grep -q "$need" && echo "ok   detector fired: $need" || { echo "FAIL detector did not fire: $need"; fail=1; }
done
# a clean repo passes
cd "$TMP" && git rm -q offenders.txt && git commit -qm clean
bash scripts/hygiene-scan.sh && echo "ok   clean tree passes" || { echo "FAIL clean tree failed"; fail=1; }
exit $fail
