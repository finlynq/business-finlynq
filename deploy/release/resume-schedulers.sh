#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
resume_complete="false"

fail() {
  printf 'Business Finlynq scheduler resume failed: %s\n' "$1" >&2
  exit 1
}

(( $# == 1 )) || fail "pass exactly one scheduler mode"
readonly scheduler_mode="$1"
[[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
  || fail "scheduler mode must be systemd or cron"

for command_name in id readlink rm stat sync; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required scheduler-resume command is unavailable: $command_name"
done
deploy_uid="$(id -u deploy 2>/dev/null)" || fail "scheduler resume requires the deploy account"
readonly marker_directory="/home/deploy/.local/state/business-finlynq/release-locks"
readonly marker_file="$marker_directory/scheduler-maintenance"
[[ -d "$marker_directory" && ! -L "$marker_directory" \
  && "$(readlink -f -- "$marker_directory")" == "$marker_directory" \
  && "$(stat -c '%u:%a' -- "$marker_directory")" == "$deploy_uid:700" ]] \
  || fail "maintenance marker directory must be deploy-owned mode 0700"
[[ -f "$marker_file" && ! -L "$marker_file" \
  && "$(stat -c '%u:%a' -- "$marker_file")" == "$deploy_uid:600" ]] \
  || fail "scheduler resume requires the durable deploy-owned maintenance marker"

contain_partial_resume() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )) && [[ "$resume_complete" != "true" ]]; then
    if ! bash "$script_dir/pause-schedulers.sh" "$scheduler_mode" --allow-already-paused; then
      printf '%s\n' "URGENT: a partial scheduler resume could not be contained" >&2
    fi
  fi
  exit "$status"
}
trap contain_partial_resume EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$scheduler_mode" == "systemd" ]]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
  systemctl enable --now business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer
  for timer in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    systemctl is-active --quiet "$timer" || fail "scheduler did not become active: $timer"
    [[ "$(systemctl is-enabled "$timer" 2>/dev/null || true)" == "enabled" ]] \
      || fail "scheduler did not become durably enabled: $timer"
  done
else
  command -v id >/dev/null 2>&1 || fail "id is unavailable"
  [[ "$(id -un)" == "deploy" ]] \
    || fail "cron scheduler resume must run as the exact deploy account"
  if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
    fail "cron scheduler resume requires the deploy account"
  fi
  [[ "$(id -u)" == "$deploy_uid" ]] \
    || fail "cron scheduler resume resolved a different deploy uid"
  bash "$repository_root/deploy/cron/install.sh"
fi

rm -- "$marker_file"
sync -f -- "$marker_directory"
[[ ! -e "$marker_file" && ! -L "$marker_file" ]] \
  || fail "scheduler maintenance marker could not be cleared after guarded resume"
resume_complete="true"
printf 'Business Finlynq %s schedulers resumed as one guarded boundary.\n' "$scheduler_mode"
