#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Scheduled-unit contract verification failed: %s\n' "$1" >&2
  exit 1
}

verify_monitor_monotonic_records() {
  local timers_monotonic="$1" record
  local boot_record_count=0 unit_active_record_count=0
  local -a monotonic_records=()

  mapfile -t monotonic_records <<<"$timers_monotonic"
  [[ "${#monotonic_records[@]}" == 2 ]] || return 1
  for record in "${monotonic_records[@]}"; do
    if [[ "$record" =~ ^\{\ OnBootUSec=2min\ \;\ next_elapse=[^}]+\ \}$ ]]; then
      boot_record_count=$((boot_record_count + 1))
    elif [[ "$record" =~ ^\{\ OnUnitActiveUSec=5min\ \;\ next_elapse=[^}]+\ \}$ ]]; then
      unit_active_record_count=$((unit_active_record_count + 1))
    else
      return 1
    fi
  done
  [[ "$boot_record_count" == 1 && "$unit_active_record_count" == 1 ]]
}

if [[ "${1:-}" == "--verify-monitor-monotonic-records" ]]; then
  (( $# == 1 )) || fail "monitor monotonic-record verification accepts no other arguments"
  monitor_monotonic_fixture="$(cat)"
  verify_monitor_monotonic_records "$monitor_monotonic_fixture" \
    || fail "monitor monotonic timer records differ from the required cadence"
  exit 0
fi
(( $# == 0 )) || fail "unexpected argument"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/../.." && pwd -P)"
systemd_unit_directory="${BUSINESS_FINLYNQ_SYSTEMD_UNIT_DIRECTORY:-/etc/systemd/system}"

for command_name in cmp grep readlink stat systemctl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
[[ "$systemd_unit_directory" == /* && -d "$systemd_unit_directory" \
  && ! -L "$systemd_unit_directory" ]] \
  || fail "systemd unit directory is unavailable or unsafe"
systemd_unit_directory="$(cd -- "$systemd_unit_directory" && pwd -P)"

readonly operations_environment_file="/etc/business-finlynq/operations.env"
readonly target_root="/home/deploy/business-finlynq"
readonly -a schedule_names=(backup monitor accounting-evidence demo-reconcile)
declare -A expected_exec_start=(
  [backup]="$target_root/deploy/backup/run-scheduled-backup.sh"
  [monitor]="$target_root/deploy/monitoring/check-production.sh"
  [accounting-evidence]="/bin/bash $target_root/deploy/monitoring/run-accounting-evidence-check.sh"
  [demo-reconcile]="/bin/bash $target_root/deploy/demo-sandbox/run-nightly-reconciliation.sh"
)
declare -A expected_timeout_unit=(
  [backup]="95m"
  [monitor]="5m"
  [accounting-evidence]="16m"
  [demo-reconcile]="2h"
)
declare -A expected_timeout_loaded=(
  [backup]="1h 35min"
  [monitor]="5min"
  [accounting-evidence]="16min"
  [demo-reconcile]="2h"
)
declare -A expected_calendar=(
  [backup]="*-*-* 00,04,08,12,16,20:17:00 UTC"
  [monitor]=""
  [accounting-evidence]="*-*-* 01,05,09,13,17,21:47:00 UTC"
  [demo-reconcile]="*-*-* 04:15:00 America/Toronto"
)
declare -A expected_jitter_unit=(
  [backup]="10m"
  [monitor]="30s"
  [accounting-evidence]="10m"
  [demo-reconcile]=""
)
declare -A expected_jitter_loaded=(
  [backup]="10min"
  [monitor]="30s"
  [accounting-evidence]="10min"
  [demo-reconcile]="0"
)

for schedule_name in "${schedule_names[@]}"; do
  service_name="business-finlynq-$schedule_name.service"
  timer_name="business-finlynq-$schedule_name.timer"
  committed_service="$repository_root/deploy/systemd/$service_name"
  committed_timer="$repository_root/deploy/systemd/$timer_name"
  installed_service="$systemd_unit_directory/$service_name"
  installed_timer="$systemd_unit_directory/$timer_name"
  for unit_path in "$committed_service" "$committed_timer" "$installed_service" "$installed_timer"; do
    [[ -f "$unit_path" && ! -L "$unit_path" ]] \
      || fail "$schedule_name unit is missing or symbolic: $unit_path"
  done
  [[ "$(stat -c '%u:%g:%a' "$installed_service")" == "0:0:644" \
    && "$(stat -c '%u:%g:%a' "$installed_timer")" == "0:0:644" ]] \
    || fail "installed $schedule_name units are not root-owned mode 0644"
  cmp -s -- "$committed_service" "$installed_service" \
    || fail "installed $schedule_name service differs from the committed candidate"
  cmp -s -- "$committed_timer" "$installed_timer" \
    || fail "installed $schedule_name timer differs from the committed candidate"

  grep -Fqx "WorkingDirectory=$target_root" "$installed_service" \
    || fail "installed $schedule_name service has the wrong WorkingDirectory"
  grep -Fqx "EnvironmentFile=$operations_environment_file" "$installed_service" \
    || fail "installed $schedule_name service has the wrong EnvironmentFile"
  grep -Fqx "ExecCondition=/bin/bash $target_root/deploy/systemd/check-scheduler-boundary.sh" \
    "$installed_service" \
    || fail "installed $schedule_name service has the wrong scheduler boundary condition"
  grep -Fqx "ExecStart=${expected_exec_start[$schedule_name]}" "$installed_service" \
    || fail "installed $schedule_name service has the wrong ExecStart"
  grep -Fqx "TimeoutStartSec=${expected_timeout_unit[$schedule_name]}" "$installed_service" \
    || fail "installed $schedule_name service has the wrong timeout"
  grep -Fqx "Unit=$service_name" "$installed_timer" \
    || fail "installed $schedule_name timer targets the wrong service"
  grep -Fqx 'Persistent=true' "$installed_timer" \
    || fail "installed $schedule_name timer is not persistent"
  if [[ -n "${expected_calendar[$schedule_name]}" ]]; then
    grep -Fqx "OnCalendar=${expected_calendar[$schedule_name]}" "$installed_timer" \
      || fail "installed $schedule_name timer has the wrong calendar"
  else
    grep -Fqx 'OnBootSec=2m' "$installed_timer" \
      || fail "installed monitor timer has the wrong boot delay"
    grep -Fqx 'OnUnitActiveSec=5m' "$installed_timer" \
      || fail "installed monitor timer has the wrong recurrence"
  fi
  if [[ -n "${expected_jitter_unit[$schedule_name]}" ]]; then
    grep -Fqx "RandomizedDelaySec=${expected_jitter_unit[$schedule_name]}" "$installed_timer" \
      || fail "installed $schedule_name timer has the wrong randomized delay"
  elif grep -Eq '^RandomizedDelaySec=' "$installed_timer"; then
    fail "installed $schedule_name timer has an unexpected randomized delay"
  fi

  [[ "$(systemctl show --property=LoadState --value "$service_name")" == "loaded" \
    && "$(systemctl show --property=LoadState --value "$timer_name")" == "loaded" ]] \
    || fail "$schedule_name units are not loaded"
  service_fragment="$(systemctl show --property=FragmentPath --value "$service_name")"
  timer_fragment="$(systemctl show --property=FragmentPath --value "$timer_name")"
  [[ "$(readlink -f -- "$service_fragment")" == "$(readlink -f -- "$installed_service")" \
    && "$(readlink -f -- "$timer_fragment")" == "$(readlink -f -- "$installed_timer")" ]] \
    || fail "systemd loaded $schedule_name units from an unexpected fragment"
  [[ "$(systemctl show --property=Unit --value "$timer_name")" == "$service_name" ]] \
    || fail "loaded $schedule_name timer targets the wrong service"
  [[ "$(systemctl show --property=Persistent --value "$timer_name")" == "yes" ]] \
    || fail "loaded $schedule_name timer is not persistent"
  [[ "$(systemctl show --property=RandomizedDelayUSec --value "$timer_name")" \
    == "${expected_jitter_loaded[$schedule_name]}" ]] \
    || fail "loaded $schedule_name timer randomized delay differs from the candidate"
  if [[ -n "${expected_calendar[$schedule_name]}" ]]; then
    systemd_calendar="$(systemctl show --property=TimersCalendar --value "$timer_name")"
    [[ "$systemd_calendar" == *"${expected_calendar[$schedule_name]}"* ]] \
      || fail "loaded $schedule_name timer calendar differs from the candidate"
  else
    # Some systemd releases expose monotonic timer triggers only through the
    # aggregate TimersMonotonic property. Accept either representation while
    # requiring both exact trigger records.
    timer_on_boot="$(systemctl show --property=OnBootUSec --value "$timer_name")"
    timer_on_unit_active="$(systemctl show --property=OnUnitActiveUSec --value "$timer_name")"
    if [[ -n "$timer_on_boot" || -n "$timer_on_unit_active" ]]; then
      [[ "$timer_on_boot" == "2min" && "$timer_on_unit_active" == "5min" ]] \
        || fail "loaded monitor timer cadence differs from the candidate"
    else
      timers_monotonic="$(systemctl show --property=TimersMonotonic --value "$timer_name")"
      verify_monitor_monotonic_records "$timers_monotonic" \
        || fail "loaded monitor timer cadence differs from the candidate"
    fi
  fi
  systemd_exec_start="$(systemctl show --property=ExecStart --value "$service_name")"
  expected_exec_binary="${expected_exec_start[$schedule_name]%% *}"
  [[ "$systemd_exec_start" == *"path=$expected_exec_binary"* \
    && "$systemd_exec_start" == *"argv[]=${expected_exec_start[$schedule_name]}"* ]] \
    || fail "loaded $schedule_name service ExecStart differs from the candidate"
  systemd_exec_condition="$(systemctl show --property=ExecCondition --value "$service_name")"
  [[ "$systemd_exec_condition" == *'path=/bin/bash'* \
    && "$systemd_exec_condition" == *"argv[]=/bin/bash $target_root/deploy/systemd/check-scheduler-boundary.sh"* ]] \
    || fail "loaded $schedule_name service scheduler boundary condition differs from the candidate"
  [[ "$(systemctl show --property=EnvironmentFiles --value "$service_name")" \
    == "$operations_environment_file (ignore_errors=no)" ]] \
    || fail "loaded $schedule_name service EnvironmentFile differs from the candidate"
  [[ "$(systemctl show --property=WorkingDirectory --value "$service_name")" == "$target_root" ]] \
    || fail "loaded $schedule_name service WorkingDirectory differs from the candidate"
  [[ "$(systemctl show --property=TimeoutStartUSec --value "$service_name")" \
    == "${expected_timeout_loaded[$schedule_name]}" ]] \
    || fail "loaded $schedule_name service timeout differs from the candidate"
  if [[ "$schedule_name" == "monitor" || "$schedule_name" == "accounting-evidence" ]]; then
    [[ "$(systemctl show --property=Group --value "$service_name")" == "deploy" \
      && "$(systemctl show --property=StateDirectory --value "$service_name")" == "business-finlynq" \
      && "$(systemctl show --property=StateDirectoryMode --value "$service_name")" == "0775" ]] \
      || fail "loaded $schedule_name shared metrics ownership differs from the candidate"
  elif [[ "$schedule_name" == "demo-reconcile" ]]; then
    [[ "$(systemctl show --property=StateDirectory --value "$service_name")" == "business-finlynq" \
      && "$(systemctl show --property=StateDirectoryMode --value "$service_name")" == "0775" \
      && "$(systemctl show --property=Environment --value "$service_name")" \
        == *"DEMO_RESET_LOCK_FILE=/var/lib/business-finlynq/demo-sandbox-maintenance.lock"* ]] \
      || fail "loaded demo-reconcile writable lock state differs from the candidate"
  fi
done

printf '%s\n' "Installed Business Finlynq scheduled service/timer contracts match the committed candidate"
