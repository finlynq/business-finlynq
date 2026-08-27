#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly repository_root="/home/deploy/business-finlynq"
readonly operations_env="/home/deploy/.config/business-finlynq/operations.env"
readonly state_dir="/home/deploy/.local/state/business-finlynq/cron"
readonly schedule_file="$repository_root/deploy/cron/managed-crontab"
readonly begin_marker="# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE"
readonly end_marker="# END BUSINESS FINLYNQ MANAGED SCHEDULE"

fail() {
  printf 'Business Finlynq cron installation failed: %s\n' "$1" >&2
  exit 1
}

(( $# == 0 )) || fail "this installer does not accept arguments"

for command_name in awk chmod crontab flock grep id logger mktemp stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

[[ -d "$repository_root/.git" ]] \
  || fail "the reviewed repository checkout is missing at $repository_root"
[[ -f "$schedule_file" && ! -L "$schedule_file" ]] \
  || fail "the managed schedule is missing or is a symbolic link"
[[ -f "$operations_env" && ! -L "$operations_env" ]] \
  || fail "the deploy-owned operations environment is missing or is a symbolic link"
[[ "$(stat -c '%a' -- "$operations_env")" == "600" ]] \
  || fail "$operations_env must have mode 0600"
[[ "$(stat -c '%u' -- "$operations_env")" == "$(id -u)" ]] \
  || fail "$operations_env must be owned by the installing deploy user"

set -a
# The file is trusted only after its owner, type, and restrictive mode are checked.
# shellcheck disable=SC1091
source "$operations_env"
set +a
[[ "${MONITOR_MAINTENANCE_SCHEDULER:-systemd}" == "cron" ]] \
  || fail "$operations_env must set MONITOR_MAINTENANCE_SCHEDULER=cron"

begin_count="$(grep -Fxc -- "$begin_marker" "$schedule_file" || true)"
end_count="$(grep -Fxc -- "$end_marker" "$schedule_file" || true)"
[[ "$begin_count" == "1" && "$end_count" == "1" ]] \
  || fail "the committed managed schedule has invalid boundary markers"

mkdir -p -- "$state_dir/locks"
chmod 0700 -- "$state_dir" "$state_dir/locks"
touch -- "$state_dir/demo-sandbox-maintenance.lock"
chmod 0600 -- "$state_dir/demo-sandbox-maintenance.lock"
touch -- "$state_dir/scheduler.lock"
chmod 0600 -- "$state_dir/scheduler.lock"

# Serialize installation with every scheduled wrapper. Existing wrappers drain
# under their shared locks; invocations queued during the update skip safely.
exec 7>"$state_dir/scheduler.lock"
flock --exclusive --wait 7200 7 \
  || fail "timed out waiting for active scheduled jobs to finish"

existing_crontab="$(crontab -l 2>/dev/null || true)"
existing_begin_count="$(grep -Fxc -- "$begin_marker" <<<"$existing_crontab" || true)"
existing_end_count="$(grep -Fxc -- "$end_marker" <<<"$existing_crontab" || true)"
if [[ "$existing_begin_count" != "$existing_end_count" ]] \
  || (( existing_begin_count > 1 )); then
  fail "the existing crontab contains malformed or duplicate managed markers"
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
  printf '%s\n\n' "$unmanaged_crontab" >"$temporary_crontab"
fi
cat -- "$schedule_file" >>"$temporary_crontab"
printf '\n' >>"$temporary_crontab"

crontab "$temporary_crontab"
printf '%s\n' "Installed the managed Business Finlynq cron schedule without replacing unrelated entries."
