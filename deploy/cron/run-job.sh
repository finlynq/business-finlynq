#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly repository_root="/home/deploy/business-finlynq"
readonly operations_env="/home/deploy/.config/business-finlynq/operations.env"
readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"
readonly scheduler_lock_file="$state_dir/scheduler.lock"
readonly maintenance_lock_file="$state_dir/demo-sandbox-maintenance.lock"
readonly nightly_stamp_file="$state_dir/nightly-reconciliation.date"
readonly nightly_timezone="America/Toronto"
readonly nightly_due_hour=4

fail() {
  if command -v logger >/dev/null 2>&1; then
    logger --priority user.err --tag business-finlynq-cron -- "$1" || true
  fi
  printf 'Business Finlynq scheduled job failed: %s\n' "$1" >&2
  exit 1
}

(( $# == 1 )) || fail "exactly one allowlisted job name is required"
readonly job_name="$1"
case "$job_name" in
  dirty-reset|nightly-reconciliation|backup|monitor) ;;
  *) fail "job is not allowlisted" ;;
esac

for command_name in date flock logger stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

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

set -a
# The file is trusted only after its owner, type, and restrictive mode are checked.
# shellcheck disable=SC1091
source "$operations_env"
set +a

mkdir -p -- "$state_dir/locks"
chmod 0700 -- "$state_dir" "$state_dir/locks"
export DEMO_RESET_LOCK_FILE="$maintenance_lock_file"

exec 7>"$scheduler_lock_file"
if ! flock --shared --nonblock 7; then
  log "The managed schedule is paused; this $job_name invocation was skipped."
  exit 0
fi

readonly job_lock_file="$state_dir/locks/$job_name.lock"
exec 8>"$job_lock_file"
if ! flock --nonblock 8; then
  log "A previous $job_name pass still holds its lock; this invocation was skipped."
  exit 0
fi

run_and_log() {
  local description="$1"
  shift

  log "Starting $description."
  if "$@" \
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
  dirty-reset)
    run_and_log \
      "incremental demo-sandbox reset" \
      /bin/bash "$repository_root/deploy/demo-sandbox/run-dirty-reset.sh"
    ;;
  nightly-reconciliation)
    [[ -r "/usr/share/zoneinfo/$nightly_timezone" ]] \
      || fail "timezone data is unavailable for $nightly_timezone"

    current_local_date="$(TZ="$nightly_timezone" date '+%F')"
    current_local_hour="$(TZ="$nightly_timezone" date '+%H')"
    [[ "$current_local_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
      || fail "the Toronto calendar date could not be determined"
    [[ "$current_local_hour" =~ ^[0-9]{2}$ ]] \
      || fail "the Toronto local hour could not be determined"

    if (( 10#$current_local_hour < nightly_due_hour )); then
      log "Nightly reconciliation is not due before 04:00 $nightly_timezone."
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
  monitor)
    run_and_log \
      "production readiness monitor" \
      /bin/bash "$repository_root/deploy/monitoring/check-production.sh"
    ;;
esac
