#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Legacy rollback verification failed: %s\n' "$*" >&2
  exit 1
}

for command_name in curl jq; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

ROLLBACK_APP_URL="${ROLLBACK_APP_URL:-http://127.0.0.1:3100}"
[[ "$ROLLBACK_APP_URL" =~ ^http://(127\.0\.0\.1|rollback_rehearsal_app)(:[0-9]+)?$ ]] || fail "application URL is outside the local rollback rehearsal boundary"

temporary_directory="$(mktemp -d /tmp/business-finlynq-legacy-verify.XXXXXX)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

headers_path="$temporary_directory/headers"
body_path="$temporary_directory/body"
user_agent="Business-Finlynq-Legacy-Rollback-Rehearsal/1"

health_status="$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
  --dump-header "$headers_path" --output "$body_path" --write-out '%{http_code}' \
  "$ROLLBACK_APP_URL/api/health")"
[[ "$health_status" == "200" ]] || fail "readiness returned HTTP $health_status"
jq -e '.status == "ready"' "$body_path" >/dev/null || fail "readiness payload is invalid"
grep -Eiq '^cache-control:.*no-store' "$headers_path" || fail "readiness is cacheable"

demo_status="$(curl --silent --show-error --connect-timeout 5 --max-time 15 --max-redirs 0 \
  --user-agent "$user_agent" --dump-header "$headers_path" --output /dev/null --write-out '%{http_code}' \
  "$ROLLBACK_APP_URL/try-demo?next=/app")"
[[ "$demo_status" == "303" ]] || fail "disabled demo boundary returned HTTP $demo_status"
grep -Eiq '^location:.*\/login\?demoError=disabled([#[:space:]]|$)' "$headers_path" \
  || fail "legacy rollback did not keep demo login disabled"
if grep -Eiq '^set-cookie:.*business_finlynq_session=' "$headers_path"; then
  fail "disabled demo boundary issued a session cookie"
fi

printf '%s\n' "Legacy f8485 rollback readiness and disabled-login boundary verified"
