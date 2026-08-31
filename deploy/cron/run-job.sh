#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly repository_root="/home/deploy/business-finlynq"
readonly operations_env="/home/deploy/.config/business-finlynq/operations.env"
readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"
readonly scheduler_lock_file="$state_dir/scheduler.lock"
readonly maintenance_lock_file="$state_dir/demo-sandbox-maintenance.lock"
readonly nightly_stamp_file="$state_dir/nightly-reconciliation.date"
readonly job_status_directory="$state_dir/job-status"
readonly scheduler_maintenance_marker="/home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance"
readonly nightly_timezone="America/Toronto"
readonly nightly_due_time="04:15"

fail() {
  if [[ "${job_status_ready:-false}" == "true" ]]; then
    write_job_status failed >/dev/null 2>&1 || true
  fi
  if command -v logger >/dev/null 2>&1; then
    logger --priority user.err --tag business-finlynq-cron -- "$1" || true
  fi
  printf 'Business Finlynq scheduled job failed: %s\n' "$1" >&2
  exit 1
}

(( $# == 1 )) || fail "exactly one allowlisted job name is required"
readonly job_name="$1"
case "$job_name" in
  nightly-reconciliation|backup|accounting-evidence|monitor) ;;
  *) fail "job is not allowlisted" ;;
esac

for command_name in date env flock id logger mkdir mktemp mv stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done


[[ "$(id -un)" == "deploy" ]] \
  || fail "scheduled jobs must run as the exact deploy account"
if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
  fail "the deploy account is unavailable"
fi
[[ "$(id -u)" == "$deploy_uid" ]] \
  || fail "scheduled job resolved a different deploy uid"

readonly logger_path="$(command -v logger)"
readonly log_tag="business-finlynq-$job_name"

log() {
  "$logger_path" --priority user.info --tag "$log_tag" -- "$1"
}

log_error() {
  "$logger_path" --priority user.err --tag "$log_tag" -- "$1"
}

report_unhandled_error() {
  local status=$?
  local line_number="$1"
  trap - ERR
  if [[ "${job_status_ready:-false}" == "true" ]]; then
    write_job_status failed >/dev/null 2>&1 || true
  fi
  log_error "Scheduled job aborted at wrapper line $line_number with status $status."
  exit "$status"
}

trap 'report_unhandled_error "$LINENO"' ERR

[[ -d "$repository_root/.git" ]] \
  || fail "the reviewed repository checkout is missing at $repository_root"
[[ -f "$operations_env" && ! -L "$operations_env" ]] \
  || fail "the deploy-owned operations environment is missing or is a symbolic link"
[[ "$(stat -c '%a' -- "$operations_env")" == "600" ]] \
  || fail "$operations_env must have mode 0600"
[[ "$(stat -c '%u' -- "$operations_env")" == "$(id -u)" ]] \
  || fail "$operations_env must be owned by the scheduled deploy user"

mkdir -p -- "$state_dir/locks"
mkdir -p -- "$job_status_directory"
chmod 0700 -- "$state_dir" "$state_dir/locks" "$job_status_directory"

readonly job_status_record="$job_status_directory/$job_name.json"
[[ ! -e "$job_status_record" \
  || ( -f "$job_status_record" && ! -L "$job_status_record" \
    && "$(stat -c '%u:%a' "$job_status_record")" == "$(id -u):600" ) ]] \
  || fail "existing durable job status record is unsafe"

write_job_status() {
  local result="$1" completed_at temporary_status
  [[ "$result" == "succeeded" || "$result" == "failed" ]] || return 2
  completed_at="$(date +%s)"
  [[ "$completed_at" =~ ^[1-9][0-9]*$ ]] || return 2
  temporary_status="$(mktemp "$job_status_directory/.${job_name}.json.XXXXXX")" || return 1
  printf '{"completedAtUnixtime":%s,"job":"%s","product":"business-finlynq","result":"%s","schemaVersion":1}\n' \
    "$completed_at" "$job_name" "$result" >"$temporary_status"
  chmod 0600 -- "$temporary_status"
  mv -f -- "$temporary_status" "$job_status_record"
}
job_status_ready="true"

exec 7>"$scheduler_lock_file"
if ! flock --shared --nonblock 7; then
  log "The managed schedule is paused; this $job_name invocation was skipped."
  exit 0
fi
if [[ -e "$scheduler_maintenance_marker" || -L "$scheduler_maintenance_marker" ]]; then
  log "The release maintenance marker is present; this $job_name invocation was skipped."
  exit 0
fi

readonly job_lock_file="$state_dir/locks/$job_name.lock"
exec 8>"$job_lock_file"
if ! flock --nonblock 8; then
  log "A previous $job_name pass still holds its lock; this invocation was skipped."
  exit 0
fi

run_with_clean_environment() {
  # Start every scheduled child from an empty environment. Only fixed process
  # basics and the reviewed operations file cross this boundary; unmanaged
  # Docker/Compose routing variables cannot redirect a scheduled operation.
  env -i \
    HOME="/home/deploy" \
    USER="deploy" \
    LOGNAME="deploy" \
    SHELL="/bin/bash" \
    PATH="/home/deploy/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    /bin/bash -Eeuo pipefail -c '
      readonly clean_operations_env="$1"
      readonly clean_maintenance_lock="$2"
      readonly clean_repository_root="$3"
      shift 3
      set -a
      # shellcheck disable=SC1090
      source "$clean_operations_env"
      set +a
      [[ "${MONITOR_MAINTENANCE_SCHEDULER:-}" == "cron" ]] || {
        printf "Cron child requires MONITOR_MAINTENANCE_SCHEDULER=cron\n" >&2
        exit 2
      }
      for forbidden_name in DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR; do
        if [[ -n "${!forbidden_name+x}" ]]; then
          printf "Forbidden container-routing variable in operations environment: %s\n" "$forbidden_name" >&2
          exit 2
        fi
      done
      [[ "${BUSINESS_FINLYNQ_IMAGE_REVISION:-}" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ \
        && ! "${BUSINESS_FINLYNQ_IMAGE_REVISION:-}" =~ ^0+$ ]] || {
        printf "Cron child requires a full reviewed BUSINESS_FINLYNQ_IMAGE_REVISION\n" >&2
        exit 2
      }
      if ! clean_checkout_head="$(git -c safe.directory="$clean_repository_root" \
        -C "$clean_repository_root" rev-parse HEAD 2>/dev/null)"; then
        printf "Cron checkout HEAD could not be inspected\n" >&2
        exit 2
      fi
      [[ "$clean_checkout_head" == "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]] || {
        printf "Cron checkout HEAD differs from the reviewed image revision\n" >&2
        exit 2
      }
      if ! clean_checkout_status="$(git -c safe.directory="$clean_repository_root" \
        -C "$clean_repository_root" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
        printf "Cron checkout status could not be inspected\n" >&2
        exit 2
      fi
      [[ -z "$clean_checkout_status" ]] || {
        printf "Cron checkout is dirty; scheduled execution refused\n" >&2
        exit 2
      }
      export DEMO_RESET_LOCK_FILE="$clean_maintenance_lock"
      exec "$@"
    ' business-finlynq-cron-child "$operations_env" "$maintenance_lock_file" \
      "$repository_root" "$@"
}

run_and_log() {
  local description="$1"
  shift

  log "Starting $description."
  if run_with_clean_environment "$@" \
    > >("$logger_path" --priority user.info --tag "$log_tag") \
    2> >("$logger_path" --priority user.err --tag "$log_tag"); then
    log "Completed $description."
    return 0
  else
    local status=$?
    log_error "$description exited with status $status."
    return "$status"
  fi
}

cd -- "$repository_root"

case "$job_name" in
  nightly-reconciliation)
    [[ -r "/usr/share/zoneinfo/$nightly_timezone" ]] \
      || fail "timezone data is unavailable for $nightly_timezone"

    current_local_date="$(TZ="$nightly_timezone" date '+%F')"
    current_local_time="$(TZ="$nightly_timezone" date '+%H:%M')"
    [[ "$current_local_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
      || fail "the Toronto calendar date could not be determined"
    [[ "$current_local_time" =~ ^[0-9]{2}:[0-9]{2}$ ]] \
      || fail "the Toronto local time could not be determined"

    # The UTC host invokes at both possible offsets. Exactly one invocation is
    # 04:15 Toronto local time across EST/EDT; the other exits without a reset.
    if [[ "$current_local_time" != "$nightly_due_time" ]]; then
      log "Nightly reconciliation is not due at $current_local_time $nightly_timezone."
      exit 0
    fi

    last_reconciled_date=""
    if [[ -f "$nightly_stamp_file" && ! -L "$nightly_stamp_file" ]]; then
      IFS= read -r last_reconciled_date <"$nightly_stamp_file" || true
    fi
    if [[ "$last_reconciled_date" == "$current_local_date" ]]; then
      log "Nightly reconciliation already completed for $current_local_date $nightly_timezone."
      exit 0
    fi

    run_and_log \
      "nightly demo-sandbox reconciliation for $current_local_date $nightly_timezone" \
      /bin/bash "$repository_root/deploy/demo-sandbox/run-nightly-reconciliation.sh"

    temporary_stamp="$(mktemp "$state_dir/.nightly-reconciliation.XXXXXX")"
    printf '%s\n' "$current_local_date" >"$temporary_stamp"
    chmod 0600 -- "$temporary_stamp"
    mv -f -- "$temporary_stamp" "$nightly_stamp_file"
    ;;
  backup)
    run_and_log \
      "encrypted database backup" \
      /bin/bash "$repository_root/deploy/backup/run-scheduled-backup.sh"
    ;;
  accounting-evidence)
    run_and_log \
      "immutable accounting-evidence verification" \
      /bin/bash "$repository_root/deploy/monitoring/run-accounting-evidence-check.sh"
    ;;
  monitor)
    run_and_log \
      "production readiness monitor" \
      /bin/bash "$repository_root/deploy/monitoring/check-production.sh"
    ;;
esac

write_job_status succeeded
