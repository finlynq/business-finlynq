#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"
readonly scheduler_lock_file="$state_dir/scheduler.lock"
readonly begin_marker="# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE"
readonly end_marker="# END BUSINESS FINLYNQ MANAGED SCHEDULE"

fail() {
  printf 'Business Finlynq cron removal failed: %s\n' "$1" >&2
  exit 1
}

(( $# == 0 )) || fail "this remover does not accept arguments"

for command_name in awk chmod crontab flock grep mktemp; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

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

existing_crontab="$(crontab -l 2>/dev/null || true)"
existing_begin_count="$(grep -Fxc -- "$begin_marker" <<<"$existing_crontab" || true)"
existing_end_count="$(grep -Fxc -- "$end_marker" <<<"$existing_crontab" || true)"
if [[ "$existing_begin_count" != "$existing_end_count" ]] \
  || (( existing_begin_count > 1 )); then
  fail "the existing crontab contains malformed or duplicate managed markers"
fi
if [[ "$existing_begin_count" == "0" ]]; then
  printf '%s\n' "The managed Business Finlynq cron schedule is already absent."
  exit 0
fi

unmanaged_crontab="$(awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { managed = 1; next }
  $0 == end { managed = 0; next }
  !managed { print }
  END { if (managed) exit 2 }
' <<<"$existing_crontab")" \
  || fail "the existing managed block could not be removed safely"

temporary_crontab="$(mktemp)"
cleanup() {
  rm -f -- "$temporary_crontab"
}
trap cleanup EXIT INT TERM

if [[ -n "$unmanaged_crontab" ]]; then
  printf '%s\n' "$unmanaged_crontab" >"$temporary_crontab"
else
  : >"$temporary_crontab"
fi

crontab "$temporary_crontab"
printf '%s\n' "Removed only the managed Business Finlynq cron block after active jobs drained."
