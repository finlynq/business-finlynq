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
[[ "$demo_status" == "303" ]] || fail "demo login returned HTTP $demo_status"
session_cookie="$(awk 'tolower($1) == "set-cookie:" { sub(/^[^:]+:[[:space:]]*/, ""); sub(/;.*/, ""); gsub(/\r/, ""); print; exit }' "$headers_path")"
[[ "$session_cookie" =~ ^__Host-business_finlynq_session=[A-Za-z0-9_-]{32,200}$ ]] || fail "demo login did not issue the production host-only cookie"

workspace_status="$(curl --silent --show-error --connect-timeout 5 --max-time 20 \
  --user-agent "$user_agent" --header "Cookie: $session_cookie" \
  --output "$body_path" --write-out '%{http_code}' "$ROLLBACK_APP_URL/app")"
[[ "$workspace_status" == "200" ]] || fail "demo workspace returned HTTP $workspace_status"
grep -Fq "Accounting overview" "$body_path" || fail "demo workspace did not render"

printf '%s\n' "Legacy f8485 rollback readiness and demo session verified"
