#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

MONITOR_HOSTNAME="${MONITOR_HOSTNAME:-business.finlynq.com}"
MONITOR_BASE_URL="${MONITOR_BASE_URL:-https://$MONITOR_HOSTNAME}"
MONITOR_BACKUP_DIR="${MONITOR_BACKUP_DIR:-/var/backups/business-finlynq}"
MONITOR_MAX_BACKUP_AGE_HOURS="${MONITOR_MAX_BACKUP_AGE_HOURS:-6}"
SCHEDULED_BACKUP_TIMEOUT_SECONDS="${SCHEDULED_BACKUP_TIMEOUT_SECONDS:-5400}"
MONITOR_MAX_BACKUP_ACTIVE_SECONDS="${MONITOR_MAX_BACKUP_ACTIVE_SECONDS:-4800}"
MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS="${MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS:-90}"
MONITOR_MIN_TLS_DAYS="${MONITOR_MIN_TLS_DAYS:-21}"
MONITOR_MAX_DISK_PERCENT="${MONITOR_MAX_DISK_PERCENT:-85}"
MONITOR_EXPECT_EDGE="${MONITOR_EXPECT_EDGE:-true}"
MONITOR_EXPECT_AUTH_EMAIL_WORKER="${MONITOR_EXPECT_AUTH_EMAIL_WORKER:-false}"
MONITOR_EXPECT_OUTBOX_PUBLISHER="${MONITOR_EXPECT_OUTBOX_PUBLISHER:-false}"
MONITOR_REQUIRE_OFFSITE="${MONITOR_REQUIRE_OFFSITE:-true}"
MONITOR_MAINTENANCE_SCHEDULER="${MONITOR_MAINTENANCE_SCHEDULER:-systemd}"
readonly monitor_cron_schedule_file="/home/deploy/business-finlynq/deploy/cron/managed-crontab"
readonly monitor_cron_maintenance_lock_file="/home/deploy/.local/state/business-finlynq/cron/demo-sandbox-maintenance.lock"
readonly monitor_cron_status_directory="/home/deploy/.local/state/business-finlynq/cron/job-status"
readonly monitor_metrics_file="${MONITOR_METRICS_FILE:-/var/lib/business-finlynq/host.prom}"
readonly accounting_metrics_file="${ACCOUNTING_EVIDENCE_METRICS_FILE:-/var/lib/business-finlynq/accounting-evidence.prom}"

monitor_run_success=0
backup_verification_status_metric=-1
backup_verification_run_unixtime=0
backup_timer_active=-1
backup_schedule_contract=-1
backup_job_last_success=-1
backup_job_last_run_unixtime=0
demo_timer_active=-1
demo_job_last_success=-1
demo_job_last_run_unixtime=0

: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
: "${MONITOR_EXPECT_REVISION:?MONITOR_EXPECT_REVISION is required}"
: "${MONITOR_EXPECT_DEMO_LOGIN_ENABLED:?MONITOR_EXPECT_DEMO_LOGIN_ENABLED is required}"
: "${MONITOR_EXPECT_DEMO_WRITES_ENABLED:?MONITOR_EXPECT_DEMO_WRITES_ENABLED is required}"
: "${MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED:?MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED is required}"
: "${MONITOR_EXPECT_ACCOUNT_SIGNUP_ENABLED:?MONITOR_EXPECT_ACCOUNT_SIGNUP_ENABLED is required}"
: "${MONITOR_EXPECT_BUSINESS_WRITES_ENABLED:?MONITOR_EXPECT_BUSINESS_WRITES_ENABLED is required}"
: "${MONITOR_EXPECT_BANK_FEEDS_ENABLED:?MONITOR_EXPECT_BANK_FEEDS_ENABLED is required}"
: "${MONITOR_EXPECT_DEMO_MAINTENANCE:?MONITOR_EXPECT_DEMO_MAINTENANCE is required}"

MONITOR_EXPECT_DEMO_POOL_SIZE="${MONITOR_EXPECT_DEMO_POOL_SIZE:-128}"
MONITOR_MIN_DEMO_READY_SLOTS="${MONITOR_MIN_DEMO_READY_SLOTS:-4}"

failures=()

record_failure() {
  failures+=("$1")
}

for numeric_value in \
  MONITOR_MAX_BACKUP_AGE_HOURS SCHEDULED_BACKUP_TIMEOUT_SECONDS \
  MONITOR_MAX_BACKUP_ACTIVE_SECONDS MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS \
  MONITOR_MIN_TLS_DAYS MONITOR_MAX_DISK_PERCENT \
  MONITOR_EXPECT_DEMO_POOL_SIZE MONITOR_MIN_DEMO_READY_SLOTS; do
  [[ "${!numeric_value}" =~ ^[0-9]+$ ]] || {
    printf 'Invalid numeric monitoring setting: %s\n' "$numeric_value" >&2
    exit 2
  }
done
[[ "$MONITOR_EXPECT_EDGE" == "true" || "$MONITOR_EXPECT_EDGE" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" || "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_OUTBOX_PUBLISHER" == "true" || "$MONITOR_EXPECT_OUTBOX_PUBLISHER" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" || "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "false" ]] || exit 2
[[ "$MONITOR_REQUIRE_OFFSITE" == "true" || "$MONITOR_REQUIRE_OFFSITE" == "false" ]] || exit 2
[[ "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" || "$MONITOR_MAINTENANCE_SCHEDULER" == "cron" ]] || {
  printf '%s\n' "MONITOR_MAINTENANCE_SCHEDULER must be systemd or cron" >&2
  exit 2
}
for boolean_value in \
  MONITOR_EXPECT_DEMO_LOGIN_ENABLED MONITOR_EXPECT_DEMO_WRITES_ENABLED \
  MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED MONITOR_EXPECT_ACCOUNT_SIGNUP_ENABLED \
  MONITOR_EXPECT_BUSINESS_WRITES_ENABLED MONITOR_EXPECT_BANK_FEEDS_ENABLED; do
  [[ "${!boolean_value}" == "true" || "${!boolean_value}" == "false" ]] || {
    printf 'Invalid boolean monitoring setting: %s\n' "$boolean_value" >&2
    exit 2
  }
done
(( MONITOR_EXPECT_DEMO_POOL_SIZE > 0 )) || {
  printf '%s\n' "MONITOR_EXPECT_DEMO_POOL_SIZE must be greater than zero" >&2
  exit 2
}
(( SCHEDULED_BACKUP_TIMEOUT_SECONDS > 0 && SCHEDULED_BACKUP_TIMEOUT_SECONDS <= 5400 \
  && MONITOR_MAX_BACKUP_ACTIVE_SECONDS > 0 && MONITOR_MAX_BACKUP_ACTIVE_SECONDS <= 4800 \
  && MONITOR_MAX_BACKUP_ACTIVE_SECONDS < SCHEDULED_BACKUP_TIMEOUT_SECONDS \
  && MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS > 0 )) || {
  printf '%s\n' "Backup timeout settings exceed the reviewed recovery envelope" >&2
  exit 2
}
(( MONITOR_MIN_DEMO_READY_SLOTS >= 0 && MONITOR_MIN_DEMO_READY_SLOTS <= MONITOR_EXPECT_DEMO_POOL_SIZE )) || {
  printf '%s\n' "MONITOR_MIN_DEMO_READY_SLOTS must be between zero and the expected pool size" >&2
  exit 2
}

if [[ ! "$MONITOR_EXPECT_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ || "$MONITOR_EXPECT_REVISION" =~ ^0+$ ]]; then
  printf 'MONITOR_EXPECT_REVISION must be a full 40- or 64-character hexadecimal Git revision\n' >&2
  exit 2
fi
if [[ ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ || "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]]; then
  printf 'BUSINESS_FINLYNQ_IMAGE_REVISION must be a full 40- or 64-character hexadecimal Git revision\n' >&2
  exit 2
fi
if [[ "$MONITOR_EXPECT_REVISION" != "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]]; then
  printf 'Configured monitoring and image revisions must match exactly\n' >&2
  exit 2
fi

for command_name in awk bash cat curl date df docker grep install jq mktemp mv openssl rm stat timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
if [[ "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" ]]; then
  for command_name in crontab systemctl; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
      exit 2
    }
  done
fi
if [[ "$MONITOR_MAINTENANCE_SCHEDULER" == "cron" ]]; then
  for command_name in crontab flock id systemctl; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
      exit 2
    }
  done
fi

response_body="$(mktemp)"
response_headers="$(mktemp)"
backup_verification_output="$(mktemp)"
backup_schedule_verification_output="$(mktemp)"
deploy_crontab_output="$(mktemp)"
deploy_crontab_error="$(mktemp)"

systemd_job_metrics() {
  local service_name="$1"
  local result timestamp timestamp_epoch=0 success=-1
  result="$(systemctl show --property=Result --value "$service_name" 2>/dev/null || true)"
  timestamp="$(systemctl show --property=ExecMainExitTimestamp --value "$service_name" 2>/dev/null || true)"
  if [[ -n "$timestamp" && "$timestamp" != "n/a" ]]; then
    timestamp_epoch="$(date --date="$timestamp" +%s 2>/dev/null || printf '0')"
  fi
  if [[ "$timestamp_epoch" =~ ^[0-9]+$ ]] && (( timestamp_epoch > 0 )); then
    [[ "$result" == "success" ]] && success=1 || success=0
  else
    timestamp_epoch=0
  fi
  printf '%s|%s\n' "$success" "$timestamp_epoch"
}

cron_job_metrics() {
  local job_name="$1" status_record expected_uid result timestamp now
  local success=-1
  status_record="$monitor_cron_status_directory/$job_name.json"
  expected_uid="$(id -u deploy 2>/dev/null || printf 'unavailable')"
  [[ "$expected_uid" =~ ^[0-9]+$ \
    && -f "$status_record" && ! -L "$status_record" \
    && "$(stat -c '%u:%a' "$status_record")" == "$expected_uid:600" ]] \
    || { printf '%s|0\n' "$success"; return 0; }
  jq -e --arg job "$job_name" \
    'keys == ["completedAtUnixtime", "job", "product", "result", "schemaVersion"]
      and .schemaVersion == 1
      and .product == "business-finlynq"
      and .job == $job
      and (.result == "succeeded" or .result == "failed")
      and (.completedAtUnixtime | type == "number" and floor == . and . > 0)' \
    "$status_record" >/dev/null 2>&1 \
    || { printf '%s|0\n' "$success"; return 0; }
  result="$(jq -r '.result' "$status_record")"
  timestamp="$(jq -r '.completedAtUnixtime' "$status_record")"
  now="$(date +%s)"
  [[ "$timestamp" =~ ^[1-9][0-9]*$ && "$now" =~ ^[1-9][0-9]*$ \
    && "$timestamp" -le "$now" ]] \
    || { printf '%s|0\n' "$success"; return 0; }
  [[ "$result" == "succeeded" ]] && success=1 || success=0
  printf '%s|%s\n' "$success" "$timestamp"
}

write_host_metrics() {
  local exit_status="$1" metrics_directory metrics_temporary now
  metrics_directory="${monitor_metrics_file%/*}"
  now="$(date +%s)"
  if [[ "$monitor_metrics_file" != /* || "$metrics_directory" == "$monitor_metrics_file" \
    || -L "$metrics_directory" || -L "$monitor_metrics_file" \
    || ( -e "$metrics_directory" && ! -d "$metrics_directory" ) \
    || ( -e "$monitor_metrics_file" && ! -f "$monitor_metrics_file" ) ]]; then
    printf '%s\n' "Host metrics path must be an absolute, non-symbolic-link file" >&2
    return 1
  fi
  install -d -m 0775 -- "$metrics_directory" || return 1
  metrics_temporary="$(mktemp "${monitor_metrics_file}.tmp.XXXXXX")" || return 1
  chmod 0644 -- "$metrics_temporary"
  {
    printf '%s\n' '# HELP business_finlynq_host_monitor_success Whether the latest host readiness monitor completed successfully.'
    printf '%s\n' '# TYPE business_finlynq_host_monitor_success gauge'
    printf 'business_finlynq_host_monitor_success %s\n' "$([[ "$exit_status" == "0" && "$monitor_run_success" == "1" ]] && printf '1' || printf '0')"
    printf '%s\n' '# HELP business_finlynq_host_monitor_last_run_unixtime Unix time of the latest host readiness monitor completion.'
    printf '%s\n' '# TYPE business_finlynq_host_monitor_last_run_unixtime gauge'
    printf 'business_finlynq_host_monitor_last_run_unixtime %s\n' "$now"
    printf '%s\n' '# HELP business_finlynq_outbox_publisher_expected Whether this release expects durable outbox publication.'
    printf '%s\n' '# TYPE business_finlynq_outbox_publisher_expected gauge'
    printf 'business_finlynq_outbox_publisher_expected %s\n' "$([[ "$MONITOR_EXPECT_OUTBOX_PUBLISHER" == "true" ]] && printf '1' || printf '0')"
    printf '%s\n' '# HELP business_finlynq_auth_email_worker_expected Whether this release expects the authentication email worker.'
    printf '%s\n' '# TYPE business_finlynq_auth_email_worker_expected gauge'
    printf 'business_finlynq_auth_email_worker_expected %s\n' "$([[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" ]] && printf '1' || printf '0')"
    printf '%s\n' '# HELP business_finlynq_backup_verification_status Latest isolated backup verification status: 1 success, 0 failure, 2 safely deferred, -1 not attempted.'
    printf '%s\n' '# TYPE business_finlynq_backup_verification_status gauge'
    printf 'business_finlynq_backup_verification_status %s\n' "$backup_verification_status_metric"
    printf '%s\n' '# HELP business_finlynq_backup_verification_last_run_unixtime Unix time of the latest isolated backup verification attempt or safe deferral.'
    printf '%s\n' '# TYPE business_finlynq_backup_verification_last_run_unixtime gauge'
    printf 'business_finlynq_backup_verification_last_run_unixtime %s\n' "$backup_verification_run_unixtime"
    printf '%s\n' '# HELP business_finlynq_backup_schedule_contract Whether the selected systemd or cron scheduling contract exactly matches the committed candidate.'
    printf '%s\n' '# TYPE business_finlynq_backup_schedule_contract gauge'
    printf 'business_finlynq_backup_schedule_contract %s\n' "$backup_schedule_contract"
    printf '%s\n' '# HELP business_finlynq_scheduled_job_timer_active Whether the selected reviewed systemd timer or cron schedule is active.'
    printf '%s\n' '# TYPE business_finlynq_scheduled_job_timer_active gauge'
    printf 'business_finlynq_scheduled_job_timer_active{job="encrypted_backup"} %s\n' "$backup_timer_active"
    printf 'business_finlynq_scheduled_job_timer_active{job="demo_reconciliation"} %s\n' "$demo_timer_active"
    printf '%s\n' '# HELP business_finlynq_scheduled_job_last_run_success Whether the latest completed job in the selected scheduler succeeded; -1 means unavailable.'
    printf '%s\n' '# TYPE business_finlynq_scheduled_job_last_run_success gauge'
    printf 'business_finlynq_scheduled_job_last_run_success{job="encrypted_backup"} %s\n' "$backup_job_last_success"
    printf 'business_finlynq_scheduled_job_last_run_success{job="demo_reconciliation"} %s\n' "$demo_job_last_success"
    printf '%s\n' '# HELP business_finlynq_scheduled_job_last_run_unixtime Unix time of the latest completed job in the selected scheduler; zero means unavailable.'
    printf '%s\n' '# TYPE business_finlynq_scheduled_job_last_run_unixtime gauge'
    printf 'business_finlynq_scheduled_job_last_run_unixtime{job="encrypted_backup"} %s\n' "$backup_job_last_run_unixtime"
    printf 'business_finlynq_scheduled_job_last_run_unixtime{job="demo_reconciliation"} %s\n' "$demo_job_last_run_unixtime"
  } >"$metrics_temporary"
  mv -f -- "$metrics_temporary" "$monitor_metrics_file"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e
  rm -f -- "$response_body" "$response_headers" "$backup_verification_output" \
    "$backup_schedule_verification_output" "$deploy_crontab_output" "$deploy_crontab_error"
  if ! write_host_metrics "$exit_status"; then
    printf '%s\n' "Host metrics could not be written" >&2
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

spoofed_request_id="00000000-0000-4000-8000-000000000001"
if [[ -r /proc/sys/kernel/random/uuid ]]; then
  IFS= read -r spoofed_request_id </proc/sys/kernel/random/uuid || true
fi
if [[ ! "$spoofed_request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  record_failure "request-correlation spoof sentinel could not be generated"
  spoofed_request_id="00000000-0000-4000-8000-000000000001"
fi

public_live_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$MONITOR_BASE_URL/api/live" || printf '000')"
if [[ "$public_live_status" != "200" ]] || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"live"' "$response_body"; then
  record_failure "public liveness endpoint failed (HTTP $public_live_status)"
fi
if ! grep -Eiq '^strict-transport-security:[[:space:]]*max-age=' "$response_headers"; then
  record_failure "HTTPS response is missing HSTS"
fi
if ! grep -Eiq '^cache-control:.*no-store' "$response_headers"; then
  record_failure "public liveness response is missing no-store caching"
fi

public_health_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --header 'X-Business-Finlynq-Internal-Health: 1' \
  --header "X-Request-Id: $spoofed_request_id" \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$MONITOR_BASE_URL/api/health" || printf '000')"
if [[ "$public_health_status" != "200" ]] \
  || ! jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$response_body" >/dev/null 2>&1; then
  record_failure "public readiness endpoint failed (HTTP $public_health_status)"
fi
if ! grep -Eiq '^cache-control:.*no-store' "$response_headers"; then
  record_failure "public readiness response is missing no-store caching"
fi
if ! grep -Eiq '^x-request-id:[[:space:]]*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[[:space:]\r]*$' "$response_headers" \
  || grep -Eiq "^x-request-id:[[:space:]]*$spoofed_request_id[[:space:]\r]*$" "$response_headers"; then
  record_failure "public edge did not replace the readiness request ID"
fi

public_metrics_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --header 'X-Business-Finlynq-Internal-Metrics: 1' \
  --header "X-Request-Id: $spoofed_request_id" \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$MONITOR_BASE_URL/api/metrics" || printf '000')"
if [[ "$public_metrics_status" != "404" ]] || ! grep -Fxq 'Not found.' "$response_body"; then
  record_failure "public edge exposed the internal metrics surface (HTTP $public_metrics_status)"
fi
if ! grep -Eiq '^x-request-id:[[:space:]]*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[[:space:]\r]*$' "$response_headers" \
  || grep -Eiq "^x-request-id:[[:space:]]*$spoofed_request_id[[:space:]\r]*$" "$response_headers"; then
  record_failure "public edge did not replace the metrics request ID"
fi

internal_health_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --header 'X-Business-Finlynq-Internal-Health: 1' \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "http://127.0.0.1:3100/api/health" || printf '000')"
if [[ "$internal_health_status" != "200" ]] || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$response_body"; then
  record_failure "internal readiness endpoint failed (HTTP $internal_health_status)"
fi
if ! grep -Eiq '^cache-control:.*no-store' "$response_headers"; then
  record_failure "internal readiness response is missing no-store caching"
fi
response_revision="$(jq -r '.revision // empty' "$response_body" 2>/dev/null || true)"
[[ "$response_revision" == "$MONITOR_EXPECT_REVISION" ]] || record_failure "readiness revision does not match the deployed release"
response_bank_feeds="$(jq -r '.checks.bankFeeds // empty' "$response_body" 2>/dev/null || true)"
expected_bank_feed_readiness="disabled"
[[ "$MONITOR_EXPECT_BANK_FEEDS_ENABLED" == "true" ]] && expected_bank_feed_readiness="ready"
[[ "$response_bank_feeds" == "$expected_bank_feed_readiness" ]] \
  || record_failure "readiness bank-feed gate does not match the monitored release boundary"

tls_seconds=$((MONITOR_MIN_TLS_DAYS * 86400))
if ! openssl s_client \
  -connect "$MONITOR_HOSTNAME:443" \
  -servername "$MONITOR_HOSTNAME" \
  </dev/null 2>/dev/null \
  | openssl x509 -checkend "$tls_seconds" -noout >/dev/null 2>&1; then
  record_failure "TLS certificate expires within $MONITOR_MIN_TLS_DAYS days or could not be read"
fi

expected_services=(database app)
if [[ "$MONITOR_EXPECT_EDGE" == "true" ]]; then
  expected_services+=(edge)
fi
if [[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" ]]; then
  expected_services+=(auth_email_worker)
fi
app_container_id=""
database_container_id=""
for service_name in "${expected_services[@]}"; do
  container_id="$(docker compose --profile edge --profile auth-email ps --quiet "$service_name" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    record_failure "container is missing: $service_name"
    continue
  fi
  if [[ "$service_name" == "app" ]]; then
    app_container_id="$container_id"
  elif [[ "$service_name" == "database" ]]; then
    database_container_id="$container_id"
  fi
  container_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$container_state" != "healthy" && "$container_state" != "running" ]]; then
    record_failure "container is not healthy: $service_name ($container_state)"
  fi
done

if [[ -n "$app_container_id" ]]; then
  app_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$app_container_id" 2>/dev/null || true)"
  for gate_mapping in \
    "MONITOR_EXPECT_DEMO_LOGIN_ENABLED:DEMO_LOGIN_ENABLED" \
    "MONITOR_EXPECT_DEMO_WRITES_ENABLED:DEMO_WRITES_ENABLED" \
    "MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED:ACCOUNT_LOGIN_ENABLED" \
    "MONITOR_EXPECT_ACCOUNT_SIGNUP_ENABLED:ACCOUNT_SIGNUP_ENABLED" \
    "MONITOR_EXPECT_BUSINESS_WRITES_ENABLED:BUSINESS_WRITES_ENABLED" \
    "MONITOR_EXPECT_BANK_FEEDS_ENABLED:BANK_FEEDS_ENABLED"; do
    monitor_key="${gate_mapping%%:*}"
    container_key="${gate_mapping#*:}"
    expected_value="${!monitor_key}"
    actual_value="$(awk -F= -v key="$container_key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' <<<"$app_environment")"
    [[ "$actual_value" == "$expected_value" ]] \
      || record_failure "app gate $container_key does not match the monitored release boundary"
  done
  app_revision="$(awk -F= '$1 == "BUSINESS_FINLYNQ_IMAGE_REVISION" { sub(/^[^=]*=/, ""); print; exit }' <<<"$app_environment")"
  [[ "$app_revision" == "$MONITOR_EXPECT_REVISION" ]] \
    || record_failure "app container revision does not match the monitored release"
  app_image_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$app_container_id" 2>/dev/null || true)"
  [[ "$app_image_revision" == "$MONITOR_EXPECT_REVISION" ]] \
    || record_failure "app image OCI revision label does not match the monitored release"
fi

maintenance_active="false"
if [[ "$MONITOR_MAINTENANCE_SCHEDULER" == "cron" ]]; then
  cron_schedule_valid="false"
  cron_begin_marker="# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE"
  cron_end_marker="# END BUSINESS FINLYNQ MANAGED SCHEDULE"
  cron_contents=""
  if ! cron_contents="$(crontab -l 2>/dev/null)"; then
    record_failure "deploy-owned cron schedule is unavailable"
  elif [[ ! -f "$monitor_cron_schedule_file" || -L "$monitor_cron_schedule_file" ]]; then
    record_failure "committed cron schedule is missing or is a symbolic link"
  else
    cron_begin_count="$(grep -Fxc -- "$cron_begin_marker" <<<"$cron_contents" || true)"
    cron_end_count="$(grep -Fxc -- "$cron_end_marker" <<<"$cron_contents" || true)"
    cron_runner_count="$(grep -Fc -- "/bin/bash /home/deploy/business-finlynq/deploy/cron/run-job.sh " <<<"$cron_contents" || true)"
    actual_cron_block="$(awk -v begin="$cron_begin_marker" -v end="$cron_end_marker" '
      $0 == begin { managed = 1 }
      managed { print }
      $0 == end && managed { exit }
    ' <<<"$cron_contents")"
    expected_cron_block="$(cat -- "$monitor_cron_schedule_file")"
    if [[ "$cron_begin_count" != "1" || "$cron_end_count" != "1" \
      || "$cron_runner_count" != "4" || "$actual_cron_block" != "$expected_cron_block" ]]; then
      record_failure "deploy-owned cron schedule does not match the reviewed four-job block"
    else
      cron_schedule_valid="true"
    fi
  fi
  if [[ "$cron_schedule_valid" == "true" ]]; then
    backup_schedule_contract=1
    backup_timer_active=1
    [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]] && demo_timer_active=1
  else
    backup_schedule_contract=0
    backup_timer_active=0
    [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]] && demo_timer_active=0
  fi
  for unselected_timer in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    if systemctl is-active --quiet "$unselected_timer" 2>/dev/null \
      || systemctl is-enabled --quiet "$unselected_timer" 2>/dev/null; then
      record_failure "unselected systemd scheduler remains active or enabled: $unselected_timer"
    fi
  done
fi

if [[ "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" ]]; then
  : >"$deploy_crontab_output"
  : >"$deploy_crontab_error"
  systemd_mode_cron_contents=""
  deploy_crontab_status=0
  if LC_ALL=C crontab -u deploy -l >"$deploy_crontab_output" 2>"$deploy_crontab_error"; then
    systemd_mode_cron_contents="$(cat -- "$deploy_crontab_output")"
  else
    deploy_crontab_status=$?
    if [[ "$deploy_crontab_status" == "1" && ! -s "$deploy_crontab_output" ]] \
      && grep -Fqx 'no crontab for deploy' "$deploy_crontab_error"; then
      systemd_mode_cron_contents=""
    else
      record_failure "deploy crontab could not be read while proving the unselected scheduler absent"
    fi
  fi
  if grep -Fq '# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE' <<<"$systemd_mode_cron_contents" \
    || grep -Fq '/home/deploy/business-finlynq/deploy/cron/run-job.sh ' <<<"$systemd_mode_cron_contents"; then
    record_failure "unselected deploy-owned cron scheduler remains installed"
  fi
  if bash /home/deploy/business-finlynq/deploy/systemd/verify-backup-schedule.sh \
    >"$backup_schedule_verification_output" 2>&1; then
    backup_schedule_contract=1
  else
    backup_schedule_contract=0
    record_failure "loaded scheduled service/timer contracts differ from the committed candidate"
  fi
  systemd_timers=(
    business-finlynq-backup.timer
    business-finlynq-monitor.timer
    business-finlynq-accounting-evidence.timer
    business-finlynq-demo-reconcile.timer
  )
  for timer_name in "${systemd_timers[@]}"; do
    systemctl is-enabled --quiet "$timer_name" 2>/dev/null \
      || record_failure "scheduled operations timer is not enabled: $timer_name"
    if systemctl is-active --quiet "$timer_name" 2>/dev/null; then
      if [[ "$timer_name" == "business-finlynq-backup.timer" ]]; then
        backup_timer_active=1
      elif [[ "$timer_name" == "business-finlynq-demo-reconcile.timer" ]]; then
        demo_timer_active=1
      fi
    else
      if [[ "$timer_name" == "business-finlynq-backup.timer" ]]; then
        backup_timer_active=0
      elif [[ "$timer_name" == "business-finlynq-demo-reconcile.timer" ]]; then
        demo_timer_active=0
      fi
      record_failure "scheduled operations timer is not active: $timer_name"
    fi
  done

  IFS='|' read -r backup_job_last_success backup_job_last_run_unixtime \
    <<<"$(systemd_job_metrics business-finlynq-backup.service)"
  if [[ "$backup_job_last_success" == "0" ]]; then
    record_failure "latest encrypted backup job failed"
  fi

  if [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]]; then
    IFS='|' read -r demo_job_last_success demo_job_last_run_unixtime \
      <<<"$(systemd_job_metrics business-finlynq-demo-reconcile.service)"
    if [[ "$demo_job_last_success" == "0" ]]; then
      record_failure "latest demo reconciliation job failed"
    fi
    service_state="$(systemctl show --property=ActiveState --value business-finlynq-demo-reconcile.service 2>/dev/null || true)"
    if [[ "$service_state" == "active" || "$service_state" == "activating" ]]; then
      maintenance_active="true"
    fi
  fi
else
  IFS='|' read -r backup_job_last_success backup_job_last_run_unixtime \
    <<<"$(cron_job_metrics backup)"
  if [[ "$backup_job_last_success" == "0" ]]; then
    record_failure "latest encrypted backup cron job failed"
  fi
  if [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]]; then
    IFS='|' read -r demo_job_last_success demo_job_last_run_unixtime \
      <<<"$(cron_job_metrics nightly-reconciliation)"
    if [[ "$demo_job_last_success" == "0" ]]; then
      record_failure "latest demo reconciliation cron job failed"
    fi
    if [[ ! -f "$monitor_cron_maintenance_lock_file" || -L "$monitor_cron_maintenance_lock_file" ]]; then
      record_failure "deploy-owned cron maintenance lock is missing or is a symbolic link"
    else
      exec {maintenance_lock_fd}>"$monitor_cron_maintenance_lock_file"
      if flock --nonblock "$maintenance_lock_fd"; then
        # Hold the free maintenance lock through the pool query so a reset cannot
        # begin between the activity check and the aggregate state snapshot.
        :
      else
        maintenance_active="true"
        exec {maintenance_lock_fd}>&-
      fi
    fi
  fi
fi

if [[ "$accounting_metrics_file" != /* || -L "$accounting_metrics_file" \
  || ! -f "$accounting_metrics_file" ]]; then
  record_failure "accounting-evidence textfile metric is missing or unsafe"
else
  accounting_verification_success="$(awk '$1 == "business_finlynq_accounting_evidence_verification_success" { print $2; exit }' "$accounting_metrics_file")"
  accounting_last_run="$(awk '$1 == "business_finlynq_accounting_evidence_verification_last_run_unixtime" { print $2; exit }' "$accounting_metrics_file")"
  accounting_last_success="$(awk '$1 == "business_finlynq_accounting_evidence_verification_last_success_unixtime" { print $2; exit }' "$accounting_metrics_file")"
  accounting_now="$(date +%s)"
  if [[ "$accounting_verification_success" != "1" \
    || ! "$accounting_last_run" =~ ^[0-9]+$ || ! "$accounting_last_success" =~ ^[0-9]+$ \
    || "$accounting_last_run" -le 0 || "$accounting_last_success" -le 0 \
    || "$accounting_last_run" -gt "$accounting_now" || "$accounting_last_success" -gt "$accounting_now" \
    || $(( accounting_now - accounting_last_run )) -ge 21600 \
    || $(( accounting_now - accounting_last_success )) -ge 21600 ]]; then
    record_failure "accounting-evidence verification is failed, malformed, or at the six-hour threshold"
  fi
fi

if [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]]; then
  slot_counts=""
  if [[ -n "$database_container_id" ]]; then
    slot_counts="$(docker exec "$database_container_id" \
      psql --no-password --username business_finlynq_owner --dbname business_finlynq \
      --tuples-only --no-align --field-separator='|' --set=ON_ERROR_STOP=1 \
      --command "SELECT count(*), count(*) FILTER (WHERE state = 'READY'), count(*) FILTER (WHERE state = 'ASSIGNED'), count(*) FILTER (WHERE state = 'DIRTY'), count(*) FILTER (WHERE state = 'RESETTING'), count(*) FILTER (WHERE state = 'QUARANTINED'), (SELECT (reset_after <= now())::int FROM demo_sandbox_pool WHERE singleton) FROM demo_sandbox_slots;" \
      2>/dev/null || true)"
  fi
  IFS='|' read -r slot_total slot_ready slot_assigned slot_dirty slot_resetting slot_quarantined pool_reset_due slot_extra <<<"$slot_counts"
  if [[ -n "${slot_extra:-}" ]] \
    || [[ ! "${slot_total:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${slot_ready:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${slot_assigned:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${slot_dirty:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${slot_resetting:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${slot_quarantined:-}" =~ ^[0-9]+$ ]] \
    || [[ ! "${pool_reset_due:-}" =~ ^[01]$ ]]; then
    record_failure "demo sandbox pool state could not be verified"
  else
    (( slot_total == MONITOR_EXPECT_DEMO_POOL_SIZE )) \
      || record_failure "demo sandbox pool has $slot_total slots; expected $MONITOR_EXPECT_DEMO_POOL_SIZE"
    (( slot_quarantined == 0 )) \
      || record_failure "demo sandbox pool has $slot_quarantined quarantined slot(s)"
    if [[ "$maintenance_active" != "true" ]]; then
      (( slot_resetting == 0 )) \
        || record_failure "demo sandbox pool has $slot_resetting stranded resetting slot(s)"
      (( pool_reset_due == 0 )) \
        || record_failure "demo sandbox nightly reset is overdue"
      (( slot_ready >= MONITOR_MIN_DEMO_READY_SLOTS )) \
        || record_failure "demo sandbox pool has only $slot_ready ready slot(s); minimum is $MONITOR_MIN_DEMO_READY_SLOTS"
    fi
  fi
fi

if [[ ! -d "$MONITOR_BACKUP_DIR" ]]; then
  record_failure "backup directory is missing"
else
  disk_percent="$(df -P "$MONITOR_BACKUP_DIR" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')"
  if [[ ! "$disk_percent" =~ ^[0-9]+$ ]] || (( disk_percent >= MONITOR_MAX_DISK_PERCENT )); then
    record_failure "backup filesystem utilization is ${disk_percent:-unknown}% (limit $MONITOR_MAX_DISK_PERCENT%)"
  fi

  backup_verification_status=0
  backup_verification_run_unixtime="$(date +%s)"
  timeout --signal=TERM --kill-after=5 "${MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS}s" \
    docker compose --profile operations run --rm --no-deps -T verify_latest_backup \
    </dev/null >"$backup_verification_output" 2>&1 \
    || backup_verification_status=$?
  if [[ "$backup_verification_status" == "0" ]]; then
    if grep -Fqx -- "Business Finlynq encrypted backup verification passed" "$backup_verification_output"; then
      backup_verification_status_metric=1
    else
      backup_verification_status_metric=0
      record_failure "isolated backup verifier returned an unexpected success response"
    fi
  elif [[ "$backup_verification_status" == "75" ]]; then
    if grep -Fqx -- "Backup verification deferred while an encrypted backup is active" "$backup_verification_output"; then
      backup_verification_status_metric=2
    else
      backup_verification_status_metric=0
      record_failure "isolated backup verifier returned an invalid deferral response"
    fi
  else
    backup_verification_status_metric=0
    record_failure "newest encrypted backup failed isolated container verification"
  fi
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Business Finlynq production check failed:\n' >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

monitor_run_success=1
printf '%s\n' "Business Finlynq production check passed"
