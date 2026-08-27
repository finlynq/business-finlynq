#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

MONITOR_HOSTNAME="${MONITOR_HOSTNAME:-business.finlynq.com}"
MONITOR_BASE_URL="${MONITOR_BASE_URL:-https://$MONITOR_HOSTNAME}"
MONITOR_BACKUP_DIR="${MONITOR_BACKUP_DIR:-/var/backups/business-finlynq}"
MONITOR_MAX_BACKUP_AGE_HOURS="${MONITOR_MAX_BACKUP_AGE_HOURS:-8}"
MONITOR_MAX_BACKUP_ACTIVE_SECONDS="${MONITOR_MAX_BACKUP_ACTIVE_SECONDS:-7200}"
MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS="${MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS:-90}"
MONITOR_MIN_TLS_DAYS="${MONITOR_MIN_TLS_DAYS:-21}"
MONITOR_MAX_DISK_PERCENT="${MONITOR_MAX_DISK_PERCENT:-85}"
MONITOR_EXPECT_EDGE="${MONITOR_EXPECT_EDGE:-true}"
MONITOR_EXPECT_AUTH_EMAIL_WORKER="${MONITOR_EXPECT_AUTH_EMAIL_WORKER:-false}"
MONITOR_REQUIRE_OFFSITE="${MONITOR_REQUIRE_OFFSITE:-true}"
MONITOR_MAINTENANCE_SCHEDULER="${MONITOR_MAINTENANCE_SCHEDULER:-systemd}"
readonly monitor_cron_schedule_file="/home/deploy/business-finlynq/deploy/cron/managed-crontab"
readonly monitor_cron_maintenance_lock_file="/home/deploy/.local/state/business-finlynq/cron/demo-sandbox-maintenance.lock"

: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
: "${MONITOR_EXPECT_REVISION:?MONITOR_EXPECT_REVISION is required}"
: "${MONITOR_EXPECT_DEMO_LOGIN_ENABLED:?MONITOR_EXPECT_DEMO_LOGIN_ENABLED is required}"
: "${MONITOR_EXPECT_DEMO_WRITES_ENABLED:?MONITOR_EXPECT_DEMO_WRITES_ENABLED is required}"
: "${MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED:?MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED is required}"
: "${MONITOR_EXPECT_BUSINESS_WRITES_ENABLED:?MONITOR_EXPECT_BUSINESS_WRITES_ENABLED is required}"
: "${MONITOR_EXPECT_DEMO_MAINTENANCE:?MONITOR_EXPECT_DEMO_MAINTENANCE is required}"

MONITOR_EXPECT_DEMO_POOL_SIZE="${MONITOR_EXPECT_DEMO_POOL_SIZE:-128}"
MONITOR_MIN_DEMO_READY_SLOTS="${MONITOR_MIN_DEMO_READY_SLOTS:-4}"

failures=()

record_failure() {
  failures+=("$1")
}

for numeric_value in \
  MONITOR_MAX_BACKUP_AGE_HOURS MONITOR_MAX_BACKUP_ACTIVE_SECONDS MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS \
  MONITOR_MIN_TLS_DAYS MONITOR_MAX_DISK_PERCENT \
  MONITOR_EXPECT_DEMO_POOL_SIZE MONITOR_MIN_DEMO_READY_SLOTS; do
  [[ "${!numeric_value}" =~ ^[0-9]+$ ]] || {
    printf 'Invalid numeric monitoring setting: %s\n' "$numeric_value" >&2
    exit 2
  }
done
[[ "$MONITOR_EXPECT_EDGE" == "true" || "$MONITOR_EXPECT_EDGE" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" || "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" || "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "false" ]] || exit 2
[[ "$MONITOR_REQUIRE_OFFSITE" == "true" || "$MONITOR_REQUIRE_OFFSITE" == "false" ]] || exit 2
[[ "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" || "$MONITOR_MAINTENANCE_SCHEDULER" == "cron" ]] || {
  printf '%s\n' "MONITOR_MAINTENANCE_SCHEDULER must be systemd or cron" >&2
  exit 2
}
for boolean_value in \
  MONITOR_EXPECT_DEMO_LOGIN_ENABLED MONITOR_EXPECT_DEMO_WRITES_ENABLED \
  MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED MONITOR_EXPECT_BUSINESS_WRITES_ENABLED; do
  [[ "${!boolean_value}" == "true" || "${!boolean_value}" == "false" ]] || {
    printf 'Invalid boolean monitoring setting: %s\n' "$boolean_value" >&2
    exit 2
  }
done
(( MONITOR_EXPECT_DEMO_POOL_SIZE > 0 )) || {
  printf '%s\n' "MONITOR_EXPECT_DEMO_POOL_SIZE must be greater than zero" >&2
  exit 2
}
(( MONITOR_MAX_BACKUP_ACTIVE_SECONDS > 0 && MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS > 0 )) || {
  printf '%s\n' "Backup active and verification timeout settings must be greater than zero" >&2
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

for command_name in curl docker jq openssl timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
if [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" && "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" ]]; then
  command -v systemctl >/dev/null 2>&1 || {
    printf '%s\n' "Required monitoring command is unavailable: systemctl" >&2
    exit 2
  }
fi
if [[ "$MONITOR_MAINTENANCE_SCHEDULER" == "cron" ]]; then
  for command_name in crontab flock; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
      exit 2
    }
  done
fi

response_body="$(mktemp)"
response_headers="$(mktemp)"
backup_verification_output="$(mktemp)"
cleanup() {
  rm -f -- "$response_body" "$response_headers" "$backup_verification_output"
}
trap cleanup EXIT INT TERM

http_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$MONITOR_BASE_URL/api/health" || printf '000')"
if [[ "$http_status" != "200" ]] || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$response_body"; then
  record_failure "public readiness endpoint failed (HTTP $http_status)"
fi
if ! grep -Eiq '^strict-transport-security:[[:space:]]*max-age=' "$response_headers"; then
  record_failure "HTTPS response is missing HSTS"
fi
if ! grep -Eiq '^cache-control:.*no-store' "$response_headers"; then
  record_failure "readiness response is missing no-store caching"
fi
response_revision="$(jq -r '.revision // empty' "$response_body" 2>/dev/null || true)"
[[ "$response_revision" == "$MONITOR_EXPECT_REVISION" ]] || record_failure "readiness revision does not match the deployed release"

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
    "MONITOR_EXPECT_BUSINESS_WRITES_ENABLED:BUSINESS_WRITES_ENABLED"; do
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
      || "$cron_runner_count" != "3" || "$actual_cron_block" != "$expected_cron_block" ]]; then
      record_failure "deploy-owned cron schedule does not match the reviewed three-job block"
    fi
  fi
fi

if [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" \
  && "$MONITOR_MAINTENANCE_SCHEDULER" == "systemd" ]]; then
  for timer_name in business-finlynq-demo-reconcile.timer; do
    systemctl is-enabled --quiet "$timer_name" 2>/dev/null \
      || record_failure "demo maintenance timer is not enabled: $timer_name"
    systemctl is-active --quiet "$timer_name" 2>/dev/null \
      || record_failure "demo maintenance timer is not active: $timer_name"
  done

  for service_name in business-finlynq-demo-reconcile.service; do
    service_state="$(systemctl show --property=ActiveState --value "$service_name" 2>/dev/null || true)"
    if [[ "$service_state" == "active" || "$service_state" == "activating" ]]; then
      maintenance_active="true"
    fi
  done
elif [[ "$MONITOR_EXPECT_DEMO_MAINTENANCE" == "true" ]]; then
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
  timeout --signal=TERM --kill-after=5 "${MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS}s" \
    docker compose --profile operations run --rm --no-deps -T verify_latest_backup \
    </dev/null >"$backup_verification_output" 2>&1 \
    || backup_verification_status=$?
  if [[ "$backup_verification_status" == "0" ]]; then
    grep -Fqx -- "Business Finlynq encrypted backup verification passed" "$backup_verification_output" \
      || record_failure "isolated backup verifier returned an unexpected success response"
  elif [[ "$backup_verification_status" == "75" ]]; then
    grep -Fqx -- "Backup verification deferred while an encrypted backup is active" "$backup_verification_output" \
      || record_failure "isolated backup verifier returned an invalid deferral response"
  else
    record_failure "newest encrypted backup failed isolated container verification"
  fi
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Business Finlynq production check failed:\n' >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

printf '%s\n' "Business Finlynq production check passed"
