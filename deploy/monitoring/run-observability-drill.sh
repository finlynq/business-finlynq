#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Observability acceptance drill failed: %s\n' "$1" >&2
  exit 1
}

for command_name in awk basename chmod curl date dirname docker grep id install jq mktemp mv promtool rm sleep stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
base_url="${OBSERVABILITY_DRILL_BASE_URL:-https://business.finlynq.com}"
base_url="${base_url%/}"
mutation_url="${OBSERVABILITY_DRILL_MUTATION_URL:-}"
mutation_method="${OBSERVABILITY_DRILL_MUTATION_METHOD:-POST}"
mutation_body_file="${OBSERVABILITY_DRILL_MUTATION_BODY_FILE:-}"
cookie_file="${OBSERVABILITY_DRILL_COOKIE_FILE:-}"
alertmanager_url="${OBSERVABILITY_DRILL_ALERTMANAGER_URL:-http://127.0.0.1:9093}"
alertmanager_url="${alertmanager_url%/}"
metrics_file="${OBSERVABILITY_DRILL_METRICS_FILE:-/var/lib/business-finlynq/observability-drill.prom}"
receipt_file="${OBSERVABILITY_DRILL_RECEIPT_FILE:-}"
evidence_file="${OBSERVABILITY_DRILL_EVIDENCE_FILE:-}"
alert_timeout_seconds="${OBSERVABILITY_DRILL_ALERT_TIMEOUT_SECONDS:-180}"
rule_file="${OBSERVABILITY_DRILL_RULE_FILE:-$repository_root/deploy/monitoring/prometheus-alerts.yml}"
rule_test_file="${OBSERVABILITY_DRILL_RULE_TEST_FILE:-$repository_root/deploy/monitoring/prometheus-alerts.test.yml}"

[[ -n "$mutation_url" && "$mutation_url" == "$base_url"/api/* ]] \
  || fail "mutation URL must be an API path on OBSERVABILITY_DRILL_BASE_URL"
[[ "$mutation_method" =~ ^(POST|PUT|PATCH|DELETE)$ ]] \
  || fail "mutation method must be POST, PUT, PATCH, or DELETE"
[[ -f "$mutation_body_file" && ! -L "$mutation_body_file" && -r "$mutation_body_file" ]] \
  || fail "a readable non-symbolic-link mutation body file is required"
[[ -f "$cookie_file" && ! -L "$cookie_file" && -r "$cookie_file" ]] \
  || fail "a readable non-symbolic-link controlled-session cookie file is required"
current_uid="$(id -u)"
for private_input in "$mutation_body_file" "$cookie_file"; do
  [[ "$(stat -c '%u:%a' "$private_input")" == "$current_uid:600" ]] \
    || fail "mutation body and cookie files must be owned by the operator with mode 0600"
done
[[ "$alertmanager_url" == https://* || "$alertmanager_url" == http://127.0.0.1:* \
  || "$alertmanager_url" == http://localhost:* ]] \
  || fail "Alertmanager must use HTTPS or a loopback HTTP listener"
[[ "$alert_timeout_seconds" =~ ^[0-9]+$ ]] && (( alert_timeout_seconds >= 30 && alert_timeout_seconds <= 900 )) \
  || fail "alert timeout must be between 30 and 900 seconds"
for reviewed_file in "$rule_file" "$rule_test_file"; do
  [[ -f "$reviewed_file" && ! -L "$reviewed_file" ]] \
    || fail "reviewed Prometheus rule input is unavailable"
done
for output_file in "$metrics_file" "$receipt_file" "$evidence_file"; do
  [[ -n "$output_file" && "$output_file" == /* && ! -L "$output_file" \
    && ( ! -e "$output_file" || -f "$output_file" ) ]] \
    || fail "drill output paths must be absolute and may not be symbolic links"
done
[[ ! -e "$receipt_file" ]] || fail "use a fresh alert receipt path"
[[ ! -e "$evidence_file" ]] || fail "use a fresh evidence path"

metrics_directory="${metrics_file%/*}"
evidence_directory="${evidence_file%/*}"
receipt_directory="${receipt_file%/*}"
for output_directory in "$metrics_directory" "$evidence_directory" "$receipt_directory"; do
  [[ "$output_directory" != "$metrics_file" && ! -L "$output_directory" \
    && ( ! -e "$output_directory" || -d "$output_directory" ) ]] \
    || fail "drill output directory is invalid"
  install -d -m 0755 -- "$output_directory"
done

response_headers="$(mktemp)"
response_body="$(mktemp)"
accounting_evidence_output="$(mktemp)"
alert_response="$(mktemp)"
edge_log_output="$(mktemp)"
drill_succeeded=0

write_drill_metric() {
  local value="$1" temporary
  [[ "$value" == "0" || "$value" == "1" ]] || return 1
  temporary="$(mktemp "${metrics_file}.tmp.XXXXXX")" || return 1
  chmod 0644 -- "$temporary"
  {
    printf '%s\n' '# HELP business_finlynq_observability_drill_failure Synthetic failure used only for the reviewed observability acceptance drill.'
    printf '%s\n' '# TYPE business_finlynq_observability_drill_failure gauge'
    printf 'business_finlynq_observability_drill_failure %s\n' "$value"
  } >"$temporary"
  mv -f -- "$temporary" "$metrics_file"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e
  write_drill_metric 0
  rm -f -- \
    "$response_headers" "$response_body" "$accounting_evidence_output" \
    "$alert_response" "$edge_log_output"
  [[ "$drill_succeeded" == "1" ]] || printf '%s\n' "Synthetic alert signal was cleared after a failed drill" >&2
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

promtool check rules "$rule_file" >/dev/null
(
  cd -- "$(dirname -- "$rule_test_file")"
  promtool test rules "$(basename -- "$rule_test_file")"
) >/dev/null

[[ -r /proc/sys/kernel/random/uuid ]] || fail "kernel UUID source is unavailable"
IFS= read -r spoofed_request_id </proc/sys/kernel/random/uuid
[[ "$spoofed_request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "kernel UUID source returned an invalid sentinel"

public_spoof_health_status="$(curl \
  --silent \
  --show-error \
  --max-time 30 \
  --header 'X-Business-Finlynq-Internal-Health: 1' \
  --header "X-Request-Id: $spoofed_request_id" \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$base_url/api/health")" || fail "public readiness spoof probe did not complete"
[[ "$public_spoof_health_status" == "200" ]] \
  && jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$response_body" >/dev/null \
  || fail "public edge exposed internal readiness details"
if grep -Eiq "^x-request-id:[[:space:]]*$spoofed_request_id[[:space:]\r]*$" "$response_headers"; then
  fail "public edge retained a client-supplied readiness request ID"
fi

public_spoof_metrics_status="$(curl \
  --silent \
  --show-error \
  --max-time 30 \
  --header 'X-Business-Finlynq-Internal-Metrics: 1' \
  --header "X-Request-Id: $spoofed_request_id" \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$base_url/api/metrics")" || fail "public metrics spoof probe did not complete"
[[ "$public_spoof_metrics_status" == "404" ]] && grep -Fxq 'Not found.' "$response_body" \
  || fail "public edge exposed internal metrics"
if grep -Eiq "^x-request-id:[[:space:]]*$spoofed_request_id[[:space:]\r]*$" "$response_headers"; then
  fail "public edge retained a client-supplied metrics request ID"
fi

mutation_status="$(curl \
  --silent \
  --show-error \
  --max-time 30 \
  --request "$mutation_method" \
  --header "Origin: $base_url" \
  --header 'Content-Type: application/json' \
  --header "X-Request-Id: $spoofed_request_id" \
  --cookie "$cookie_file" \
  --data-binary "@$mutation_body_file" \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$mutation_url")" || fail "controlled mutation request did not complete"
[[ "$mutation_status" =~ ^2[0-9][0-9]$ ]] \
  || fail "controlled mutation did not return a successful status"

request_id="$(awk '
  BEGIN { IGNORECASE = 1 }
  /^x-request-id:/ {
    sub(/^[^:]+:[[:space:]]*/, "")
    sub(/[[:space:]\r]+$/, "")
    value = $0
  }
  END { print value }
' "$response_headers")"
[[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "public edge did not return a valid UUID request ID"
[[ "$request_id" != "$spoofed_request_id" ]] \
  || fail "public edge retained the client-supplied mutation request ID"

edge_log_seen=0
edge_log_deadline=$(( $(date +%s) + 30 ))
while (( $(date +%s) <= edge_log_deadline )); do
  if docker compose --profile edge logs --since 5m --no-color edge \
      >"$edge_log_output" 2>/dev/null \
    && grep -Eq '"request_id"[[:space:]]*:[[:space:]]*"'"$request_id"'"' "$edge_log_output"; then
    edge_log_seen=1
    break
  fi
  sleep 2
done
[[ "$edge_log_seen" == "1" ]] \
  || fail "edge access logs did not retain the generated request ID"

lineage_row="$(docker compose exec -T database psql \
  --no-password \
  --username business_finlynq_owner \
  --dbname business_finlynq \
  --tuples-only \
  --no-align \
  --field-separator='|' \
  --set=ON_ERROR_STOP=1 \
  --set="request_id=$request_id" \
  --command="
    SELECT
      (SELECT count(*) FROM public.audit_events WHERE request_id = :'request_id'),
      (SELECT count(*) FROM public.outbox_events WHERE request_id = :'request_id'),
      (SELECT count(*) FROM public.outbox_events AS outbox
       WHERE outbox.request_id = :'request_id'
         AND NOT EXISTS (
           SELECT 1 FROM public.audit_events AS audit
           WHERE audit.organization_id = outbox.organization_id
             AND audit.request_id = outbox.request_id
             AND audit.entity_type = outbox.aggregate_type
             AND audit.entity_id = outbox.aggregate_id
         ));
  ")" || fail "request lineage query failed"
IFS='|' read -r audit_count outbox_count unmatched_count unexpected_field <<<"$lineage_row"
[[ -z "${unexpected_field:-}" && "$audit_count" =~ ^[0-9]+$ && "$outbox_count" =~ ^[0-9]+$ \
  && "$unmatched_count" =~ ^[0-9]+$ ]] || fail "request lineage query returned an invalid shape"
(( audit_count > 0 && outbox_count > 0 && unmatched_count == 0 )) \
  || fail "controlled mutation did not produce correlated audit and outbox evidence"

docker compose --profile operations run --rm --no-deps -T verify_accounting_evidence \
  </dev/null >"$accounting_evidence_output" 2>&1 \
  || fail "aggregate accounting-evidence verification failed"
grep -E '^\{.*\}$' "$accounting_evidence_output" \
  | jq -s -e 'any(.[]; type == "object" and .status == "verified" and .integrityErrors == 0)' \
    >/dev/null \
  || fail "aggregate accounting-evidence verifier returned an invalid result"

write_drill_metric 1 || fail "synthetic failure metric could not be written"
deadline=$(( $(date +%s) + alert_timeout_seconds ))
alert_seen=0
while (( $(date +%s) <= deadline )); do
  if curl --silent --show-error --max-time 10 \
    --output "$alert_response" \
    "$alertmanager_url/api/v2/alerts?active=true&silenced=false&inhibited=false&filter=alertname%3DBusinessFinlynqSyntheticFailure" \
    && jq -e 'any(.[]; .labels.alertname == "BusinessFinlynqSyntheticFailure" and .status.state == "active")' \
      "$alert_response" >/dev/null 2>&1; then
    alert_seen=1
    break
  fi
  sleep 5
done
[[ "$alert_seen" == "1" ]] || fail "synthetic rule did not reach Alertmanager"

printf 'Confirm both required operators received BusinessFinlynqSyntheticFailure by writing exactly `delivered` to %s\n' "$receipt_file"
receipt_seen=0
delivery_deadline=$(( $(date +%s) + alert_timeout_seconds ))
while (( $(date +%s) <= delivery_deadline )); do
  if [[ -f "$receipt_file" && ! -L "$receipt_file" ]] \
    && [[ "$(stat -c '%u:%a' "$receipt_file")" == "$current_uid:600" ]] \
    && [[ "$(awk 'NR == 1 { print; exit }' "$receipt_file")" == "delivered" ]]; then
    receipt_seen=1
    break
  fi
  sleep 5
done
[[ "$receipt_seen" == "1" ]] || fail "operator notification delivery was not confirmed"

evidence_temporary="$(mktemp "${evidence_file}.tmp.XXXXXX")"
jq -cn \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg requestId "$request_id" \
  --argjson auditEvents "$audit_count" \
  --argjson outboxEvents "$outbox_count" \
  '{
    status: "verified",
    completedAt: $completedAt,
    requestId: $requestId,
    auditEvents: $auditEvents,
    outboxEvents: $outboxEvents,
    unmatchedOutboxEvents: 0,
    edgeAccessLog: "correlated",
    alertmanager: "active",
    operatorDelivery: "confirmed"
  }' >"$evidence_temporary"
chmod 0600 -- "$evidence_temporary"
mv -f -- "$evidence_temporary" "$evidence_file"
drill_succeeded=1
printf 'Observability acceptance drill passed; evidence: %s\n' "$evidence_file"
