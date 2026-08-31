#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_directory/../.." && pwd -P)"
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

for command_name in awk bash chmod cmp crontab env flock grep id logger mktemp rm stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

[[ "$(id -un)" == "deploy" ]] \
  || fail "installation must run as the exact deploy account"
if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
  fail "the deploy account is unavailable"
fi
[[ "$(id -u)" == "$deploy_uid" ]] \
  || fail "installation resolved a different deploy uid"

case "$repository_root" in
  /home/deploy/business-finlynq|/tmp/business-finlynq-release.*/repository) ;;
  *) fail "the managed schedule source is outside an approved release tree: $repository_root" ;;
esac
[[ -d "$repository_root" && ! -L "$repository_root" ]] \
  || fail "the managed schedule source is missing or symbolic"
[[ -f "$schedule_file" && ! -L "$schedule_file" ]] \
  || fail "the managed schedule is missing or is a symbolic link"
[[ -f "$operations_env" && ! -L "$operations_env" ]] \
  || fail "the deploy-owned operations environment is missing or is a symbolic link"
[[ "$(stat -c '%a' -- "$operations_env")" == "600" ]] \
  || fail "$operations_env must have mode 0600"
[[ "$(stat -c '%u' -- "$operations_env")" == "$(id -u)" ]] \
  || fail "$operations_env must be owned by the installing deploy user"

maintenance_scheduler="$(env -i "PATH=$PATH" bash --noprofile --norc -c '
  unset MONITOR_MAINTENANCE_SCHEDULER
  # The file is trusted only after its owner, type, and mode are checked.
  source "$1"
  printf "%s" "${MONITOR_MAINTENANCE_SCHEDULER-}"
' bash "$operations_env")"
[[ "$maintenance_scheduler" == "cron" ]] \
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

existing_crontab_file="$(mktemp)"
crontab_error_file="$(mktemp)"
unmanaged_crontab_file="$(mktemp)"
temporary_crontab="$(mktemp)"
verified_crontab_file="$(mktemp)"
verified_error_file="$(mktemp)"
cleanup() {
  rm -f -- "$existing_crontab_file" "$crontab_error_file" "$unmanaged_crontab_file" \
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

awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { managed = 1; next }
  $0 == end { managed = 0; next }
  !managed { print }
  END { if (managed) exit 2 }
' "$existing_crontab_file" >"$unmanaged_crontab_file" \
  || fail "the existing managed block could not be removed safely"

if [[ -s "$unmanaged_crontab_file" ]]; then
  cat -- "$unmanaged_crontab_file" >"$temporary_crontab"
  printf '\n' >>"$temporary_crontab"
fi
cat -- "$schedule_file" >>"$temporary_crontab"
printf '\n' >>"$temporary_crontab"

crontab "$temporary_crontab"
read_current_crontab "$verified_crontab_file" "$verified_error_file"
cmp -s -- "$temporary_crontab" "$verified_crontab_file" \
  || fail "the installed deploy crontab does not exactly match the verified candidate content"
printf '%s\n' "Installed the managed Business Finlynq cron schedule without replacing unrelated entries."
