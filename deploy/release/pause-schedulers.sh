#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_dir/../.." && pwd -P)"

fail() {
  printf 'Business Finlynq scheduler pause failed: %s\n' "$1" >&2
  exit 1
}

(( $# >= 1 )) || fail "pass one scheduler mode"
readonly scheduler_mode="$1"
shift
[[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
  || fail "scheduler mode must be systemd or cron"
allow_already_paused="false"
expected_cron_schedule=""
while (( $# > 0 )); do
  case "$1" in
    --allow-already-paused)
      allow_already_paused="true"
      shift
      ;;
    --expected-cron-schedule)
      (( $# >= 2 )) || fail "--expected-cron-schedule requires a file"
      expected_cron_schedule="$2"
      shift 2
      ;;
    *) fail "unknown scheduler pause option: $1" ;;
  esac
done
for command_name in bash chmod chown date docker env grep id install mktemp mv readlink rm rmdir runuser sleep stat sync timeout; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required scheduler-drain command is unavailable: $command_name"
done

local_docker() {
  env -i "PATH=$PATH" docker "$@"
}

scheduled_container_query=""
query_scheduled_containers() {
  local service_name="$1" container_id
  if ! scheduled_container_query="$(local_docker ps --quiet \
    --filter 'label=com.docker.compose.project=business-finlynq' \
    --filter "label=com.docker.compose.service=$service_name")"; then
    fail "could not query running scheduled containers for $service_name"
  fi
  while IFS= read -r container_id; do
    [[ -z "$container_id" || "$container_id" =~ ^[a-f0-9]{12,64}$ ]] \
      || fail "Docker returned an invalid scheduled container ID for $service_name"
  done <<<"$scheduled_container_query"
}

systemd_property() {
  local unit_name="$1" property_name="$2" property_value
  if ! property_value="$(systemctl show --property="$property_name" --value "$unit_name" 2>/dev/null)"; then
    fail "could not query systemd $property_name for $unit_name"
  fi
  [[ -n "$property_value" ]] \
    || fail "systemd returned an empty $property_name for $unit_name"
  printf '%s' "$property_value"
}

systemd_load_state() {
  local unit_name="$1" load_state
  load_state="$(systemd_property "$unit_name" LoadState)"
  case "$load_state" in
    loaded|masked|not-found) printf '%s' "$load_state" ;;
    *) fail "systemd returned an unsafe LoadState '$load_state' for $unit_name" ;;
  esac
}

activate_maintenance_marker() {
  local deploy_uid deploy_gid marker_directory marker_file marker_temporary
  deploy_uid="$(id -u deploy 2>/dev/null)" || fail "maintenance marker requires the deploy account"
  deploy_gid="$(id -g deploy 2>/dev/null)" || fail "maintenance marker requires the deploy group"
  marker_directory="/home/deploy/.local/state/business-finlynq/release-locks"
  marker_file="$marker_directory/scheduler-maintenance"
  [[ -d "$marker_directory" && ! -L "$marker_directory" \
    && "$(readlink -f -- "$marker_directory")" == "$marker_directory" \
    && "$(stat -c '%u:%g:%a' -- "$marker_directory")" == "$deploy_uid:$deploy_gid:700" ]] \
    || fail "maintenance marker directory must be deploy-owned, deploy-grouped, and mode 0700"
  if [[ -e "$marker_file" || -L "$marker_file" ]]; then
    [[ -f "$marker_file" && ! -L "$marker_file" \
      && "$(stat -c '%u:%g:%a' -- "$marker_file")" == "$deploy_uid:$deploy_gid:600" ]] \
      || fail "existing scheduler maintenance marker is unsafe"
    sync -f -- "$marker_file"
    sync -f -- "$marker_directory"
    return 0
  fi
  marker_temporary="$(mktemp "$marker_directory/.scheduler-maintenance.XXXXXX")"
  printf 'pausedAt=%s\nmode=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$scheduler_mode" \
    >"$marker_temporary"
  chmod 0600 -- "$marker_temporary"
  if [[ "$(id -u)" == "0" ]]; then
    chown -- "$deploy_uid:$deploy_gid" "$marker_temporary"
  fi
  [[ "$(stat -c '%u:%g:%a' -- "$marker_temporary")" == "$deploy_uid:$deploy_gid:600" ]] \
    || fail "scheduler maintenance marker temporary file has unsafe ownership or mode"
  sync -f -- "$marker_temporary"
  mv -- "$marker_temporary" "$marker_file"
  sync -f -- "$marker_directory"
}

contain_orphaned_scheduled_containers() {
  local service_name container_id remaining
  local -a running_ids=()
  for service_name in provision_backup backup verify_latest_backup \
    verify_accounting_evidence reconcile_demo_sandboxes; do
    query_scheduled_containers "$service_name"
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && running_ids+=("$container_id")
    done <<<"$scheduled_container_query"
  done
  (( ${#running_ids[@]} > 0 )) || return 0

  printf 'Detected orphaned scheduled Compose containers after %s drain: %s\n' \
    "$scheduler_mode" "${running_ids[*]}" >&2
  timeout 2m env -i "PATH=$PATH" docker stop --time 30 -- "${running_ids[@]}" \
    >/dev/null 2>&1 || true

  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    remaining=""
    for service_name in provision_backup backup verify_latest_backup \
      verify_accounting_evidence reconcile_demo_sandboxes; do
      query_scheduled_containers "$service_name"
      remaining+="$scheduled_container_query"
    done
    [[ -z "$remaining" ]] && break
    sleep 2
  done
  for service_name in provision_backup backup verify_latest_backup \
    verify_accounting_evidence reconcile_demo_sandboxes; do
    query_scheduled_containers "$service_name"
    [[ -z "$scheduled_container_query" ]] \
      || fail "orphaned scheduled Compose container remains running: $service_name"
  done
  fail "orphaned scheduled Compose containers were stopped; inspect them before retrying the release"
}

verify_deploy_cron_absent() {
  command -v runuser >/dev/null 2>&1 || fail "runuser is unavailable for deploy-crontab verification"
  [[ "$(id -u)" == "0" ]] || fail "systemd scheduler mode must run as root to verify the deploy crontab"
  local output_file error_file status=0 cron_text=""
  output_file="$(mktemp)"
  error_file="$(mktemp)"
  if LC_ALL=C runuser -u deploy -- crontab -l >"$output_file" 2>"$error_file"; then
    status=0
  else
    status=$?
  fi
  if (( status == 0 )); then
    cron_text="$(<"$output_file")"
  elif [[ "$status" == "1" ]] \
    && grep -Fqx 'no crontab for deploy' "$error_file" \
    && [[ ! -s "$output_file" ]]; then
    cron_text=""
  else
    rm -f -- "$output_file" "$error_file"
    fail "could not read the deploy crontab while proving the alternate scheduler inactive"
  fi
  rm -f -- "$output_file" "$error_file"
  [[ "$(grep -Fxc '# BEGIN BUSINESS FINLYNQ MANAGED SCHEDULE' <<<"$cron_text" || true)" == "0" \
    && "$(grep -Fxc '# END BUSINESS FINLYNQ MANAGED SCHEDULE' <<<"$cron_text" || true)" == "0" ]] \
    || fail "the deploy-owned cron scheduler remains installed while systemd mode is selected"
}

remove_exact_deploy_cron_if_present() {
  [[ -n "$expected_cron_schedule" ]] || {
    verify_deploy_cron_absent
    return
  }
  [[ "$(id -u)" == "0" ]] \
    || fail "only root may bridge exact deploy-crontab removal during a systemd pause"
  [[ -f "$expected_cron_schedule" && ! -L "$expected_cron_schedule" ]] \
    || fail "the expected deployed cron schedule is missing or symbolic"
  local deploy_uid deploy_gid bridge_root bridge_repository bridge_cron expected_copy status=0
  deploy_uid="$(id -u deploy 2>/dev/null)" || fail "deploy account is unavailable for cron transition"
  deploy_gid="$(id -g deploy 2>/dev/null)" || fail "deploy group is unavailable for cron transition"
  bridge_root="$(mktemp -d /tmp/business-finlynq-cron-pause.XXXXXX)"
  chown -- "$deploy_uid:$deploy_gid" "$bridge_root"
  chmod 0700 -- "$bridge_root"
  bridge_repository="$bridge_root/repository"
  bridge_cron="$bridge_repository/deploy/cron"
  expected_copy="$bridge_root/expected-managed-crontab"
  install -d -o "$deploy_uid" -g "$deploy_gid" -m 0700 \
    "$bridge_repository" "$bridge_repository/deploy" "$bridge_cron"
  install -o "$deploy_uid" -g "$deploy_gid" -m 0700 \
    "$repository_root/deploy/cron/remove.sh" "$bridge_cron/remove.sh"
  install -o "$deploy_uid" -g "$deploy_gid" -m 0600 \
    "$repository_root/deploy/cron/managed-crontab" "$bridge_cron/managed-crontab"
  install -o "$deploy_uid" -g "$deploy_gid" -m 0600 \
    "$expected_cron_schedule" "$expected_copy"
  if env -i "PATH=$PATH" runuser -u deploy -- \
    env -i HOME=/home/deploy USER=deploy LOGNAME=deploy PATH="$PATH" \
    bash "$bridge_cron/remove.sh" --expected-schedule "$expected_copy"; then
    status=0
  else
    status=$?
  fi
  rm -f -- "$expected_copy" "$bridge_cron/remove.sh" "$bridge_cron/managed-crontab"
  rmdir -- "$bridge_cron" "$bridge_repository/deploy" "$bridge_repository" "$bridge_root" \
    || fail "temporary deploy-crontab transition bridge could not be removed safely"
  (( status == 0 )) || fail "the exact previous deploy-owned cron schedule could not be paused"
  verify_deploy_cron_absent
}

verify_systemd_scheduler_absent() {
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable for alternate-scheduler verification"
  local unit load_state state unit_file_state
  for unit in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    load_state="$(systemd_load_state "$unit")"
    [[ "$load_state" != "not-found" ]] || continue
    state="$(systemd_property "$unit" ActiveState)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] \
      || fail "systemd scheduler remains active while cron mode is selected: $unit ($state)"
    unit_file_state="$(systemd_property "$unit" UnitFileState)"
    [[ "$unit_file_state" == "disabled" || "$unit_file_state" == "masked" ]] \
      || fail "systemd scheduler remains enabled across reboot while cron mode is selected: $unit ($unit_file_state)"
  done
  for unit in business-finlynq-backup.service business-finlynq-monitor.service \
    business-finlynq-accounting-evidence.service business-finlynq-demo-reconcile.service; do
    load_state="$(systemd_load_state "$unit")"
    [[ "$load_state" != "not-found" ]] || continue
    state="$(systemd_property "$unit" ActiveState)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] \
      || fail "systemd scheduled service is not terminal while cron mode is selected: $unit ($state)"
  done
}

activate_maintenance_marker

if [[ "$scheduler_mode" == "systemd" ]]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
  for timer in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    load_state="$(systemd_load_state "$timer")"
    case "$load_state" in
      loaded) systemctl disable --now "$timer" ;;
      masked) systemctl stop "$timer" ;;
      not-found) ;;
    esac
  done
  readonly drain_deadline=$((SECONDS + 7200))
  for service in business-finlynq-backup.service business-finlynq-monitor.service \
    business-finlynq-accounting-evidence.service business-finlynq-demo-reconcile.service; do
    load_state="$(systemd_load_state "$service")"
    [[ "$load_state" != "not-found" ]] || continue
    while (( SECONDS < drain_deadline )); do
      state="$(systemd_property "$service" ActiveState)"
      case "$state" in
        inactive|failed) break ;;
        active|activating|deactivating|reloading) sleep 10 ;;
        "") fail "scheduled service returned an empty state: $service" ;;
        *) fail "scheduled service returned an unknown state '$state': $service" ;;
      esac
    done
    state="$(systemd_property "$service" ActiveState)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] \
      || fail "scheduled service did not reach an explicit terminal state: $service ($state)"
  done
  for timer in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    load_state="$(systemd_load_state "$timer")"
    [[ "$load_state" != "not-found" ]] || continue
    state="$(systemd_property "$timer" ActiveState)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] \
      || fail "scheduler remains active: $timer ($state)"
    unit_file_state="$(systemd_property "$timer" UnitFileState)"
    [[ "$unit_file_state" == "disabled" || "$unit_file_state" == "masked" ]] \
      || fail "scheduler remains enabled across reboot: $timer ($unit_file_state)"
  done
  remove_exact_deploy_cron_if_present
else
  command -v id >/dev/null 2>&1 || fail "id is unavailable"
  [[ "$(id -un)" == "deploy" ]] \
    || fail "cron scheduler pause must run as the exact deploy account"
  if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
    fail "cron scheduler pause requires the deploy account"
  fi
  [[ "$(id -u)" == "$deploy_uid" ]] \
    || fail "cron scheduler pause resolved a different deploy uid"
  if [[ "$allow_already_paused" == "true" ]]; then
    if [[ -n "$expected_cron_schedule" ]]; then
      bash "$repository_root/deploy/cron/remove.sh" \
        --expected-schedule "$expected_cron_schedule"
    else
      bash "$repository_root/deploy/cron/remove.sh"
    fi
  else
    [[ -n "$expected_cron_schedule" ]] \
      || fail "strict cron pause requires the deployed revision schedule"
    bash "$repository_root/deploy/cron/remove.sh" --require-managed \
      --expected-schedule "$expected_cron_schedule"
  fi
  verify_systemd_scheduler_absent
fi

contain_orphaned_scheduled_containers

printf 'Business Finlynq %s schedulers are paused and drained.\n' "$scheduler_mode"
