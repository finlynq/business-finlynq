#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"
readonly scheduler_lock_file="$state_dir/scheduler.lock"
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_directory/../.." && pwd -P)"
readonly schedule_file="$repository_root/deploy/cron/managed-crontab"
readonly begin_marker="# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE"
readonly end_marker="# END BUSINESS FINLYNQ MANAGED SCHEDULE"

fail() {
  printf 'Business Finlynq cron removal failed: %s\n' "$1" >&2
  exit 1
}

require_managed="false"
expected_schedule_file="$schedule_file"
while (( $# > 0 )); do
  case "$1" in
    --require-managed)
      require_managed="true"
      shift
      ;;
    --expected-schedule)
      (( $# >= 2 )) || fail "--expected-schedule requires a file"
      expected_schedule_file="$2"
      shift 2
      ;;
    *) fail "unknown removal option: $1" ;;
  esac
done

for command_name in awk chmod cmp crontab flock grep id mktemp rm; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

[[ "$(id -un)" == "deploy" ]] \
  || fail "removal must run as the exact deploy account"
if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
  fail "the deploy account is unavailable"
fi
[[ "$(id -u)" == "$deploy_uid" ]] \
  || fail "removal resolved a different deploy uid"
[[ -f "$schedule_file" && ! -L "$schedule_file" ]] \
  || fail "the committed managed schedule is missing or is a symbolic link"
[[ -f "$expected_schedule_file" && ! -L "$expected_schedule_file" ]] \
  || fail "the expected installed schedule is missing or is a symbolic link"

mkdir -p -- "$state_dir"
chmod 0700 -- "$state_dir"
touch -- "$scheduler_lock_file"
chmod 0600 -- "$scheduler_lock_file"

# Every scheduled wrapper holds a shared lock for its complete run. Taking the
# exclusive lock first drains active jobs and makes already-queued invocations
# skip before the marked crontab block is changed.
exec 7>"$scheduler_lock_file"
flock --exclusive --wait 7200 7 \
  || fail "timed out waiting for active scheduled jobs to finish"

existing_crontab_file="$(mktemp)"
crontab_error_file="$(mktemp)"
managed_block_file="$(mktemp)"
temporary_crontab="$(mktemp)"
verified_crontab_file="$(mktemp)"
verified_error_file="$(mktemp)"
cleanup() {
  rm -f -- "$existing_crontab_file" "$crontab_error_file" "$managed_block_file" \
    "$temporary_crontab" "$verified_crontab_file" "$verified_error_file"
}
trap cleanup EXIT INT TERM

read_current_crontab() {
  local output_file="$1" error_file="$2" status=0
  : >"$output_file"
  : >"$error_file"
  if LC_ALL=C crontab -l >"$output_file" 2>"$error_file"; then
    return 0
  else
    status=$?
  fi
  if [[ "$status" == "1" && ! -s "$output_file" ]] \
    && grep -Fqx 'no crontab for deploy' "$error_file"; then
    : >"$output_file"
    return 0
  fi
  fail "the deploy crontab could not be read safely (status $status)"
}

read_current_crontab "$existing_crontab_file" "$crontab_error_file"
existing_begin_count="$(grep -Fxc -- "$begin_marker" "$existing_crontab_file" || true)"
existing_end_count="$(grep -Fxc -- "$end_marker" "$existing_crontab_file" || true)"
if [[ "$existing_begin_count" != "$existing_end_count" ]] \
  || (( existing_begin_count > 1 )); then
  fail "the existing crontab contains malformed or duplicate managed markers"
fi
if [[ "$existing_begin_count" == "0" ]]; then
  [[ "$require_managed" == "false" ]] \
    || fail "the exact managed Business Finlynq cron block is not installed"
  printf '%s\n' "The managed Business Finlynq cron schedule is already absent."
  exit 0
fi

awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { managed = 1 }
  managed { print }
  $0 == end && managed { exit }
' "$existing_crontab_file" >"$managed_block_file"
cmp -s -- "$expected_schedule_file" "$managed_block_file" \
  || fail "the installed managed cron block differs from the expected deployed revision"

awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { managed = 1; next }
  $0 == end { managed = 0; next }
  !managed { print }
  END { if (managed) exit 2 }
' "$existing_crontab_file" >"$temporary_crontab" \
  || fail "the existing managed block could not be removed safely"

crontab "$temporary_crontab"
read_current_crontab "$verified_crontab_file" "$verified_error_file"
cmp -s -- "$temporary_crontab" "$verified_crontab_file" \
  || fail "the deploy crontab did not exactly match the verified post-removal content"
printf '%s\n' "Removed only the managed Business Finlynq cron block after active jobs drained."
