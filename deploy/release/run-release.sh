#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_dir/../.." && pwd -P)"

mode=""
revision=""
environment_file=""
operations_environment_file=""
evidence_root=""
run_id=""
scheduler_mode=""
stage="argument-validation"
evidence_directory=""
compose_project=""
release_completed="false"
candidate_started="false"
schedulers_paused="false"
rehearsal_cleaned="false"
schedulers_resumed="false"
operations_environment_sha256=""
compose_environment_sha256=""
canonical_environment_file=""
canonical_operations_environment_file=""
environment_snapshot_file=""
operations_environment_snapshot_file=""
candidate_staging_root=""
candidate_source_root=""
candidate_tree_id=""
previous_cron_schedule_file=""
release_backup_timeout_seconds="5400"
release_images_pinned="false"
scheduler_boundary_bootstrap_required="false"
scheduler_boundary_bootstrap_source_revision=""
scheduler_boundary_bootstrap_receipt=""
scheduler_boundary_bootstrap_receipt_sha256=""

usage() {
  cat <<'USAGE'
Usage:
  run-release.sh --mode release --revision <full-sha> --environment <compose.env> \
    --operations-environment <operations.env> --evidence-root <directory> \
    --run-id <id> --scheduler <systemd|cron>

  run-release.sh --mode rehearsal --revision <full-sha> --environment <rehearsal.env> \
    --evidence-root <directory> --run-id rehearsal-<id>

The matching RELEASE_EXECUTION_ACK is mandatory:
  release:<sha>:<run-id>
  rehearsal:<sha>:<run-id>
USAGE
}

fail() {
  printf 'Business Finlynq release failed: %s\n' "$1" >&2
  exit 1
}

git_command_output=""
read_git_output() {
  local selected_repository="$1" description="$2"
  shift 2
  if ! git_command_output="$(git -c safe.directory="$selected_repository" \
    -C "$selected_repository" "$@" 2>/dev/null)"; then
    fail "could not inspect $description in the canonical Git checkout"
  fi
}

assert_clean_checkout() {
  local selected_repository="$1" dirty_message="$2" checkout_status
  if ! checkout_status="$(git -c safe.directory="$selected_repository" \
    -C "$selected_repository" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    fail "$dirty_message because Git status could not be inspected"
  fi
  [[ -z "$checkout_status" ]] || fail "$dirty_message"
}

while (( $# > 0 )); do
  case "$1" in
    --mode|--revision|--environment|--operations-environment|--evidence-root|--run-id|--scheduler)
      (( $# >= 2 )) || fail "$1 requires a value"
      case "$1" in
        --mode) mode="$2" ;;
        --revision) revision="$2" ;;
        --environment) environment_file="$2" ;;
        --operations-environment) operations_environment_file="$2" ;;
        --evidence-root) evidence_root="$2" ;;
        --run-id) run_id="$2" ;;
        --scheduler) scheduler_mode="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$mode" == "release" || "$mode" == "rehearsal" ]] || fail "--mode must be release or rehearsal"
[[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] || fail "--revision must be a non-zero full 40-character Git SHA"
[[ "$run_id" =~ ^[a-z0-9][a-z0-9._-]{2,30}$ ]] || fail "--run-id must be 3-31 lowercase safe characters"
[[ -n "$environment_file" && -n "$evidence_root" ]] || fail "--environment and --evidence-root are required"
[[ "${RELEASE_EXECUTION_ACK:-}" == "$mode:$revision:$run_id" ]] \
  || fail "RELEASE_EXECUTION_ACK must exactly acknowledge mode, revision, and run ID"

if [[ "$mode" == "release" ]]; then
  [[ -n "$operations_environment_file" ]] || fail "--operations-environment is required for a release"
  [[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
    || fail "--scheduler must be systemd or cron for a release"
else
  [[ "$run_id" == rehearsal-* ]] || fail "a rehearsal run ID must begin with rehearsal-"
  [[ -z "$operations_environment_file" && -z "$scheduler_mode" ]] \
    || fail "rehearsal mode does not operate production schedulers or an operations environment"
fi

for command_name in awk bash chmod chown curl date docker env find flock git grep id install jq mkdir mktemp readlink rm sed sha256sum sleep sort stat tar tee timeout touch xargs; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"

# Production releases always use the local Docker socket and the explicitly
# selected Compose files/environment. Do not let DOCKER_*, COMPOSE_*, or
# interpolation variables inherited from an operator shell redirect the daemon
# or override the reviewed environment file.
docker() {
  env -i "PATH=$PATH" docker "$@"
}

docker_query_output=""
read_docker_output() {
  local description="$1"
  shift
  if ! docker_query_output="$(docker "$@")"; then
    fail "could not inspect $description through the local Docker daemon"
  fi
}

validate_secret_environment_file() {
  local selected_file="$1"
  local description="$2"
  [[ -f "$selected_file" && ! -L "$selected_file" ]] || fail "$description must be a regular non-symbolic-link file"
  selected_file="$(readlink -f -- "$selected_file")"
  local mode_bits owner_id
  mode_bits="$(stat -c '%a' -- "$selected_file")"
  owner_id="$(stat -c '%u' -- "$selected_file")"
  [[ "$mode_bits" =~ ^[0-7]{3,4}$ ]] || fail "$description has an unreadable mode"
  (( (8#$mode_bits & 8#077) == 0 )) || fail "$description must not be accessible by group or other users"
  [[ "$owner_id" == "0" || "$owner_id" == "$(id -u)" ]] || fail "$description must be owned by root or the release operator"
  printf '%s' "$selected_file"
}

reject_repository_path() {
  local selected_path="$1"
  local description="$2"
  case "$selected_path" in
    "$repository_root"|"$repository_root"/*)
      fail "$description must remain outside the reviewed repository and Docker build context"
      ;;
  esac
}

assert_deploy_cron_identity() {
  local deploy_uid
  [[ "$(id -un)" == "deploy" ]] \
    || fail "cron scheduler mode must run as the exact deploy account"
  if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
    fail "cron scheduler mode requires the deploy account"
  fi
  [[ "$(id -u)" == "$deploy_uid" ]] \
    || fail "cron scheduler mode resolved a different deploy uid"
}

environment_file="$(validate_secret_environment_file "$environment_file" "Compose environment")"
reject_repository_path "$environment_file" "Compose environment"
canonical_environment_file="$environment_file"
compose_environment_sha256="$(sha256sum "$canonical_environment_file" | awk '{print $1}')"
[[ "$compose_environment_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "Compose environment checksum is invalid"
if [[ "$mode" == "release" ]]; then
  operations_environment_file="$(validate_secret_environment_file "$operations_environment_file" "operations environment")"
  reject_repository_path "$operations_environment_file" "operations environment"
  canonical_operations_environment_file="$operations_environment_file"
  [[ "$repository_root" == "/home/deploy/business-finlynq" ]] \
    || fail "production releases must run from the checkout used by the installed scheduler"
  if [[ "$scheduler_mode" == "systemd" ]]; then
    [[ "$(id -u)" == "0" ]] || fail "systemd releases must run as root"
    [[ "$operations_environment_file" == "/etc/business-finlynq/operations.env" ]] \
      || fail "systemd releases must use the operations environment loaded by the installed units"
  else
    assert_deploy_cron_identity
    [[ "$operations_environment_file" == "/home/deploy/.config/business-finlynq/operations.env" ]] \
      || fail "cron releases must use the deploy-owned operations environment loaded by the wrapper"
    [[ "$(stat -c '%u' -- "$operations_environment_file")" == "$(id -u)" ]] \
      || fail "cron operations environment must be owned by the deploy account"
  fi
  operations_environment_sha256="$(sha256sum "$canonical_operations_environment_file" | awk '{print $1}')"
  [[ "$operations_environment_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || fail "operations environment checksum is invalid"
fi

if [[ "$mode" == "release" ]]; then
  compose_project="business-finlynq"
else
  compose_project="business-finlynq-${run_id//_/-}"
  [[ "$compose_project" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || fail "derived rehearsal Compose project is invalid"
  export RELEASE_REHEARSAL_PROJECT="$compose_project"
fi

acquire_release_coordination_lock() {
  local lock_directory="/home/deploy/.local/state/business-finlynq/release-locks"
  local lock_name="$1"
  local deploy_uid lock_owner lock_mode
  if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
    fail "release coordination requires the deploy account"
  fi
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] \
    || fail "release coordination lock directory is missing or unsafe"
  [[ "$(readlink -f -- "$lock_directory")" == "$lock_directory" ]] \
    || fail "release coordination lock directory resolved unexpectedly"
  [[ "$(stat -c '%u' -- "$lock_directory")" == "$deploy_uid" ]] \
    || fail "release coordination lock directory must be owned by deploy"
  [[ "$(stat -c '%a' -- "$lock_directory")" == "700" ]] \
    || fail "release coordination lock directory must have mode 0700"
  coordination_lock_file="$lock_directory/$lock_name"
  [[ ! -L "$coordination_lock_file" ]] || fail "release coordination lock cannot be a symbolic link"
  if [[ ! -e "$coordination_lock_file" ]]; then
    (umask 077; touch -- "$coordination_lock_file")
    if [[ "$(id -u)" == "0" ]]; then
      chown -- "$deploy_uid" "$coordination_lock_file"
    fi
  fi
  [[ -f "$coordination_lock_file" && ! -L "$coordination_lock_file" ]] \
    || fail "release coordination lock is not a regular file"
  [[ "$(readlink -f -- "$coordination_lock_file")" == "$coordination_lock_file" ]] \
    || fail "release coordination lock escaped its fixed directory"
  lock_owner="$(stat -c '%u' -- "$coordination_lock_file")"
  lock_mode="$(stat -c '%a' -- "$coordination_lock_file")"
  [[ "$lock_owner" == "$deploy_uid" && "$lock_mode" == "600" ]] \
    || fail "release coordination lock must be deploy-owned with mode 0600"
  exec 9>"$coordination_lock_file"
  flock --exclusive --nonblock 9 \
    || fail "another release, rehearsal for this project, or rollback already holds the coordination lock"
}

if [[ "$mode" == "release" ]]; then
  acquire_release_coordination_lock "production-release-rollback.lock"
else
  acquire_release_coordination_lock "rehearsal-$compose_project.lock"
fi

verify_scheduler_boundary_bootstrap() {
  [[ "$mode" == "release" ]] || return 0
  local deploy_uid lock_directory boundary_file receipt_file marker_file
  deploy_uid="$(id -u deploy 2>/dev/null)" \
    || fail "scheduler boundary verification requires the deploy account"
  lock_directory="/home/deploy/.local/state/business-finlynq/release-locks"
  boundary_file="$lock_directory/scheduler-boundary.json"
  receipt_file="$lock_directory/scheduler-boundary-bootstrap.json"
  marker_file="$lock_directory/scheduler-maintenance"

  if [[ -e "$boundary_file" || -L "$boundary_file" ]]; then
    [[ -f "$boundary_file" && ! -L "$boundary_file" \
      && "$(stat -c '%u:%a' -- "$boundary_file")" == "$deploy_uid:600" ]] \
      || fail "installed scheduler boundary record is unsafe"
    jq -e '
      .schemaVersion == 1 and
      .product == "business-finlynq" and
      .boundaryVersion == 1 and
      (.installedRevision | type == "string" and test("^[a-f0-9]{40}$")) and
      (.scheduler == "systemd" or .scheduler == "cron")
    ' "$boundary_file" >/dev/null \
      || fail "installed scheduler boundary record is invalid"
    return 0
  fi

  # The first rollout changes the scheduled entry points themselves. It must
  # therefore be drained from an exact candidate archive *before* the live
  # checkout changes; a pause performed from this already-changed checkout is
  # too late to close that transition window.
  scheduler_boundary_bootstrap_required="true"
  [[ -f "$receipt_file" && ! -L "$receipt_file" \
    && "$(stat -c '%u:%a' -- "$receipt_file")" == "$deploy_uid:600" ]] \
    || fail "the first scheduler-boundary rollout requires the protected pre-checkout bootstrap receipt"
  [[ -f "$marker_file" && ! -L "$marker_file" \
    && "$(stat -c '%u:%a' -- "$marker_file")" == "$deploy_uid:600" ]] \
    || fail "the first scheduler-boundary rollout requires schedulers to remain durably paused"
  jq -e \
    --arg revision "$revision" \
    --arg scheduler "$scheduler_mode" '
      .schemaVersion == 1 and
      .product == "business-finlynq" and
      .candidateRevision == $revision and
      .scheduler == $scheduler and
      (.sourceRevision | type == "string" and test("^[a-f0-9]{40}$")) and
      .sourceRevision != $revision and
      (.pausedAt | type == "string" and length > 0)
    ' "$receipt_file" >/dev/null \
    || fail "the pre-checkout scheduler-boundary receipt does not match this release"
  scheduler_boundary_bootstrap_source_revision="$(jq -r '.sourceRevision' "$receipt_file")"
  scheduler_boundary_bootstrap_receipt="$receipt_file"
  scheduler_boundary_bootstrap_receipt_sha256="$(sha256sum "$receipt_file" | awk '{print $1}')"
  [[ "$scheduler_boundary_bootstrap_receipt_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || fail "the pre-checkout scheduler-boundary receipt checksum is invalid"
}

verify_scheduler_boundary_bootstrap

cd -- "$repository_root"
read_git_output "$repository_root" "repository root" rev-parse --show-toplevel
[[ "$git_command_output" == "$repository_root" ]] || fail "script is not running from the reviewed repository root"
read_git_output "$repository_root" "checked-out HEAD" rev-parse HEAD
[[ "$git_command_output" == "$revision" ]] || fail "the requested revision is not the checked-out HEAD"
git cat-file -e "$revision^{commit}" 2>/dev/null || fail "the requested revision is not a local Git commit"
assert_clean_checkout "$repository_root" "the checkout is not clean"

[[ "$evidence_root" == /* ]] || fail "--evidence-root must be an absolute path"
evidence_root="$(readlink -m -- "$evidence_root")"
reject_repository_path "$evidence_root" "evidence root"
mkdir -p -- "$evidence_root"
[[ -d "$evidence_root" && ! -L "$evidence_root" ]] || fail "evidence root must be a non-symbolic-link directory"
evidence_root="$(cd -- "$evidence_root" && pwd -P)"
[[ "$evidence_root" != "/" ]] || fail "the filesystem root cannot be used for release evidence"
evidence_directory="$evidence_root/$revision/$run_id"
[[ ! -e "$evidence_directory" ]] || fail "the evidence directory already exists; run IDs are immutable"
mkdir -p -- "$evidence_directory"
chmod 0700 -- "$evidence_root" "$evidence_root/$revision" "$evidence_directory"

run_compose() {
  local duration="$1"
  shift
  local assignment key value separator_seen="false"
  local -a controlled_environment=("PATH=$PATH")
  local -a compose_files=(-f "$candidate_source_root/docker-compose.yml")

  if [[ "$mode" == "rehearsal" ]]; then
    controlled_environment+=("RELEASE_REHEARSAL_PROJECT=$compose_project")
    compose_files+=(-f "$candidate_source_root/deploy/release/docker-compose.rehearsal.yml")
  fi
  if [[ "$release_images_pinned" == "true" ]]; then
    controlled_environment+=(
      "BUSINESS_FINLYNQ_RELEASE_DATABASE_IMAGE=${image_ids[database]}"
      "BUSINESS_FINLYNQ_RELEASE_APP_IMAGE=${image_ids[app]}"
      "BUSINESS_FINLYNQ_RELEASE_AUTH_WORKER_IMAGE=${image_ids[authWorker]}"
      "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_IMAGE=${image_ids[acceptance]}"
      "BUSINESS_FINLYNQ_RELEASE_MIGRATOR_IMAGE=${image_ids[migrator]}"
      "BUSINESS_FINLYNQ_RELEASE_OPERATIONS_IMAGE=${image_ids[operations]}"
    )
    compose_files+=(-f "$candidate_source_root/deploy/release/docker-compose.candidate-images.yml")
  fi

  # Callers may override only values owned by a named release stage. Ambient
  # variables never cross this boundary.
  while (( $# > 0 )); do
    if [[ "$1" == "--" ]]; then
      separator_seen="true"
      shift
      break
    fi
    assignment="$1"
    [[ "$assignment" == *=* ]] || fail "invalid controlled Compose override"
    key="${assignment%%=*}"
    value="${assignment#*=}"
    case "$key" in
      BACKUP_SOURCE_APPLICATION_REVISION)
        [[ "$value" =~ ^[a-f0-9]{40}$ && ! "$value" =~ ^0+$ ]] \
          || fail "backup source revision override is invalid"
        ;;
      DEMO_LOGIN_ENABLED|DEMO_WRITES_ENABLED|ACCOUNT_LOGIN_ENABLED|ACCOUNT_SIGNUP_ENABLED|AUTH_EMAIL_DELIVERY_ENABLED|SIGNUP_TURNSTILE_ENABLED|BUSINESS_WRITES_ENABLED|BANK_FEEDS_ENABLED)
        [[ "$value" == "true" || "$value" == "false" ]] \
          || fail "controlled Compose gate override is not boolean: $key"
        ;;
      *) fail "Compose override is not release-owned: $key" ;;
    esac
    controlled_environment+=("$assignment")
    shift
  done
  [[ "$separator_seen" == "true" ]] || fail "controlled Compose invocation lacks its argument separator"

  local -a command=(
    env -i "${controlled_environment[@]}" docker compose
    --project-name "$compose_project"
    --project-directory "$candidate_source_root"
    --env-file "$environment_file"
    "${compose_files[@]}"
  )
  if [[ -n "$duration" ]]; then
    timeout --signal=TERM --kill-after=10s "$duration" "${command[@]}" "$@"
  else
    "${command[@]}" "$@"
  fi
}

compose() {
  run_compose "" -- "$@"
}

compose_with_overrides() {
  run_compose "" "$@"
}

compose_timed() {
  local duration="$1"
  shift
  run_compose "$duration" -- "$@"
}

compose_timed_with_overrides() {
  local duration="$1"
  shift
  run_compose "$duration" "$@"
}

compose_query_output=""
read_compose_output() {
  local description="$1"
  shift
  if ! compose_query_output="$(compose "$@")"; then
    fail "could not inspect $description through the reviewed Compose boundary"
  fi
}

write_checkpoint() {
  local filename="$1"
  local checkpoint="$2"
  jq -n \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg mode "$mode" \
    --arg revision "$revision" \
    --arg runId "$run_id" \
    --arg stage "$checkpoint" \
    '{schemaVersion: 1, product: "business-finlynq", mode: $mode, revision: $revision, runId: $runId, stage: $stage, completedAt: $at}' \
    >"$evidence_directory/$filename"
  chmod 0600 -- "$evidence_directory/$filename"
}

refresh_checksums() {
  [[ -n "$evidence_directory" && -d "$evidence_directory" ]] || return 0
  (
    cd -- "$evidence_directory"
    find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name .SHA256SUMS.partial -print0 \
      | sort -z \
      | xargs -0 -r sha256sum >.SHA256SUMS.partial
    mv -f -- .SHA256SUMS.partial SHA256SUMS
    chmod 0600 SHA256SUMS
  )
}

run_logged() {
  local filename="$1"
  shift
  local status=0
  if "$@" 2>&1 | tee "$evidence_directory/$filename"; then
    status=0
  else
    status="${PIPESTATUS[0]}"
  fi
  chmod 0600 -- "$evidence_directory/$filename"
  return "$status"
}

captured_compose_container_id=""
capture_compose_container_id() {
  local description="$1" candidate
  shift
  local -a candidates=()
  read_compose_output "$description" "$@"
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && candidates+=("$candidate")
  done <<<"$compose_query_output"
  [[ "${#candidates[@]}" == "1" && "${candidates[0]}" =~ ^[a-f0-9]{64}$ ]] \
    || fail "exactly one $description must exist"
  captured_compose_container_id="${candidates[0]}"
}

captured_container_wait_duration="30m"
captured_container_kill_after="10s"
captured_container_log_duration="20s"
captured_container_inspect_duration="10s"
wait_for_captured_containers() {
  local description="$1" service_log_filename="$2" state_evidence_filename="$3"
  local separator_seen="false"
  shift 3
  local contract_label container_id expected_image result index observed_json wait_value
  local wait_output="" wait_status=0 wait_result_status=0 logs_status=0
  local inspect_output="" inspect_status=0 inspection_status=0 state_status=0 image_status=0
  local running_output="" running_status=0 final_running_output="" final_running_status=0
  local validation_status=0 cleanup_status=0 cleanup_attempted="false" final_quiescent
  local container_evidence='[]'
  local inspect_format
  local -a contract_labels=() container_ids=() expected_images=() compose_log_args=()
  local -a wait_results=() inspect_results=() remaining_ids=()
  local -a inspection_succeeded=() actual_images=() observed_statuses=()
  local -a observed_running=() observed_exit_codes=() observed_oom=() observed_error_present=()

  while (( $# > 0 )); do
    if [[ "$1" == "--" ]]; then
      separator_seen="true"
      shift
      break
    fi
    (( $# >= 3 )) || fail "$description wait invocation has an incomplete container contract"
    contract_labels+=("$1")
    container_ids+=("$2")
    expected_images+=("$3")
    shift 3
  done
  compose_log_args=("$@")
  [[ "$separator_seen" == "true" && "${#container_ids[@]}" -gt 0 \
    && "${#compose_log_args[@]}" -gt 0 ]] \
    || fail "$description wait invocation is incomplete"
  [[ "$state_evidence_filename" =~ ^[0-9]{2}-[a-z0-9._-]+\.json$ ]] \
    || fail "$description state evidence filename is unsafe"
  for (( index=0; index<${#container_ids[@]}; index++ )); do
    contract_label="${contract_labels[$index]}"
    container_id="${container_ids[$index]}"
    expected_image="${expected_images[$index]}"
    [[ "$contract_label" =~ ^[a-z][a-z0-9_]{2,63}$ ]] \
      || fail "$description has an invalid container contract label"
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] \
      || fail "$description has an invalid captured container ID"
    [[ "$expected_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || fail "$description has an invalid expected image ID"
    inspection_succeeded+=("false")
    actual_images+=("")
    observed_statuses+=("")
    observed_running+=("")
    observed_exit_codes+=("")
    observed_oom+=("")
    observed_error_present+=("")
  done

  if wait_output="$(timeout --signal=TERM --kill-after="$captured_container_kill_after" \
    "$captured_container_wait_duration" \
    env -i "PATH=$PATH" docker wait "${container_ids[@]}" 2>&1)"; then
    wait_status=0
  else
    wait_status=$?
  fi
  printf '%s\n' "$wait_output"
  while IFS= read -r result; do
    wait_results+=("$result")
  done <<<"$wait_output"
  if [[ "${#wait_results[@]}" != "${#container_ids[@]}" ]]; then
    wait_result_status=1
  else
    for result in "${wait_results[@]}"; do
      [[ "$result" =~ ^[0-9]+$ && "$result" == "0" ]] || wait_result_status=1
    done
  fi

  # Compose log collection is itself TERM/KILL bounded by compose_timed. Logs
  # are retained before a wait or state failure can trigger containment.
  if [[ "$service_log_filename" == "-" ]]; then
    if compose_timed "$captured_container_log_duration" "${compose_log_args[@]}"; then
      logs_status=0
    else
      logs_status=$?
    fi
  elif run_logged "$service_log_filename" compose_timed \
    "$captured_container_log_duration" "${compose_log_args[@]}" >/dev/null; then
    logs_status=0
  else
    logs_status=$?
  fi

  # One bounded Docker call captures only the fields allowed into retained
  # evidence. In particular, State.Error is reduced to a boolean.
  inspect_format='{"image":{{json .Image}},"status":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"errorPresent":{{if .State.Error}}true{{else}}false{{end}}}'
  if inspect_output="$(timeout --signal=TERM --kill-after=5s \
    "$captured_container_inspect_duration" env -i "PATH=$PATH" docker inspect \
    --format "$inspect_format" "${container_ids[@]}" 2>&1)"; then
    inspect_status=0
  else
    inspect_status=$?
    inspection_status=1
  fi
  if [[ "$inspect_status" == "0" ]]; then
    while IFS= read -r observed_json; do
      inspect_results+=("$observed_json")
    done <<<"$inspect_output"
    [[ "${#inspect_results[@]}" == "${#container_ids[@]}" ]] || inspection_status=1
  fi
  if [[ "$inspection_status" == "0" ]]; then
    for (( index=0; index<${#container_ids[@]}; index++ )); do
      observed_json="${inspect_results[$index]}"
      if jq -e '
        type == "object" and
        keys == ["errorPresent", "exitCode", "image", "oomKilled", "running", "status"] and
        (.image | type) == "string" and (.status | type) == "string" and
        (.running | type) == "boolean" and (.exitCode | type) == "number" and
        (.oomKilled | type) == "boolean" and (.errorPresent | type) == "boolean"
      ' <<<"$observed_json" >/dev/null; then
        inspection_succeeded[$index]="true"
        actual_images[$index]="$(jq -r '.image' <<<"$observed_json")"
        observed_statuses[$index]="$(jq -r '.status' <<<"$observed_json")"
        observed_running[$index]="$(jq -r '.running' <<<"$observed_json")"
        observed_exit_codes[$index]="$(jq -r '.exitCode' <<<"$observed_json")"
        observed_oom[$index]="$(jq -r '.oomKilled' <<<"$observed_json")"
        observed_error_present[$index]="$(jq -r '.errorPresent' <<<"$observed_json")"
        [[ "${actual_images[$index]}" =~ ^sha256:[a-f0-9]{64}$ \
          && "${actual_images[$index]}" == "${expected_images[$index]}" ]] \
          || image_status=1
        [[ "${observed_statuses[$index]}" == "exited" \
          && "${observed_running[$index]}" == "false" \
          && "${observed_exit_codes[$index]}" == "0" \
          && "${observed_oom[$index]}" == "false" \
          && "${observed_error_present[$index]}" == "false" ]] \
          || state_status=1
      else
        inspection_status=1
      fi
    done
  fi

  [[ "$wait_status" == "0" ]] || validation_status=1
  [[ "$wait_result_status" == "0" ]] || validation_status=1
  [[ "$logs_status" == "0" ]] || validation_status=1
  [[ "$inspection_status" == "0" ]] || validation_status=1
  [[ "$state_status" == "0" ]] || validation_status=1
  [[ "$image_status" == "0" ]] || validation_status=1

  # A wait/API/log/state failure may otherwise leave a one-shot database
  # mutator running. Stop every exact captured ID, then query and force-kill
  # anything still running even when docker stop itself returned success.
  if [[ "$validation_status" != "0" ]]; then
    cleanup_attempted="true"
    timeout --signal=TERM --kill-after=5s 45s \
      env -i "PATH=$PATH" docker stop --time 10 "${container_ids[@]}" >/dev/null 2>&1 \
      || true
    if running_output="$(timeout --signal=TERM --kill-after=5s 10s \
      env -i "PATH=$PATH" docker ps --quiet --no-trunc 2>&1)"; then
      running_status=0
      for container_id in "${container_ids[@]}"; do
        grep -Fxq "$container_id" <<<"$running_output" && remaining_ids+=("$container_id")
      done
    else
      running_status=$?
      remaining_ids=("${container_ids[@]}")
    fi
    if (( ${#remaining_ids[@]} > 0 )); then
      timeout --signal=TERM --kill-after=5s 15s \
        env -i "PATH=$PATH" docker kill "${remaining_ids[@]}" >/dev/null 2>&1 \
        || true
    fi
  fi

  if final_running_output="$(timeout --signal=TERM --kill-after=5s 10s \
    env -i "PATH=$PATH" docker ps --quiet --no-trunc 2>&1)"; then
    final_running_status=0
  else
    final_running_status=$?
    cleanup_status=1
  fi
  for (( index=0; index<${#container_ids[@]}; index++ )); do
    container_id="${container_ids[$index]}"
    wait_value="${wait_results[$index]:-}"
    final_quiescent="false"
    if [[ "$final_running_status" == "0" ]] \
      && ! grep -Fxq "$container_id" <<<"$final_running_output"; then
      final_quiescent="true"
    else
      cleanup_status=1
    fi
    container_evidence="$(jq -c \
      --arg service "${contract_labels[$index]}" \
      --arg containerId "$container_id" \
      --arg expectedImageId "${expected_images[$index]}" \
      --arg actualImageId "${actual_images[$index]}" \
      --arg waitResult "$wait_value" \
      --arg inspectionSucceeded "${inspection_succeeded[$index]}" \
      --arg status "${observed_statuses[$index]}" \
      --arg running "${observed_running[$index]}" \
      --arg exitCode "${observed_exit_codes[$index]}" \
      --arg oomKilled "${observed_oom[$index]}" \
      --arg errorPresent "${observed_error_present[$index]}" \
      --arg finalQuiescent "$final_quiescent" '
        . + [{
          service: $service,
          containerId: $containerId,
          expectedImageId: $expectedImageId,
          actualImageId: (if $inspectionSucceeded == "true" then $actualImageId else null end),
          waitResult: (if ($waitResult | test("^[0-9]+$")) then ($waitResult | tonumber) else null end),
          inspectionSucceeded: ($inspectionSucceeded == "true"),
          status: (if $inspectionSucceeded == "true" then $status else null end),
          running: (if $inspectionSucceeded == "true" then ($running == "true") else null end),
          exitCode: (if $inspectionSucceeded == "true" then ($exitCode | tonumber) else null end),
          oomKilled: (if $inspectionSucceeded == "true" then ($oomKilled == "true") else null end),
          errorPresent: (if $inspectionSucceeded == "true" then ($errorPresent == "true") else null end),
          finalQuiescent: ($finalQuiescent == "true")
        }]
      ' <<<"$container_evidence")"
  done
  jq -n \
    --arg description "$description" \
    --arg waitStatus "$wait_status" \
    --arg logsCaptured "$([[ "$logs_status" == "0" ]] && printf true || printf false)" \
    --arg cleanupAttempted "$cleanup_attempted" \
    --argjson containers "$container_evidence" '
      {
        schemaVersion: 1,
        product: "business-finlynq",
        description: $description,
        waitTransportStatus: ($waitStatus | tonumber),
        logsCaptured: ($logsCaptured == "true"),
        cleanupAttempted: ($cleanupAttempted == "true"),
        containers: $containers
      }
    ' >"$evidence_directory/$state_evidence_filename"
  chmod 0600 -- "$evidence_directory/$state_evidence_filename"

  [[ "$cleanup_status" == "0" ]] \
    || fail "$description containers could not be proven quiescent after failure"
  [[ "$logs_status" == "0" ]] || fail "$description logs could not be captured"
  if [[ "$wait_status" == "124" ]]; then
    fail "$description wait exceeded its 30-minute bound"
  fi
  [[ "$wait_status" == "0" ]] || fail "$description Docker wait failed"
  [[ "${#wait_results[@]}" == "${#container_ids[@]}" ]] \
    || fail "$description wait returned an unexpected number of results"
  [[ "$wait_result_status" == "0" ]] \
    || fail "$description wait returned an invalid or unsuccessful result"
  [[ "$inspection_status" == "0" ]] || fail "$description container inspection failed"
  [[ "$state_status" == "0" ]] || fail "$description container did not exit cleanly"
  [[ "$image_status" == "0" ]] || fail "$description container used an unexpected image"
}
rehearsal_cleanup() {
  [[ "$mode" == "rehearsal" && "$rehearsal_cleaned" != "true" ]] || return 0
  compose --profile operations --profile auth-email --profile acceptance down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1 || true
  rehearsal_cleaned="true"
}

capture_rehearsal_database_failure() {
  [[ "$mode" == "rehearsal" && -n "$evidence_directory" && -d "$evidence_directory" ]] || return 0
  {
    compose_timed 20s logs --no-color --timestamps --tail 200 database 2>&1 || true
  } | sed -E \
    -e "s/([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][[:space:]]+)'[^']*'/\\1 '[REDACTED]'/g" \
    -e 's/(POSTGRES_PASSWORD|DATABASE_PASSWORD|app_password|worker_password|backup_password)([=:][^[:space:]]+)/\1=[REDACTED]/g' \
    >"$evidence_directory/98-rehearsal-database.log"
  chmod 0600 -- "$evidence_directory/98-rehearsal-database.log" 2>/dev/null || true
}

on_exit() {
  local status=$?
  trap - EXIT ERR INT TERM
  if (( status != 0 )); then
    if [[ "$mode" == "release" && "$schedulers_resumed" == "true" ]]; then
      if pause_schedulers allow-already-paused >/dev/null 2>&1; then
        schedulers_paused="true"
      else
        schedulers_paused="false"
        printf '%s\n' "URGENT: release failure occurred after scheduler resume and automatic re-pause failed." >&2
      fi
      schedulers_resumed="false"
    fi
    if [[ "$candidate_started" == "true" ]]; then
      compose --profile auth-email stop --timeout 30 app auth_email_worker >/dev/null 2>&1 || true
    fi
    jq -n \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg mode "$mode" \
      --arg revision "$revision" \
      --arg runId "$run_id" \
      --arg stage "$stage" \
      --argjson exitCode "$status" \
      --arg schedulersPaused "$schedulers_paused" \
      '{schemaVersion: 1, product: "business-finlynq", status: "failed", failedAt: $at, mode: $mode, revision: $revision, runId: $runId, stage: $stage, exitCode: $exitCode, schedulersRemainPaused: ($schedulersPaused == "true")}' \
      >"$evidence_directory/99-failure.json" 2>/dev/null || true
    chmod 0600 -- "$evidence_directory/99-failure.json" 2>/dev/null || true
    capture_rehearsal_database_failure || true
    rehearsal_cleanup
    refresh_checksums || true
    if [[ "$mode" == "release" && "$schedulers_paused" == "true" ]]; then
      printf '%s\n' "Release failed after schedulers were paused. They remain paused; do not re-enable writes until the evidence is reviewed." >&2
    fi
  fi
  [[ -z "$environment_snapshot_file" ]] || rm -f -- "$environment_snapshot_file" >/dev/null 2>&1 || true
  [[ -z "$operations_environment_snapshot_file" ]] \
    || rm -f -- "$operations_environment_snapshot_file" >/dev/null 2>&1 || true
  [[ -z "$previous_cron_schedule_file" ]] \
    || rm -f -- "$previous_cron_schedule_file" >/dev/null 2>&1 || true
  if [[ -n "$candidate_staging_root" ]]; then
    if [[ "$candidate_staging_root" == /tmp/business-finlynq-release.* \
      && -d "$candidate_staging_root" && ! -L "$candidate_staging_root" \
      && "$(readlink -f -- "$candidate_staging_root")" == "$candidate_staging_root" ]]; then
      rm -rf -- "$candidate_staging_root" >/dev/null 2>&1 || true
    else
      printf '%s\n' "URGENT: refused to remove an unexpected candidate staging path: $candidate_staging_root" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

if [[ "$scheduler_boundary_bootstrap_required" == "true" ]]; then
  install -m 0600 -- "$scheduler_boundary_bootstrap_receipt" \
    "$evidence_directory/05-scheduler-boundary-bootstrap.json"
  [[ "$(sha256sum "$evidence_directory/05-scheduler-boundary-bootstrap.json" | awk '{print $1}')" \
    == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
    || fail "retained scheduler-boundary bootstrap receipt differs from the protected source"
fi

stage="materialize-candidate-git-tree"
candidate_staging_root="$(mktemp -d /tmp/business-finlynq-release.XXXXXX)"
chmod 0700 -- "$candidate_staging_root"
candidate_source_root="$candidate_staging_root/repository"
mkdir -m 0700 -- "$candidate_source_root"
candidate_git_tree_file="$candidate_staging_root/candidate-git-tree.txt"
if ! git -c safe.directory="$repository_root" -C "$repository_root" \
  ls-tree -r --full-tree "$revision" >"$candidate_git_tree_file"; then
  fail "candidate Git tree could not be inspected before materialization"
fi
if awk '$1 == "160000" { found = 1 } END { exit found ? 0 : 1 }' "$candidate_git_tree_file"; then
  fail "candidate contains a Git submodule that cannot be materialized by the release archive"
fi
git -C "$repository_root" archive --format=tar "$revision" \
  | tar --extract --file=- --directory="$candidate_source_root" --no-same-owner --same-permissions
read_git_output "$repository_root" "candidate Git tree" rev-parse "$revision^{tree}"
candidate_tree_id="$git_command_output"
[[ "$candidate_tree_id" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || fail "candidate Git tree ID is invalid"
install -m 0600 -- "$candidate_git_tree_file" "$evidence_directory/03-candidate-git-tree.txt"
(
  cd -- "$candidate_source_root"
  find . -type f -print0 | sort -z | xargs -0 -r sha256sum
) >"$evidence_directory/04-staged-tree-sha256.txt"
chmod 0600 -- "$evidence_directory/03-candidate-git-tree.txt" "$evidence_directory/04-staged-tree-sha256.txt"
[[ -s "$evidence_directory/03-candidate-git-tree.txt" \
  && -s "$evidence_directory/04-staged-tree-sha256.txt" ]] \
  || fail "candidate Git-tree evidence is incomplete"

stage="snapshot-release-environments"
environment_snapshot_file="$(mktemp)"
install -m 0600 -- "$canonical_environment_file" "$environment_snapshot_file"
[[ "$(sha256sum "$environment_snapshot_file" | awk '{print $1}')" == "$compose_environment_sha256" ]] \
  || fail "private Compose environment snapshot differs from its validated source"
environment_file="$environment_snapshot_file"
if [[ "$mode" == "release" ]]; then
  operations_environment_snapshot_file="$(mktemp)"
  install -m 0600 -- "$canonical_operations_environment_file" "$operations_environment_snapshot_file"
  [[ "$(sha256sum "$operations_environment_snapshot_file" | awk '{print $1}')" == "$operations_environment_sha256" ]] \
    || fail "private operations environment snapshot differs from its validated source"
  operations_environment_file="$operations_environment_snapshot_file"
fi
cd -- "$candidate_source_root"

stage="compose-contract"
rendered_compose="$(compose --profile operations --profile auth-email --profile acceptance config --format json)"
rendered_revision="$(jq -r '.services.app.environment.BUSINESS_FINLYNQ_IMAGE_REVISION // empty' <<<"$rendered_compose")"
[[ "$rendered_revision" == "$revision" ]] || fail "Compose image revision does not match the requested release"
for image_contract in \
  "database:business-finlynq-database:$revision" \
  "app:business-finlynq-app:$revision" \
  "migrate:business-finlynq-migrator:$revision" \
  "auth_email_worker:business-finlynq-auth-worker:$revision" \
  "release_acceptance:business-finlynq-acceptance:$revision" \
  "backup:business-finlynq-operations:$revision" \
  "verify_database_contract:business-finlynq-migrator:$revision"; do
  service_name="${image_contract%%:*}"
  expected_image="${image_contract#*:}"
  actual_image="$(jq -r --arg service "$service_name" '.services[$service].image // empty' <<<"$rendered_compose")"
  [[ "$actual_image" == "$expected_image" ]] || fail "$service_name is not bound to its commit-addressed image"
done

app_port="$(jq -r '.services.app.ports[] | select(.target == 3000) | .published' <<<"$rendered_compose")"
[[ "$app_port" =~ ^[0-9]+$ && "$app_port" -ge 1024 && "$app_port" -le 65535 ]] || fail "rendered app port is invalid"
app_origin="$(jq -r '.services.app.environment.APP_ORIGIN // empty' <<<"$rendered_compose")"
session_cookie_name="$(jq -r '.services.app.environment.SESSION_COOKIE_NAME // empty' <<<"$rendered_compose")"
demo_claim_cookie_name="$(jq -r '.services.app.environment.DEMO_CLAIM_COOKIE_NAME // empty' <<<"$rendered_compose")"
public_base_url=""

for gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED ACCOUNT_SIGNUP_ENABLED BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED; do
  gate_value="$(jq -r --arg gate "$gate" '.services.app.environment[$gate] // empty' <<<"$rendered_compose")"
  [[ "$gate_value" == "true" || "$gate_value" == "false" ]] || fail "app gate $gate is not an explicit boolean"
  printf -v "release_$gate" '%s' "$gate_value"
done

backup_directory="$(jq -r '.services.backup.volumes[] | select(.target == "/backups") | .source' <<<"$rendered_compose")"
verify_backup_directory="$(jq -r '.services.verify_latest_backup.volumes[] | select(.target == "/backups") | .source' <<<"$rendered_compose")"
[[ -n "$backup_directory" && "$backup_directory" == "$verify_backup_directory" ]] \
  || fail "backup writer and verifier do not use the same host directory"
[[ "$backup_directory" == /* ]] || fail "backup directory must resolve to an absolute host path"
reject_repository_path "$backup_directory" "backup directory"

read_operations_value() {
  local key="$1"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "operations environment key is invalid"
  env -i "PATH=$PATH" bash --noprofile --norc -c '
    unset "$2"
    set -a
    # The file type, owner, and mode were validated before this trusted source.
    source "$1"
    printf "%s" "${!2-}"
  ' bash "$operations_environment_file" "$key"
}

if [[ "$mode" == "release" ]]; then
  [[ "$(read_operations_value BUSINESS_FINLYNQ_IMAGE_REVISION)" == "$revision" ]] \
    || fail "operations image revision does not match the candidate"
  [[ "$(read_operations_value MONITOR_EXPECT_REVISION)" == "$revision" ]] || fail "operations monitor revision does not match the candidate"
  [[ "$(read_operations_value MONITOR_MAINTENANCE_SCHEDULER)" == "$scheduler_mode" ]] || fail "operations scheduler mode does not match --scheduler"
  for gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED ACCOUNT_SIGNUP_ENABLED BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED; do
    expected="$(read_operations_value "MONITOR_EXPECT_$gate")"
    actual_variable="release_$gate"
    [[ "$expected" == "${!actual_variable}" ]] || fail "monitor expectation for $gate differs from the rendered app"
    printf -v "MONITOR_EXPECT_$gate" '%s' "$expected"
    export "MONITOR_EXPECT_$gate"
  done
  MONITOR_EXPECT_REVISION="$revision"
  BUSINESS_FINLYNQ_IMAGE_REVISION="$revision"
  MONITOR_MAINTENANCE_SCHEDULER="$scheduler_mode"
  MONITOR_BASE_URL="$(read_operations_value MONITOR_BASE_URL)"
  MONITOR_HOSTNAME="$(read_operations_value MONITOR_HOSTNAME)"
  MONITOR_BACKUP_DIR="$(read_operations_value MONITOR_BACKUP_DIR)"
  MONITOR_MAX_BACKUP_AGE_HOURS="$(read_operations_value MONITOR_MAX_BACKUP_AGE_HOURS)"
  SCHEDULED_BACKUP_TIMEOUT_SECONDS="$(read_operations_value SCHEDULED_BACKUP_TIMEOUT_SECONDS)"
  MONITOR_MAX_BACKUP_ACTIVE_SECONDS="$(read_operations_value MONITOR_MAX_BACKUP_ACTIVE_SECONDS)"
  MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS="$(read_operations_value MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS)"
  ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS="$(read_operations_value ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS)"
  MONITOR_MIN_TLS_DAYS="$(read_operations_value MONITOR_MIN_TLS_DAYS)"
  MONITOR_MAX_DISK_PERCENT="$(read_operations_value MONITOR_MAX_DISK_PERCENT)"
  MONITOR_EXPECT_EDGE="$(read_operations_value MONITOR_EXPECT_EDGE)"
  MONITOR_EXPECT_AUTH_EMAIL_WORKER="$(read_operations_value MONITOR_EXPECT_AUTH_EMAIL_WORKER)"
  MONITOR_EXPECT_OUTBOX_PUBLISHER="$(read_operations_value MONITOR_EXPECT_OUTBOX_PUBLISHER)"
  MONITOR_REQUIRE_OFFSITE="$(read_operations_value MONITOR_REQUIRE_OFFSITE)"
  MONITOR_EXPECT_DEMO_MAINTENANCE="$(read_operations_value MONITOR_EXPECT_DEMO_MAINTENANCE)"
  MONITOR_EXPECT_DEMO_POOL_SIZE="$(read_operations_value MONITOR_EXPECT_DEMO_POOL_SIZE)"
  MONITOR_MIN_DEMO_READY_SLOTS="$(read_operations_value MONITOR_MIN_DEMO_READY_SLOTS)"
  export BUSINESS_FINLYNQ_IMAGE_REVISION MONITOR_EXPECT_REVISION MONITOR_MAINTENANCE_SCHEDULER \
    MONITOR_BASE_URL MONITOR_HOSTNAME MONITOR_BACKUP_DIR MONITOR_MAX_BACKUP_AGE_HOURS \
    SCHEDULED_BACKUP_TIMEOUT_SECONDS \
    MONITOR_MAX_BACKUP_ACTIVE_SECONDS MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS \
    ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS MONITOR_MIN_TLS_DAYS \
    MONITOR_MAX_DISK_PERCENT MONITOR_EXPECT_EDGE MONITOR_EXPECT_AUTH_EMAIL_WORKER \
    MONITOR_EXPECT_OUTBOX_PUBLISHER MONITOR_REQUIRE_OFFSITE \
    MONITOR_EXPECT_DEMO_MAINTENANCE MONITOR_EXPECT_DEMO_POOL_SIZE MONITOR_MIN_DEMO_READY_SLOTS
  for explicit_boolean in MONITOR_EXPECT_EDGE MONITOR_EXPECT_AUTH_EMAIL_WORKER \
    MONITOR_EXPECT_OUTBOX_PUBLISHER MONITOR_REQUIRE_OFFSITE MONITOR_EXPECT_DEMO_MAINTENANCE; do
    [[ "${!explicit_boolean}" == "true" || "${!explicit_boolean}" == "false" ]] \
      || fail "$explicit_boolean must be explicitly true or false in the canonical operations environment"
  done
  for explicit_number in MONITOR_MAX_BACKUP_AGE_HOURS SCHEDULED_BACKUP_TIMEOUT_SECONDS \
    MONITOR_MAX_BACKUP_ACTIVE_SECONDS \
    MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS \
    MONITOR_MIN_TLS_DAYS MONITOR_MAX_DISK_PERCENT MONITOR_EXPECT_DEMO_POOL_SIZE MONITOR_MIN_DEMO_READY_SLOTS; do
    [[ "${!explicit_number}" =~ ^[0-9]+$ ]] \
      || fail "$explicit_number must be explicitly numeric in the canonical operations environment"
  done
  (( MONITOR_MAX_BACKUP_AGE_HOURS > 0 && MONITOR_MAX_BACKUP_AGE_HOURS <= 6 )) \
    || fail "the operations backup-age threshold cannot weaken the six-hour recovery objective"
  (( SCHEDULED_BACKUP_TIMEOUT_SECONDS > 0 && SCHEDULED_BACKUP_TIMEOUT_SECONDS <= 5400 \
    && MONITOR_MAX_BACKUP_ACTIVE_SECONDS > 0 && MONITOR_MAX_BACKUP_ACTIVE_SECONDS <= 4800 \
    && MONITOR_MAX_BACKUP_ACTIVE_SECONDS < SCHEDULED_BACKUP_TIMEOUT_SECONDS )) \
    || fail "operations backup runtime settings exceed the reviewed recovery envelope"
  release_backup_timeout_seconds="$SCHEDULED_BACKUP_TIMEOUT_SECONDS"
  [[ "$MONITOR_BASE_URL" =~ ^https:// ]] || fail "production monitor base URL must use HTTPS"
  [[ "$MONITOR_EXPECT_EDGE" == "true" ]] || fail "the production release requires the reviewed edge boundary"
  [[ "$MONITOR_REQUIRE_OFFSITE" == "true" ]] || fail "production release requires off-site backup verification"
  [[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "$release_ACCOUNT_LOGIN_ENABLED" ]] \
    || fail "auth-worker monitor expectation must match the account-login gate"
  [[ "$MONITOR_BACKUP_DIR" == "$backup_directory" ]] || fail "operations monitor and Compose backup directory differ"
  [[ "$app_port" == "3100" ]] || fail "production app listener must remain on loopback port 3100"
  [[ "$app_origin" == "$MONITOR_BASE_URL" ]] || fail "production APP_ORIGIN must exactly match the monitored HTTPS origin"
  [[ "$session_cookie_name" == "__Host-business_finlynq_session" ]] \
    || fail "production release requires the host-only secure session cookie"
  [[ "$demo_claim_cookie_name" == "__Host-business_finlynq_demo_claim" ]] \
    || fail "production release requires the host-only secure demo-claim cookie"
  public_base_url="$MONITOR_BASE_URL"
else
  rehearsal_resources="$(jq -r '.volumes[].name, .networks[].name' <<<"$rendered_compose")"
  [[ -n "$rehearsal_resources" ]] || fail "rehearsal resource names are missing"
  while IFS= read -r resource_name; do
    [[ "$resource_name" == "$compose_project"-* ]] \
      || fail "rehearsal resource can escape its isolated project: $resource_name"
    case "$resource_name" in
      business_finlynq_pgdata|business_finlynq_caddy_data|business_finlynq_caddy_config|business_finlynq_private|business_finlynq_egress|business_finlynq_edge|business_finlynq_restore_drill)
        fail "rehearsal resolved a production resource name"
        ;;
    esac
  done <<<"$rehearsal_resources"
  [[ "$app_port" != "3100" ]] || fail "rehearsal must use a non-production loopback port"
  [[ "$app_origin" == "http://127.0.0.1:$app_port" ]] || fail "rehearsal APP_ORIGIN must be its isolated loopback listener"
  [[ -n "$session_cookie_name" && "$session_cookie_name" != __Host-* ]] || fail "rehearsal must use a non-__Host session cookie"
  [[ -n "$demo_claim_cookie_name" && "$demo_claim_cookie_name" != __Host-* ]] || fail "rehearsal must use a non-__Host demo-claim cookie"
  [[ "$backup_directory" == "$evidence_root"/* ]] || fail "rehearsal backups must stay below the evidence root"
  [[ "$(jq -r '.services.backup.environment.BACKUP_REQUIRE_OFFSITE' <<<"$rendered_compose")" == "false" ]] \
    || fail "rehearsal backup must not contact an off-site remote"
  [[ "$(jq -r '.services.verify_latest_backup.environment.BACKUP_REQUIRE_OFFSITE_MARKER' <<<"$rendered_compose")" == "false" ]] \
    || fail "rehearsal backup verifier must not require an off-site marker"
  [[ "$release_DEMO_LOGIN_ENABLED" == "true" && "$release_DEMO_WRITES_ENABLED" == "true" ]] \
    || fail "release rehearsal requires the writable synthetic demo acceptance path"
  public_base_url="$app_origin"
fi

compose_hash="$(printf '%s' "$rendered_compose" | sha256sum | awk '{print $1}')"
unset rendered_compose
jq -n \
  --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mode "$mode" \
  --arg revision "$revision" \
  --arg runId "$run_id" \
  --arg project "$compose_project" \
  --arg composeSha256 "$compose_hash" \
  --arg candidateTreeId "$candidate_tree_id" \
  --arg gitTreeManifestSha256 "$(sha256sum "$evidence_directory/03-candidate-git-tree.txt" | awk '{print $1}')" \
  --arg stagedTreeManifestSha256 "$(sha256sum "$evidence_directory/04-staged-tree-sha256.txt" | awk '{print $1}')" \
  --arg baseUrl "$public_base_url" \
  --argjson cleanEnvironment "$([[ "$mode" == "rehearsal" ]] && echo true || echo false)" \
  '{schemaVersion: 1, product: "business-finlynq", status: "started", startedAt: $startedAt, mode: $mode, revision: $revision, runId: $runId, candidateTreeId: $candidateTreeId, gitTreeManifestSha256: $gitTreeManifestSha256, stagedTreeManifestSha256: $stagedTreeManifestSha256, composeProject: $project, composeConfigurationSha256: $composeSha256, acceptanceBaseUrl: $baseUrl, cleanEnvironment: $cleanEnvironment}' \
  >"$evidence_directory/00-release-plan.json"
chmod 0600 -- "$evidence_directory/00-release-plan.json"

if [[ "$mode" == "rehearsal" ]]; then
  stage="clean-rehearsal-environment"
  run_logged 01-clean-environment.log compose --profile operations --profile auth-email --profile acceptance down --volumes --remove-orphans --timeout 30
  read_docker_output "rehearsal containers after cleanup" ps -aq \
    --filter "label=com.docker.compose.project=$compose_project"
  remaining_containers="$docker_query_output"
  read_docker_output "rehearsal volumes after cleanup" volume ls -q \
    --filter "label=com.docker.compose.project=$compose_project"
  remaining_volumes="$docker_query_output"
  [[ -z "$remaining_containers" && -z "$remaining_volumes" ]] || fail "rehearsal project is not clean after scoped cleanup"
  rehearsal_cleaned="false"
  write_checkpoint 02-clean-environment.json clean-environment-confirmed
fi

stage="candidate-image-build"
assert_clean_checkout "$repository_root" \
  "the checkout changed after release evidence initialization and before image build"
run_logged 10-image-build.log compose --profile operations --profile auth-email --profile acceptance build \
  database app migrate auth_email_worker backup release_acceptance
assert_clean_checkout "$repository_root" \
  "the checkout changed while commit-addressed images were being built"
read_git_output "$repository_root" "post-build HEAD" rev-parse HEAD
[[ "$git_command_output" == "$revision" ]] \
  || fail "the checked-out revision changed while commit-addressed images were being built"
read_git_output "$repository_root" "post-build Git tree" rev-parse "HEAD^{tree}"
[[ "$git_command_output" == "$candidate_tree_id" ]] \
  || fail "the checked-out tree changed while commit-addressed images were being built"

image_evidence='[]'
declare -A image_ids=()
for image_name in \
  "database=business-finlynq-database:$revision" \
  "app=business-finlynq-app:$revision" \
  "migrator=business-finlynq-migrator:$revision" \
  "authWorker=business-finlynq-auth-worker:$revision" \
  "acceptance=business-finlynq-acceptance:$revision" \
  "operations=business-finlynq-operations:$revision"; do
  logical_name="${image_name%%=*}"
  image_reference="${image_name#*=}"
  image_id="$(docker image inspect --format '{{.Id}}' "$image_reference")"
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_reference")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "$logical_name image has no immutable image ID"
  [[ "$image_revision" == "$revision" ]] || fail "$logical_name image OCI revision does not match the release"
  image_ids[$logical_name]="$image_id"
  image_evidence="$(jq -c \
    --arg name "$logical_name" --arg reference "$image_reference" --arg id "$image_id" --arg revision "$image_revision" \
    '. + [{name: $name, reference: $reference, imageId: $id, ociRevision: $revision}]' <<<"$image_evidence")"
done

stage="candidate-image-content-verification"
run_logged 10-operations-image-content.log docker run --rm --network none --read-only \
  --user 70:70 --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 128m --cpus 0.25 \
  --entrypoint /bin/sh "${image_ids[operations]}" -ec \
  'test "$(stat -c "%u:%g:%a:%F" /usr/local/share/business-finlynq)" = "0:0:555:directory" && test "$(stat -c "%u:%g:%a:%F" /usr/local/share/business-finlynq/accounting-evidence-query.sql)" = "0:0:444:regular file" && test -f /usr/local/share/business-finlynq/accounting-evidence-query.sql && test -r /usr/local/share/business-finlynq/accounting-evidence-query.sql && test ! -L /usr/local/share/business-finlynq/accounting-evidence-query.sql'

# From this point onward every release-run service, including browser
# acceptance, resolves the immutable IDs just inspected rather than mutable
# commit-shaped tags.
release_images_pinned="true"
pinned_compose="$(compose --profile operations --profile auth-email --profile acceptance config --format json)"
[[ "$(jq -r '.services.app.image // empty' <<<"$pinned_compose")" == "${image_ids[app]}" ]] \
  || fail "pinned Compose configuration does not bind the immutable app image"
[[ "$(jq -r '.services.auth_email_worker.image // empty' <<<"$pinned_compose")" == "${image_ids[authWorker]}" ]] \
  || fail "pinned Compose configuration does not bind the immutable authentication-worker image"
[[ "$(jq -r '.services.release_acceptance.image // empty' <<<"$pinned_compose")" == "${image_ids[acceptance]}" ]] \
  || fail "pinned Compose configuration does not bind the immutable browser-acceptance image"
for pinned_service_contract in \
  "database:database" \
  "release_acceptance:acceptance" \
  "migrate:migrator" \
  "verify_database_contract:migrator" \
  "bootstrap_demo:migrator" \
  "provision_auth_worker_role:operations" \
  "reconcile_runtime_grants:operations" \
  "reconcile_auth_worker_grants:operations" \
  "provision_backup:operations" \
  "reconcile_backup_grants:operations" \
  "backup:operations" \
  "verify_latest_backup:operations" \
  "verify_accounting_evidence:operations"; do
  pinned_service="${pinned_service_contract%%:*}"
  pinned_logical_image="${pinned_service_contract#*:}"
  [[ "$(jq -r --arg service "$pinned_service" '.services[$service].image // empty' <<<"$pinned_compose")" \
    == "${image_ids[$pinned_logical_image]}" ]] \
    || fail "pinned Compose configuration does not bind the immutable image for $pinned_service"
done
pinned_compose_hash="$(printf '%s' "$pinned_compose" | sha256sum | awk '{print $1}')"
unset pinned_compose
[[ "$pinned_compose_hash" =~ ^[a-f0-9]{64}$ ]] || fail "pinned Compose configuration checksum is invalid"
jq -n --argjson images "$image_evidence" --arg pinnedComposeSha256 "$pinned_compose_hash" \
  '{schemaVersion: 1, pinnedComposeConfigurationSha256: $pinnedComposeSha256, images: $images}' \
  >"$evidence_directory/11-images.json"
chmod 0600 -- "$evidence_directory/11-images.json"

record_running_database_image() {
  local output_file="$1"
  local database_container actual_image_id
  [[ "$output_file" == "$evidence_directory"/* && ! -e "$output_file" && ! -L "$output_file" ]] \
    || fail "database image evidence target is unsafe or already exists"
  database_container="$(compose ps --quiet database)"
  [[ "$database_container" =~ ^[a-f0-9]{12,64}$ ]] \
    || fail "running database container identity is missing or invalid"
  actual_image_id="$(docker inspect --format '{{.Image}}' "$database_container")"
  [[ "$actual_image_id" == "${image_ids[database]}" ]] \
    || fail "running database does not use the immutable reviewed database image"
  jq -n \
    --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg revision "$revision" \
    --arg imageId "$actual_image_id" \
    '{schemaVersion: 1, product: "business-finlynq", service: "database", verifiedAt: $verifiedAt, revision: $revision, imageId: $imageId}' \
    >"$output_file"
  chmod 0600 -- "$output_file"
}

previous_app_id=""
previous_app_revision=""
if [[ "$mode" == "release" ]]; then
  stage="capture-rollback-artifact"
  previous_container="$(compose ps --quiet app)"
  [[ -n "$previous_container" ]] || fail "the existing app container is missing; use a reviewed initial-install procedure"
  previous_app_id="$(docker inspect --format '{{.Image}}' "$previous_container")"
  previous_app_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$previous_container")"
  [[ "$previous_app_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "the previous app has no immutable image ID"
  [[ "$previous_app_revision" =~ ^[a-f0-9]{40}$ && ! "$previous_app_revision" =~ ^0+$ ]] || fail "the previous app has no full OCI revision"
  [[ "$(docker image inspect --format '{{.Id}}' "$previous_app_id")" == "$previous_app_id" ]] || fail "the previous application image is not retained locally"
  git -C "$repository_root" cat-file -e "$previous_app_revision^{commit}" 2>/dev/null \
    || fail "the previous deployed revision is not a local Git commit"
  if [[ "$scheduler_boundary_bootstrap_required" == "true" ]]; then
    [[ "$scheduler_boundary_bootstrap_source_revision" == "$previous_app_revision" ]] \
      || fail "pre-checkout scheduler bootstrap source does not match the deployed application revision"
    [[ "$(sha256sum "$scheduler_boundary_bootstrap_receipt" | awk '{print $1}')" \
      == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
      || fail "the protected scheduler-boundary bootstrap receipt changed during release"
  fi
  previous_cron_schedule_file="$(mktemp)"
  git -C "$repository_root" show "$previous_app_revision:deploy/cron/managed-crontab" \
    >"$previous_cron_schedule_file" \
    || fail "the previous deployed revision has no reviewable managed cron schedule"
  chmod 0600 -- "$previous_cron_schedule_file"
fi
jq -n \
  --arg previousImageId "$previous_app_id" \
  --arg previousRevision "$previous_app_revision" \
  --arg candidateImageId "${image_ids[app]}" \
  --arg candidateRevision "$revision" \
  --arg schemaRollback "forward-repair-only" \
  --arg rollbackTool "deploy/release/run-application-rollback.sh" \
  '{schemaVersion: 1, previous: (if $previousImageId == "" then null else {imageId: $previousImageId, revision: $previousRevision} end), candidate: {imageId: $candidateImageId, revision: $candidateRevision}, databaseRollback: $schemaRollback, rollbackTool: $rollbackTool}' \
  >"$evidence_directory/12-rollback-artifact.json"
chmod 0600 -- "$evidence_directory/12-rollback-artifact.json"

pause_schedulers() {
  local pause_mode="${1:-strict}"
  [[ "$pause_mode" == "strict" || "$pause_mode" == "allow-already-paused" ]] \
    || fail "internal scheduler pause mode is invalid"
  if [[ "$pause_mode" == "allow-already-paused" ]]; then
    bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" \
      --allow-already-paused
    return
  fi
  if [[ "$scheduler_boundary_bootstrap_required" == "true" \
    && "$schedulers_resumed" != "true" ]]; then
    bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" \
      --allow-already-paused
    return
  fi
  if [[ "$scheduler_mode" == "cron" ]]; then
    if [[ "$schedulers_resumed" == "true" ]]; then
      bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" \
        --expected-cron-schedule "$candidate_source_root/deploy/cron/managed-crontab"
    else
      bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" \
        --allow-already-paused \
        --expected-cron-schedule "$previous_cron_schedule_file"
    fi
  else
    bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" \
      --expected-cron-schedule "$previous_cron_schedule_file"
  fi
}

resume_schedulers() {
  bash "$candidate_source_root/deploy/release/resume-schedulers.sh" "$scheduler_mode"
}

verify_live_checkout_matches_candidate() {
  read_git_output "$repository_root" "canonical HEAD" rev-parse HEAD
  [[ "$git_command_output" == "$revision" ]] \
    || fail "canonical checkout no longer identifies the candidate revision"
  read_git_output "$repository_root" "canonical Git tree" rev-parse "HEAD^{tree}"
  [[ "$git_command_output" == "$candidate_tree_id" ]] \
    || fail "canonical checkout tree differs from the staged candidate tree"
  assert_clean_checkout "$repository_root" "canonical checkout is not clean"
}

prepare_scheduler_state_directory() {
  local state_directory="/var/lib/business-finlynq"
  local shared_state_directory="/home/deploy/.local/state/business-finlynq/cron"
  local shared_demo_lock="$shared_state_directory/demo-sandbox-maintenance.lock"
  local job_status_directory="$shared_state_directory/job-status"
  local deploy_uid deploy_gid selected_path owner group mode_bits
  deploy_uid="$(id -u deploy)"
  deploy_gid="$(id -g deploy)"
  [[ "$deploy_uid" =~ ^[0-9]+$ && "$deploy_gid" =~ ^[0-9]+$ ]] \
    || fail "the deploy account identity is unavailable for scheduler state"
  [[ ! -L "$shared_state_directory" \
    && ( ! -e "$shared_state_directory" || -d "$shared_state_directory" ) \
    && ! -L "$shared_demo_lock" \
    && ( ! -e "$shared_demo_lock" || -f "$shared_demo_lock" ) \
    && ! -L "$job_status_directory" \
    && ( ! -e "$job_status_directory" || -d "$job_status_directory" ) ]] \
    || fail "shared scheduler state or demo lock is unsafe"
  mkdir -p -- "$shared_state_directory" "$job_status_directory"
  chmod 0700 -- "$shared_state_directory" "$job_status_directory"
  touch -- "$shared_demo_lock"
  chmod 0600 -- "$shared_demo_lock"
  if [[ "$(id -u)" == "0" ]]; then
    chown deploy:deploy -- "$shared_state_directory" "$shared_demo_lock" "$job_status_directory"
  fi
  [[ "$(stat -c '%u:%g:%a' -- "$shared_state_directory")" == "$deploy_uid:$deploy_gid:700" \
    && "$(stat -c '%u:%g:%a' -- "$shared_demo_lock")" == "$deploy_uid:$deploy_gid:600" \
    && "$(stat -c '%u:%g:%a' -- "$job_status_directory")" == "$deploy_uid:$deploy_gid:700" ]] \
    || fail "shared scheduler state and demo lock must be deploy-owned with restrictive modes"
  [[ ! -L "$state_directory" && ( ! -e "$state_directory" || -d "$state_directory" ) ]] \
    || fail "scheduler state directory is unsafe"

  if [[ "$scheduler_mode" == "systemd" ]]; then
    install -d -o root -g deploy -m 0775 -- "$state_directory"
    for selected_path in "$state_directory/host.prom" "$state_directory/accounting-evidence.prom"; do
      [[ ! -e "$selected_path" ]] && continue
      [[ -f "$selected_path" && ! -L "$selected_path" ]] || fail "scheduler metric path is unsafe: $selected_path"
      chown root:deploy -- "$selected_path"
      chmod 0644 -- "$selected_path"
    done
    selected_path="$state_directory/accounting-evidence.lock"
    if [[ -e "$selected_path" ]]; then
      [[ -f "$selected_path" && ! -L "$selected_path" ]] || fail "accounting scheduler lock is unsafe"
      chown root:deploy -- "$selected_path"
      chmod 0660 -- "$selected_path"
    fi
  else
    [[ -d "$state_directory" ]] \
      || fail "cron scheduler state must be provisioned as root:deploy mode 0775 before release"
  fi

  owner="$(stat -c '%u' -- "$state_directory")"
  group="$(stat -c '%g' -- "$state_directory")"
  mode_bits="$(stat -c '%a' -- "$state_directory")"
  [[ ( "$owner" == "0" || "$owner" == "$deploy_uid" ) \
    && "$group" == "$deploy_gid" && "$mode_bits" == "775" ]] \
    || fail "scheduler state directory must be root/deploy-owned, deploy-grouped, and mode 0775"
  for selected_path in "$state_directory/host.prom" "$state_directory/accounting-evidence.prom"; do
    [[ ! -e "$selected_path" ]] && continue
    [[ -f "$selected_path" && ! -L "$selected_path" \
      && "$(stat -c '%g:%a' -- "$selected_path")" == "$deploy_gid:644" ]] \
      || fail "scheduler metric must be deploy-grouped mode 0644: $selected_path"
  done
  selected_path="$state_directory/accounting-evidence.lock"
  if [[ -e "$selected_path" ]]; then
    [[ -f "$selected_path" && ! -L "$selected_path" \
      && "$(stat -c '%g:%a' -- "$selected_path")" == "$deploy_gid:660" ]] \
      || fail "accounting scheduler lock must be deploy-grouped mode 0660"
  fi
}

install_and_verify_systemd_schedule() {
  [[ "$scheduler_mode" == "systemd" ]] || return 0
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
  local unit_name
  for unit_name in \
    business-finlynq-backup.service business-finlynq-backup.timer \
    business-finlynq-monitor.service business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.service business-finlynq-accounting-evidence.timer \
    business-finlynq-demo-reconcile.service business-finlynq-demo-reconcile.timer; do
    install -o root -g root -m 0644 \
      "$candidate_source_root/deploy/systemd/$unit_name" "/etc/systemd/system/$unit_name"
  done
  systemctl daemon-reload
  bash "$candidate_source_root/deploy/systemd/verify-backup-schedule.sh"
}

systemd_property_value=""
read_systemd_property() {
  local service_name="$1" property_name="$2"
  [[ "$service_name" == "business-finlynq-accounting-evidence.service" \
    || "$service_name" == "business-finlynq-monitor.service" ]] \
    || fail "release acceptance requested an unsupported systemd service"
  case "$property_name" in
    ExecMainStartTimestampMonotonic|ExecMainExitTimestampMonotonic|Result|ExecMainStatus) ;;
    *) fail "release acceptance requested an unsupported systemd property" ;;
  esac
  if ! systemd_property_value="$(systemctl show --property="$property_name" --value "$service_name")"; then
    fail "could not inspect $property_name for $service_name"
  fi
  [[ -n "$systemd_property_value" ]] \
    || fail "systemd returned an empty $property_name for $service_name"
}

run_fresh_systemd_oneshot() {
  local service_name="$1" description="$2"
  local previous_start current_start current_exit result main_status
  read_systemd_property "$service_name" ExecMainStartTimestampMonotonic
  previous_start="$systemd_property_value"
  [[ "$previous_start" =~ ^[0-9]+$ ]] \
    || fail "$description has an invalid previous systemd start timestamp"
  systemctl start "$service_name" \
    || fail "$description could not be started"
  read_systemd_property "$service_name" ExecMainStartTimestampMonotonic
  current_start="$systemd_property_value"
  read_systemd_property "$service_name" ExecMainExitTimestampMonotonic
  current_exit="$systemd_property_value"
  read_systemd_property "$service_name" Result
  result="$systemd_property_value"
  read_systemd_property "$service_name" ExecMainStatus
  main_status="$systemd_property_value"
  [[ "$current_start" =~ ^[1-9][0-9]*$ && "$current_start" != "$previous_start" ]] \
    || fail "$description did not execute a fresh systemd invocation"
  [[ "$current_exit" =~ ^[1-9][0-9]*$ && "$current_exit" -gt "$current_start" ]] \
    || fail "$description has no valid systemd exit timestamp after its fresh start"
  [[ "$result" == "success" ]] \
    || fail "$description did not report systemd Result=success"
  [[ "$main_status" == "0" ]] \
    || fail "$description exited with a nonzero systemd ExecMainStatus"
  systemctl show --no-pager --property=ExecMainStartTimestampMonotonic \
    --property=ExecMainExitTimestampMonotonic --property=Result \
    --property=ExecMainStatus "$service_name"
}

verify_fresh_cron_job_status() {
  local job_name="$1" started_at="$2"
  local deploy_uid status_directory status_file completed_at now
  [[ "$job_name" == "accounting-evidence" || "$job_name" == "monitor" ]] \
    || fail "release cron acceptance requested an unsupported job"
  [[ "$started_at" =~ ^[1-9][0-9]*$ ]] \
    || fail "release cron acceptance start time is invalid"
  deploy_uid="$(id -u deploy)"
  [[ "$deploy_uid" =~ ^[0-9]+$ ]] \
    || fail "the deploy account identity is unavailable for cron acceptance"
  status_directory="/home/deploy/.local/state/business-finlynq/cron/job-status"
  status_file="$status_directory/$job_name.json"
  [[ -d "$status_directory" && ! -L "$status_directory" \
    && "$(readlink -f -- "$status_directory")" == "$status_directory" \
    && "$(stat -c '%u:%a' -- "$status_directory")" == "$deploy_uid:700" ]] \
    || fail "cron job-status directory is unsafe"
  [[ -f "$status_file" && ! -L "$status_file" \
    && "$(readlink -f -- "$status_file")" == "$status_file" \
    && "$(stat -c '%u:%a' -- "$status_file")" == "$deploy_uid:600" ]] \
    || fail "cron $job_name completion record is missing or unsafe"
  now="$(date +%s)"
  [[ "$now" =~ ^[1-9][0-9]*$ ]] \
    || fail "current time is invalid while verifying cron completion"
  jq -e --arg job "$job_name" --argjson startedAt "$started_at" --argjson now "$now" '
    type == "object" and
    keys == ["completedAtUnixtime", "job", "product", "result", "schemaVersion"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .job == $job and .result == "succeeded" and
    (.completedAtUnixtime | type == "number" and . == floor and
      . >= $startedAt and . <= $now)
  ' "$status_file" >/dev/null \
    || fail "cron $job_name did not produce a fresh successful completion record"
  completed_at="$(jq -r '.completedAtUnixtime' "$status_file")"
  printf 'Cron %s completion record accepted at %s (completedAt=%s).\n' \
    "$job_name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$completed_at"
}

clear_cron_job_status() {
  local job_name="$1"
  local deploy_uid status_directory status_file
  [[ "$job_name" == "accounting-evidence" || "$job_name" == "monitor" ]] \
    || fail "release cron acceptance requested an unsupported job"
  deploy_uid="$(id -u deploy)"
  [[ "$deploy_uid" =~ ^[0-9]+$ ]] \
    || fail "the deploy account identity is unavailable for cron acceptance"
  status_directory="/home/deploy/.local/state/business-finlynq/cron/job-status"
  status_file="$status_directory/$job_name.json"
  [[ -d "$status_directory" && ! -L "$status_directory" \
    && "$(readlink -f -- "$status_directory")" == "$status_directory" \
    && "$(stat -c '%u:%a' -- "$status_directory")" == "$deploy_uid:700" ]] \
    || fail "cron job-status directory is unsafe"
  if [[ -e "$status_file" || -L "$status_file" ]]; then
    [[ -f "$status_file" && ! -L "$status_file" \
      && "$(readlink -f -- "$status_file")" == "$status_file" \
      && "$(stat -c '%u:%a' -- "$status_file")" == "$deploy_uid:600" ]] \
      || fail "existing cron $job_name completion record is unsafe"
    rm -- "$status_file"
  fi
  [[ ! -e "$status_file" && ! -L "$status_file" ]] \
    || fail "cron $job_name completion record could not be cleared before acceptance"
}

release_metric_file=""
resolve_release_metric_file() {
  local environment_key="$1" default_path="$2"
  case "$environment_key" in
    ACCOUNTING_EVIDENCE_METRICS_FILE|MONITOR_METRICS_FILE) ;;
    *) fail "release acceptance requested an unsupported metric path" ;;
  esac
  release_metric_file="$(read_operations_value "$environment_key")"
  [[ -n "$release_metric_file" ]] || release_metric_file="$default_path"
}

assert_release_metric_path_safety() {
  local metrics_file="$1" require_file="$2" description="$3"
  local deploy_uid deploy_gid metrics_directory directory_owner directory_group directory_mode
  local owner group mode_bits
  [[ "$require_file" == "true" || "$require_file" == "false" ]] \
    || fail "metric file requirement is invalid"
  deploy_uid="$(id -u deploy)"
  deploy_gid="$(id -g deploy)"
  [[ "$deploy_uid" =~ ^[0-9]+$ && "$deploy_gid" =~ ^[0-9]+$ ]] \
    || fail "the deploy account identity is unavailable for $description"
  metrics_directory="${metrics_file%/*}"
  [[ "$metrics_file" == /* && "$metrics_directory" != "$metrics_file" \
    && -d "$metrics_directory" && ! -L "$metrics_directory" \
    && "$(readlink -f -- "$metrics_directory")" == "$metrics_directory" ]] \
    || fail "$description directory is missing or resolves through an unsafe path"
  directory_owner="$(stat -c '%u' -- "$metrics_directory")"
  directory_group="$(stat -c '%g' -- "$metrics_directory")"
  directory_mode="$(stat -c '%a' -- "$metrics_directory")"
  [[ ( "$directory_owner" == "0" || "$directory_owner" == "$deploy_uid" ) \
    && "$directory_group" == "$deploy_gid" && "$directory_mode" == "775" ]] \
    || fail "$description directory has unsafe ownership or mode"
  if [[ ! -e "$metrics_file" && ! -L "$metrics_file" ]]; then
    [[ "$require_file" == "false" ]] || fail "$description is missing"
    return 0
  fi
  [[ -f "$metrics_file" && ! -L "$metrics_file" \
    && "$(readlink -f -- "$metrics_file")" == "$metrics_file" ]] \
    || fail "$description is not a safe regular file"
  owner="$(stat -c '%u' -- "$metrics_file")"
  group="$(stat -c '%g' -- "$metrics_file")"
  mode_bits="$(stat -c '%a' -- "$metrics_file")"
  [[ ( "$owner" == "0" || "$owner" == "$deploy_uid" ) \
    && "$group" == "$deploy_gid" && "$mode_bits" == "644" ]] \
    || fail "$description has unsafe ownership or mode"
}

clear_release_metric_file() {
  local environment_key="$1" default_path="$2" description="$3"
  resolve_release_metric_file "$environment_key" "$default_path"
  assert_release_metric_path_safety "$release_metric_file" false "$description"
  if [[ -e "$release_metric_file" || -L "$release_metric_file" ]]; then
    rm -- "$release_metric_file"
  fi
  [[ ! -e "$release_metric_file" && ! -L "$release_metric_file" ]] \
    || fail "$description could not be cleared before acceptance"
}

metric_value=""
read_unique_release_metric() {
  local metrics_file="$1" metric_name="$2" description="$3"
  if ! metric_value="$(awk -v selected_metric="$metric_name" '
    $1 == selected_metric {
      count += 1; if (NF != 2) invalid = 1; value = $2
    }
    END { if (count != 1 || invalid) exit 1; print value }
  ' "$metrics_file")"; then
    fail "$description is missing, duplicated, or malformed"
  fi
}

verify_fresh_metric_file() {
  local metrics_file="$1" started_at="$2" description="$3"
  local modified_at now
  [[ "$started_at" =~ ^[1-9][0-9]*$ ]] \
    || fail "$description start time is invalid"
  assert_release_metric_path_safety "$metrics_file" true "$description"
  modified_at="$(stat -c '%Y' -- "$metrics_file")"
  now="$(date +%s)"
  [[ "$modified_at" =~ ^[1-9][0-9]*$ && "$now" =~ ^[1-9][0-9]*$ \
    && "$modified_at" -ge "$started_at" && "$modified_at" -le "$now" ]] \
    || fail "$description was not freshly replaced by release acceptance"
}

verify_fresh_accounting_metrics() {
  local started_at="$1"
  local metrics_file now
  local verification_success last_run last_success
  resolve_release_metric_file ACCOUNTING_EVIDENCE_METRICS_FILE \
    /var/lib/business-finlynq/accounting-evidence.prom
  metrics_file="$release_metric_file"
  verify_fresh_metric_file "$metrics_file" "$started_at" "accounting-evidence metric"
  now="$(date +%s)"
  read_unique_release_metric "$metrics_file" \
    business_finlynq_accounting_evidence_verification_success \
    "accounting-evidence success metric"
  verification_success="$metric_value"
  read_unique_release_metric "$metrics_file" \
    business_finlynq_accounting_evidence_verification_last_run_unixtime \
    "accounting-evidence last-run metric"
  last_run="$metric_value"
  read_unique_release_metric "$metrics_file" \
    business_finlynq_accounting_evidence_verification_last_success_unixtime \
    "accounting-evidence last-success metric"
  last_success="$metric_value"
  [[ "$verification_success" == "1" \
    && "$last_run" =~ ^[1-9][0-9]*$ && "$last_success" =~ ^[1-9][0-9]*$ \
    && "$last_run" -ge "$started_at" && "$last_run" -le "$now" \
    && "$last_success" -ge "$started_at" && "$last_success" -le "$now" ]] \
    || fail "accounting-evidence metric does not prove a fresh successful release seed"
}

verify_fresh_host_monitor_metrics() {
  local started_at="$1"
  local metrics_file now monitor_success last_run
  resolve_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom
  metrics_file="$release_metric_file"
  verify_fresh_metric_file "$metrics_file" "$started_at" "host-monitor metric"
  now="$(date +%s)"
  read_unique_release_metric "$metrics_file" business_finlynq_host_monitor_success \
    "host-monitor success metric"
  monitor_success="$metric_value"
  read_unique_release_metric "$metrics_file" \
    business_finlynq_host_monitor_last_run_unixtime "host-monitor last-run metric"
  last_run="$metric_value"
  [[ "$monitor_success" == "1" && "$last_run" =~ ^[1-9][0-9]*$ \
    && "$last_run" -ge "$started_at" && "$last_run" -le "$now" ]] \
    || fail "host-monitor metric does not prove a fresh successful acceptance run"
}

run_installed_monitor() {
  local started_at
  if [[ "$scheduler_mode" == "cron" ]]; then
    clear_cron_job_status monitor
  fi
  clear_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom \
    "host-monitor metric"
  started_at="$(date +%s)"
  [[ "$started_at" =~ ^[1-9][0-9]*$ ]] \
    || fail "monitor acceptance start time is invalid"
  if [[ "$scheduler_mode" == "systemd" ]]; then
    run_fresh_systemd_oneshot business-finlynq-monitor.service \
      "the resumed systemd monitor"
  else
    bash "$repository_root/deploy/cron/run-job.sh" monitor
    verify_fresh_cron_job_status monitor "$started_at"
  fi
  verify_fresh_host_monitor_metrics "$started_at"
  printf 'Installed %s monitor acceptance completed at %s.\n' \
    "$scheduler_mode" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

run_installed_accounting_evidence() {
  local started_at
  if [[ "$scheduler_mode" == "cron" ]]; then
    clear_cron_job_status accounting-evidence
  fi
  clear_release_metric_file ACCOUNTING_EVIDENCE_METRICS_FILE \
    /var/lib/business-finlynq/accounting-evidence.prom "accounting-evidence metric"
  started_at="$(date +%s)"
  [[ "$started_at" =~ ^[1-9][0-9]*$ ]] \
    || fail "accounting-evidence seed start time is invalid"
  if [[ "$scheduler_mode" == "systemd" ]]; then
    run_fresh_systemd_oneshot business-finlynq-accounting-evidence.service \
      "the resumed systemd accounting-evidence job"
  else
    bash "$repository_root/deploy/cron/run-job.sh" accounting-evidence
    verify_fresh_cron_job_status accounting-evidence "$started_at"
  fi
  verify_fresh_accounting_metrics "$started_at"
  printf 'Installed %s accounting-evidence seed completed at %s.\n' \
    "$scheduler_mode" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

record_scheduler_boundary_version() {
  local deploy_uid lock_directory boundary_file temporary_file
  deploy_uid="$(id -u deploy)"
  lock_directory="/home/deploy/.local/state/business-finlynq/release-locks"
  boundary_file="$lock_directory/scheduler-boundary.json"
  [[ ! -L "$boundary_file" \
    && ( ! -e "$boundary_file" \
      || ( -f "$boundary_file" && "$(stat -c '%u:%a' -- "$boundary_file")" == "$deploy_uid:600" ) ) ]] \
    || fail "installed scheduler boundary record became unsafe"
  temporary_file="$(mktemp "$lock_directory/.scheduler-boundary.XXXXXX")"
  jq -n \
    --arg product business-finlynq \
    --arg installedRevision "$revision" \
    --arg scheduler "$scheduler_mode" \
    --arg acceptedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion: 1, product: $product, boundaryVersion: 1, installedRevision: $installedRevision, scheduler: $scheduler, acceptedAt: $acceptedAt}' \
    >"$temporary_file"
  chmod 0600 -- "$temporary_file"
  if [[ "$(id -u)" == "0" ]]; then
    chown -- "$deploy_uid" "$temporary_file"
  fi
  [[ "$(stat -c '%u:%a' -- "$temporary_file")" == "$deploy_uid:600" ]] \
    || fail "scheduler boundary record temporary file has unsafe ownership or mode"
  sync -f -- "$temporary_file"
  mv -f -- "$temporary_file" "$boundary_file"
  sync -f -- "$lock_directory"
  jq -e --arg revision "$revision" --arg scheduler "$scheduler_mode" '
    .schemaVersion == 1 and .product == "business-finlynq" and
    .boundaryVersion == 1 and .installedRevision == $revision and .scheduler == $scheduler
  ' "$boundary_file" >/dev/null \
    || fail "durable scheduler boundary record could not be verified"
  if [[ "$scheduler_boundary_bootstrap_required" == "true" ]]; then
    [[ "$(sha256sum "$scheduler_boundary_bootstrap_receipt" | awk '{print $1}')" \
      == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
      || fail "the scheduler-boundary bootstrap receipt changed before acceptance"
    rm -- "$scheduler_boundary_bootstrap_receipt"
    sync -f -- "$lock_directory"
    [[ ! -e "$scheduler_boundary_bootstrap_receipt" \
      && ! -L "$scheduler_boundary_bootstrap_receipt" ]] \
      || fail "accepted scheduler-boundary bootstrap receipt could not be retired"
  fi
}

if [[ "$mode" == "release" ]]; then
  stage="pause-schedulers"
  run_logged 20-pause-schedulers.log pause_schedulers
  schedulers_paused="true"
  write_checkpoint 21-schedulers-paused.json schedulers-paused
  if [[ "$scheduler_mode" == "cron" ]]; then
    jq -n \
      --arg previousRevision "$previous_app_revision" \
      --arg previousScheduleSha256 "$(sha256sum "$previous_cron_schedule_file" | awk '{print $1}')" \
      --arg candidateRevision "$revision" \
      --arg candidateScheduleSha256 "$(sha256sum "$candidate_source_root/deploy/cron/managed-crontab" | awk '{print $1}')" \
      '{schemaVersion: 1, previousRevision: $previousRevision, previousScheduleSha256: $previousScheduleSha256, candidateRevision: $candidateRevision, candidateScheduleSha256: $candidateScheduleSha256, previousScheduleRemoved: true}' \
      >"$evidence_directory/22-cron-schedule-transition.json"
    chmod 0600 -- "$evidence_directory/22-cron-schedule-transition.json"
  fi
fi

stage="stop-write-surfaces"
stop_write_surfaces() {
  if [[ "$mode" == "release" ]]; then
    # The recovery point must cover every mutation accepted by the old release.
    # Quiesce both application and delivery worker before pg_dump; taking the
    # snapshot first would leave a post-snapshot/pre-migration loss window.
    compose --profile auth-email stop --timeout 60 auth_email_worker app
  fi
  read_compose_output "running application write surface" ps --status running --quiet app
  [[ -z "$compose_query_output" ]] || fail "application write surface is still running"
  read_compose_output "running authentication-worker write surface" \
    --profile auth-email ps --status running --quiet auth_email_worker
  [[ -z "$compose_query_output" ]] || fail "authentication worker is still running"
  printf '%s\n' "Application and authentication-worker write surfaces are stopped."
}
run_logged 25-stop-write-surfaces.log stop_write_surfaces
write_checkpoint 26-write-surfaces-stopped.json write-surfaces-stopped-before-backup

stage="pre-migration-backup"
if [[ "$mode" == "rehearsal" ]]; then
  run_logged 29-rehearsal-database-start.log compose_timed 10m up --detach --wait --no-build database
  record_running_database_image "$evidence_directory/29-rehearsal-database-image.json"
  backup_source_revision="$revision"
else
  backup_source_revision="$previous_app_revision"
fi
run_logged 30-provision-backup-role.log compose --profile operations run --rm --no-deps provision_backup
cleanup_failed_backup_containers() {
  local container_id
  local -a backup_containers=()
  read_docker_output "one-off backup containers during failure containment" ps --all --quiet \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter "label=com.docker.compose.service=backup"
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] \
      || fail "Docker returned an invalid backup container ID during containment"
    backup_containers+=("$container_id")
  done <<<"$docker_query_output"
  (( ${#backup_containers[@]} > 0 )) || return 0
  timeout 2m env -i "PATH=$PATH" docker rm --force -- "${backup_containers[@]}" >/dev/null 2>&1 \
    || return 1
  read_docker_output "one-off backup containers after failure containment" ps --all --quiet \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter "label=com.docker.compose.service=backup"
  [[ -z "$docker_query_output" ]]
}

run_backup() (
  local backup_status=0
  if compose_timed_with_overrides "${release_backup_timeout_seconds}s" \
    "BACKUP_SOURCE_APPLICATION_REVISION=$backup_source_revision" -- \
    --profile operations run --rm --no-deps backup; then
    return 0
  else
    backup_status=$?
  fi
  cleanup_failed_backup_containers \
    || fail "timed-out backup container could not be contained and removed"
  return "$backup_status"
)
run_logged 31-encrypted-backup.log run_backup
verify_backup_and_record_evidence() {
  local verifier_output evidence_json
  local -a evidence_lines=()
  if ! verifier_output="$(compose --profile operations run --rm --no-deps -T \
    verify_latest_backup \
    /usr/local/bin/business-finlynq-check-latest-backup --emit-evidence 2>&1)"; then
    printf '%s\n' "$verifier_output"
    return 1
  fi
  printf '%s\n' "$verifier_output"
  mapfile -t evidence_lines < <(
    printf '%s\n' "$verifier_output" \
      | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p'
  )
  (( ${#evidence_lines[@]} == 1 )) \
    || fail "immutable backup verifier did not emit exactly one evidence record"
  evidence_json="${evidence_lines[0]}"
  jq -e --arg sourceRevision "$backup_source_revision" --arg toolRevision "$revision" '
    type == "object" and
    keys == ["applicationRevision", "backupToolRevision", "createdAt",
      "encryptedArchive", "encryptedBytes", "encryption", "format", "product",
      "schemaVersion", "sha256", "sourceApplicationRevision"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .applicationRevision == $sourceRevision and
    .sourceApplicationRevision == $sourceRevision and
    .backupToolRevision == $toolRevision and
    .encryption == "age" and .format == "postgres-custom" and
    (.createdAt | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.encryptedArchive | type == "string" and
      test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.dump\\.age$")) and
    (.encryptedBytes | type == "number" and . == floor and . > 0) and
    (.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' <<<"$evidence_json" >/dev/null \
    || fail "immutable backup verifier emitted invalid release evidence"
  jq '.' <<<"$evidence_json" >"$evidence_directory/33-backup-evidence.json"
  chmod 0600 -- "$evidence_directory/33-backup-evidence.json"
}
run_logged 32-backup-verification.log verify_backup_and_record_evidence

stage="activate-reviewed-database-image"
run_logged 34-database-start.log compose_timed 10m up --detach --wait --no-build database
record_running_database_image "$evidence_directory/35-database-image.json"

stage="pre-traffic-migration-and-contract-verification"
pretraffic_services=(
  provision_auth_worker_role
  migrate
  reconcile_runtime_grants
  reconcile_auth_worker_grants
  reconcile_backup_grants
  verify_database_contract
  verify_accounting_evidence
)
run_logged 49-pretraffic-reset.log compose --profile operations rm --force --stop "${pretraffic_services[@]}"
run_logged 50-pretraffic-up.log compose_timed 30m --profile operations up --detach --no-build \
  verify_database_contract verify_accounting_evidence
declare -A pretraffic_container_ids=()
for service_name in "${pretraffic_services[@]}"; do
  capture_compose_container_id "pre-traffic $service_name container" \
    --profile operations ps --all --quiet "$service_name"
  pretraffic_container_ids["$service_name"]="$captured_compose_container_id"
done
run_logged 51-pretraffic-wait.log wait_for_captured_containers \
  "pre-traffic verification" 52-pretraffic-services.log 51-pretraffic-containers.json \
  provision_auth_worker_role "${pretraffic_container_ids[provision_auth_worker_role]}" "${image_ids[operations]}" \
  migrate "${pretraffic_container_ids[migrate]}" "${image_ids[migrator]}" \
  reconcile_runtime_grants "${pretraffic_container_ids[reconcile_runtime_grants]}" "${image_ids[operations]}" \
  reconcile_auth_worker_grants "${pretraffic_container_ids[reconcile_auth_worker_grants]}" "${image_ids[operations]}" \
  reconcile_backup_grants "${pretraffic_container_ids[reconcile_backup_grants]}" "${image_ids[operations]}" \
  verify_database_contract "${pretraffic_container_ids[verify_database_contract]}" "${image_ids[migrator]}" \
  verify_accounting_evidence "${pretraffic_container_ids[verify_accounting_evidence]}" "${image_ids[operations]}" -- \
  --profile operations logs --no-color --timestamps \
    provision_auth_worker_role migrate reconcile_runtime_grants reconcile_auth_worker_grants \
    reconcile_backup_grants verify_database_contract verify_accounting_evidence

pretraffic_evidence='[]'
for service_contract in \
  "provision_auth_worker_role:operations" \
  "migrate:migrator" \
  "reconcile_runtime_grants:operations" \
  "reconcile_auth_worker_grants:operations" \
  "reconcile_backup_grants:operations" \
  "verify_database_contract:migrator" \
  "verify_accounting_evidence:operations"; do
  service_name="${service_contract%%:*}"
  logical_image="${service_contract#*:}"
  container_id="${pretraffic_container_ids[$service_name]}"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
  actual_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  [[ "$exit_code" == "0" ]] || fail "pre-traffic service failed: $service_name"
  [[ "$actual_image_id" == "${image_ids[$logical_image]}" ]] || fail "pre-traffic service used an unexpected image: $service_name"
  pretraffic_evidence="$(jq -c --arg service "$service_name" --arg imageId "$actual_image_id" \
    '. + [{service: $service, exitCode: 0, imageId: $imageId}]' <<<"$pretraffic_evidence")"
done

stage="demo-bootstrap"
run_logged 54-bootstrap-reset.log compose rm --force --stop bootstrap_demo
run_logged 55-bootstrap-up.log compose_timed 30m up --detach --no-build bootstrap_demo
capture_compose_container_id "demo bootstrap container" ps --all --quiet bootstrap_demo
bootstrap_container="$captured_compose_container_id"
run_logged 56-bootstrap-wait.log wait_for_captured_containers \
  "demo bootstrap" 56-bootstrap-services.log 56-bootstrap-container.json \
  bootstrap_demo "$bootstrap_container" "${image_ids[migrator]}" -- \
  logs --no-color --timestamps bootstrap_demo
[[ -n "$bootstrap_container" && "$(docker inspect --format '{{.State.ExitCode}}' "$bootstrap_container")" == "0" ]] \
  || fail "additive demo bootstrap failed"
[[ "$(docker inspect --format '{{.Image}}' "$bootstrap_container")" == "${image_ids[migrator]}" ]] \
  || fail "additive demo bootstrap used an unexpected image"
pretraffic_evidence="$(jq -c --arg imageId "${image_ids[migrator]}" \
  '. + [{service: "bootstrap_demo", exitCode: 0, imageId: $imageId}]' <<<"$pretraffic_evidence")"

stage="post-bootstrap-accounting-verification"
run_logged 57-post-bootstrap-accounting-reset.log compose --profile operations rm --force --stop verify_accounting_evidence
run_logged 58-post-bootstrap-accounting-up.log compose_timed 30m --profile operations up \
  --detach --no-build --no-deps verify_accounting_evidence
capture_compose_container_id "post-bootstrap accounting verifier container" \
  --profile operations ps --all --quiet verify_accounting_evidence
post_bootstrap_verifier="$captured_compose_container_id"
run_logged 59-post-bootstrap-accounting-wait.log wait_for_captured_containers \
  "post-bootstrap accounting verifier" 59-post-bootstrap-accounting-services.log \
  59-post-bootstrap-accounting-container.json \
  verify_accounting_evidence_post_bootstrap "$post_bootstrap_verifier" "${image_ids[operations]}" -- \
  --profile operations logs --no-color --timestamps verify_accounting_evidence
[[ -n "$post_bootstrap_verifier" \
  && "$(docker inspect --format '{{.State.ExitCode}}' "$post_bootstrap_verifier")" == "0" ]] \
  || fail "post-bootstrap accounting evidence verification failed"
[[ "$(docker inspect --format '{{.Image}}' "$post_bootstrap_verifier")" == "${image_ids[operations]}" ]] \
  || fail "post-bootstrap accounting verifier used an unexpected image"
pretraffic_evidence="$(jq -c --arg imageId "${image_ids[operations]}" \
  '. + [{service: "verify_accounting_evidence_post_bootstrap", exitCode: 0, imageId: $imageId}]' <<<"$pretraffic_evidence")"
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson services "$pretraffic_evidence" \
  '{schemaVersion: 1, completedAt: $at, trafficBlocked: true, postBootstrapAccountingEvidenceVerified: true, services: $services, databaseRollback: "forward-repair-only"}' \
  >"$evidence_directory/53-pretraffic-verification.json"
chmod 0600 -- "$evidence_directory/53-pretraffic-verification.json"

stage="candidate-readiness-with-writes-disabled"
run_quiesced_app() (
  compose_with_overrides \
    DEMO_LOGIN_ENABLED=false DEMO_WRITES_ENABLED=false \
    ACCOUNT_LOGIN_ENABLED=false ACCOUNT_SIGNUP_ENABLED=false \
    AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false \
    BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false -- \
    up --detach --no-deps --no-build --force-recreate app
)
candidate_started="true"
run_logged 60-quiesced-app-start.log run_quiesced_app

wait_for_internal_readiness() {
  local output_file="$1"
  for _ in {1..60}; do
    if curl --fail --silent --show-error --max-time 5 \
      --header 'X-Business-Finlynq-Internal-Health: 1' \
      "http://127.0.0.1:$app_port/api/health" >"$output_file" \
      && jq -e --arg revision "$revision" '.status == "ready" and .revision == $revision' "$output_file" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}
wait_for_internal_readiness "$evidence_directory/61-quiesced-readiness.json" || fail "candidate did not become ready with all write surfaces disabled"
chmod 0600 -- "$evidence_directory/61-quiesced-readiness.json"
for disabled_check in accountAuthentication accountSignup emailWorker bankFeeds; do
  jq -e --arg check "$disabled_check" '.checks[$check] == "disabled"' "$evidence_directory/61-quiesced-readiness.json" >/dev/null \
    || fail "quiesced candidate unexpectedly enabled $disabled_check"
done
quiesced_container="$(compose ps --quiet app)"
[[ -n "$quiesced_container" ]] || fail "quiesced candidate app container is missing"
quiesced_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$quiesced_container")"
for disabled_gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED \
  ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED SIGNUP_TURNSTILE_ENABLED \
  BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED; do
  gate_value="$(awk -F= -v key="$disabled_gate" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' <<<"$quiesced_environment")"
  [[ "$gate_value" == "false" ]] || fail "quiesced candidate gate is not disabled: $disabled_gate"
done

stage="activate-acceptance-gates"
if [[ "$release_ACCOUNT_LOGIN_ENABLED" == "true" ]]; then
  run_logged 62-auth-worker-start.log compose --profile auth-email up --detach --no-deps --no-build --force-recreate auth_email_worker
  auth_worker_container="$(compose --profile auth-email ps --quiet auth_email_worker)"
  [[ -n "$auth_worker_container" ]] || fail "candidate authentication worker is missing"
  [[ "$(docker inspect --format '{{.Image}}' "$auth_worker_container")" == "${image_ids[authWorker]}" ]] \
    || fail "running authentication-worker image ID differs from the built candidate"
  [[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$auth_worker_container")" == "$revision" ]] \
    || fail "running authentication-worker OCI revision differs from the release"
fi
run_acceptance_app() (
  compose_with_overrides BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false -- \
    up --detach --no-deps --no-build --force-recreate app
)
run_logged 63-app-start.log run_acceptance_app
wait_for_internal_readiness "$evidence_directory/64-internal-readiness.json" || fail "candidate did not satisfy detailed readiness"
chmod 0600 -- "$evidence_directory/64-internal-readiness.json"

candidate_container="$(compose ps --quiet app)"
[[ -n "$candidate_container" ]] || fail "candidate app container is missing"
[[ "$(docker inspect --format '{{.Image}}' "$candidate_container")" == "${image_ids[app]}" ]] || fail "running app image ID differs from the built candidate"
[[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_container")" == "$revision" ]] \
  || fail "running app OCI revision differs from the release"
candidate_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$candidate_container")"
[[ "$(awk -F= '$1 == "BUSINESS_WRITES_ENABLED" {print $2; exit}' <<<"$candidate_environment")" == "false" ]] \
  || fail "real business writes were enabled before candidate acceptance"
[[ "$(awk -F= '$1 == "BANK_FEEDS_ENABLED" {print $2; exit}' <<<"$candidate_environment")" == "false" ]] \
  || fail "live bank feeds were enabled before candidate acceptance"

stage="public-readiness"
public_headers="$evidence_directory/65-public-readiness.headers"
public_body="$evidence_directory/65-public-readiness.json"
public_status="$(curl --silent --show-error --max-time 15 --dump-header "$public_headers" --output "$public_body" --write-out '%{http_code}' "$public_base_url/api/health")"
[[ "$public_status" == "200" ]] || fail "public readiness returned HTTP $public_status"
jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$public_body" >/dev/null \
  || fail "public readiness exposed details or was unavailable"
grep -Eiq '^cache-control:.*no-store' "$public_headers" || fail "public readiness is missing no-store"
chmod 0600 -- "$public_headers" "$public_body"

expected_auth="disabled"; [[ "$release_ACCOUNT_LOGIN_ENABLED" == "true" ]] && expected_auth="ready"
expected_signup="disabled"; [[ "$release_ACCOUNT_SIGNUP_ENABLED" == "true" ]] && expected_signup="ready"
expected_worker="disabled"; [[ "$release_ACCOUNT_LOGIN_ENABLED" == "true" ]] && expected_worker="ready"
expected_bank="disabled"
jq -e \
  --arg revision "$revision" --arg auth "$expected_auth" --arg signup "$expected_signup" --arg worker "$expected_worker" --arg bank "$expected_bank" \
  '.status == "ready" and .revision == $revision and .checks.database == "ready" and .checks.organizationKey == "ready" and .checks.identityKey == "ready" and .checks.accountAuthentication == $auth and .checks.accountSignup == $signup and .checks.emailWorker == $worker and .checks.bankFeeds == $bank' \
  "$evidence_directory/64-internal-readiness.json" >/dev/null || fail "detailed readiness does not match the reviewed release gates"

stage="browser-acceptance"
run_browser_acceptance() (
  local browser_container="" browser_exit_code="" browser_image_id=""

  cleanup_browser_acceptance() {
    local cleanup_status=$?
    trap - EXIT INT TERM
    if ! compose --profile acceptance rm --force --stop release_acceptance >/dev/null 2>&1; then
      printf '%s\n' "URGENT: browser-acceptance container could not be removed" >&2
      cleanup_status=1
    fi
    exit "$cleanup_status"
  }
  trap cleanup_browser_acceptance EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  compose --profile acceptance rm --force --stop release_acceptance
  compose --profile acceptance up --detach --no-deps --no-build --force-recreate release_acceptance
  capture_compose_container_id "browser-acceptance container" \
    --profile acceptance ps --all --quiet release_acceptance
  browser_container="$captured_compose_container_id"
  read_docker_output "browser-acceptance image" inspect --format '{{.Image}}' "$browser_container"
  browser_image_id="$docker_query_output"
  [[ "$browser_image_id" == "${image_ids[acceptance]}" ]] \
    || fail "browser acceptance did not use the immutable reviewed image"

  wait_for_captured_containers "browser acceptance" - 70-browser-acceptance-container.json \
    release_acceptance "$browser_container" "${image_ids[acceptance]}" -- \
    --profile acceptance logs --no-color --timestamps release_acceptance
  read_docker_output "browser-acceptance exit code" inspect --format '{{.State.ExitCode}}' "$browser_container"
  browser_exit_code="$docker_query_output"
  [[ "$browser_exit_code" =~ ^[0-9]+$ ]] \
    || fail "browser acceptance returned an invalid exit code"
  (( browser_exit_code == 0 )) || fail "browser acceptance failed"

  compose --profile acceptance rm --force --stop release_acceptance
  browser_container=""
  trap - EXIT INT TERM
)
run_logged 70-browser-acceptance.log run_browser_acceptance
write_checkpoint 71-browser-acceptance.json browser-acceptance-passed

stage="activate-reviewed-write-gates"
run_logged 72-final-app-start.log compose up --detach --no-deps --no-build --force-recreate app
wait_for_internal_readiness "$evidence_directory/73-final-readiness.json" || fail "final reviewed gate posture did not become ready"
chmod 0600 -- "$evidence_directory/73-final-readiness.json"
final_container="$(compose ps --quiet app)"
[[ -n "$final_container" ]] || fail "final candidate app container is missing"
[[ "$(docker inspect --format '{{.Image}}' "$final_container")" == "${image_ids[app]}" ]] \
  || fail "final app image ID differs from the immutable accepted candidate"
[[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$final_container")" == "$revision" ]] \
  || fail "final app OCI revision differs from the accepted release"
final_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$final_container")"
[[ "$(awk -F= '$1 == "BUSINESS_WRITES_ENABLED" {print $2; exit}' <<<"$final_environment")" == "$release_BUSINESS_WRITES_ENABLED" ]] \
  || fail "final business write gate differs from the reviewed environment"
[[ "$(awk -F= '$1 == "BANK_FEEDS_ENABLED" {print $2; exit}' <<<"$final_environment")" == "$release_BANK_FEEDS_ENABLED" ]] \
  || fail "final bank-feed gate differs from the reviewed environment"
final_expected_bank="disabled"; [[ "$release_BANK_FEEDS_ENABLED" == "true" ]] && final_expected_bank="ready"
jq -e --arg revision "$revision" --arg bank "$final_expected_bank" \
  '.status == "ready" and .revision == $revision and .checks.bankFeeds == $bank' \
  "$evidence_directory/73-final-readiness.json" >/dev/null || fail "final readiness does not reflect the reviewed bank-feed gate"

stage="canonical-environment-stability"
[[ "$(validate_secret_environment_file "$canonical_environment_file" "canonical Compose environment")" \
  == "$canonical_environment_file" ]] \
  || fail "canonical Compose environment resolved unexpectedly"
[[ "$(sha256sum "$canonical_environment_file" | awk '{print $1}')" == "$compose_environment_sha256" ]] \
  || fail "canonical Compose environment changed during release"

if [[ "$mode" == "release" ]]; then
  stage="resume-schedulers"
  verify_live_checkout_matches_candidate
  [[ "$(validate_secret_environment_file "$canonical_operations_environment_file" "canonical operations environment")" \
    == "$canonical_operations_environment_file" ]] \
    || fail "canonical operations environment resolved unexpectedly"
  [[ "$(sha256sum "$canonical_operations_environment_file" | awk '{print $1}')" == "$operations_environment_sha256" ]] \
    || fail "canonical operations environment changed during release; schedulers remain paused"
  [[ "$(read_operations_value BUSINESS_FINLYNQ_IMAGE_REVISION)" == "$revision" ]] \
    || fail "canonical operations image revision changed before scheduler resume"
  [[ "$(read_operations_value MONITOR_EXPECT_REVISION)" == "$revision" ]] \
    || fail "canonical monitor revision changed before scheduler resume"
  stage="scheduler-state-contract"
  run_logged 78-scheduler-state-contract.log prepare_scheduler_state_directory
  stage="install-and-verify-backup-schedule"
  run_logged 79-backup-schedule-contract.log install_and_verify_systemd_schedule
  verify_live_checkout_matches_candidate
  # Set this before attempting the multi-resource resume. A partial systemd
  # start or cron installation must drive the failure trap back through the
  # same complete pause/drain boundary.
  schedulers_resumed="true"
  run_logged 80-resume-schedulers.log resume_schedulers
  schedulers_paused="false"
  verify_live_checkout_matches_candidate
  stage="accounting-evidence-seed"
  run_logged 81-accounting-evidence-seed.log run_installed_accounting_evidence
  verify_live_checkout_matches_candidate
  stage="production-monitor-acceptance"
  run_logged 82-production-monitor.log run_installed_monitor
  verify_live_checkout_matches_candidate
  write_checkpoint 83-production-monitor.json installed-scheduled-monitor-passed
  stage="record-scheduler-boundary-version"
  record_scheduler_boundary_version
else
  stage="clean-rehearsal-project"
  run_logged 80-clean-rehearsal.log compose --profile operations --profile auth-email --profile acceptance down --volumes --remove-orphans --timeout 30
  rehearsal_cleaned="true"
  read_docker_output "rehearsal containers after final cleanup" ps -aq \
    --filter "label=com.docker.compose.project=$compose_project"
  [[ -z "$docker_query_output" ]] || fail "rehearsal containers remain after scoped cleanup"
  read_docker_output "rehearsal volumes after final cleanup" volume ls -q \
    --filter "label=com.docker.compose.project=$compose_project"
  [[ -z "$docker_query_output" ]] || fail "rehearsal volumes remain after scoped cleanup"
fi

stage="complete-evidence"
jq -n \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mode "$mode" \
  --arg revision "$revision" \
  --arg runId "$run_id" \
  --arg candidateImageId "${image_ids[app]}" \
  --arg previousImageId "$previous_app_id" \
  --arg browserLogSha256 "$(sha256sum "$evidence_directory/70-browser-acceptance.log" | awk '{print $1}')" \
  '{schemaVersion: 1, product: "business-finlynq", status: "accepted", completedAt: $completedAt, mode: $mode, revision: $revision, runId: $runId, candidateAppImageId: $candidateImageId, previousAppImageId: (if $previousImageId == "" then null else $previousImageId end), preTrafficDatabaseContractVerified: true, postBootstrapAccountingEvidenceVerified: true, browserAcceptancePassed: true, browserLogSha256: $browserLogSha256, databaseRollback: "forward-repair-only"}' \
  >"$evidence_directory/90-release-complete.json"
chmod 0600 -- "$evidence_directory/90-release-complete.json"
refresh_checksums
release_completed="true"
printf 'Business Finlynq %s accepted for %s. Evidence: %s\n' "$mode" "$revision" "$evidence_directory"
