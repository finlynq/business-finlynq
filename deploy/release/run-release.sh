#!/usr/bin/env bash
set -Eeuo pipefail
set +x

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || {
  printf 'Business Finlynq release failed: could not resolve the script directory\n' >&2
  exit 1
}
readonly script_dir
repository_root="$(cd -- "$script_dir/../.." && pwd -P)" || {
  printf 'Business Finlynq release failed: could not resolve the repository directory\n' >&2
  exit 1
}
readonly repository_root
readonly legacy_f8485_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
readonly release_recovery_state_directory="/var/lib/business-finlynq/release-recovery"
readonly first_router_recovery_journal="$release_recovery_state_directory/first-router-pre-cutover.json"
readonly active_finalization_marker="$release_recovery_state_directory/active-finalization.json"

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
terminal_evidence_committed="false"
first_router_recovery_journal_committed="false"
active_finalization_marker_committed="false"
first_router_forward_repair_resume="false"
first_router_recovery_journal_sha256=""
first_router_recovery_source_run_id=""
candidate_started="false"
schedulers_paused="false"
rehearsal_cleaned="false"
schedulers_resumed="false"
scheduler_pause_attempted="false"
write_surface_containment_armed="false"
detached_mutator_containment_armed="false"
initial_schedulers_verified="false"
initial_schedule_installed="false"
initial_state="fresh"
initial_resume_run_id=""
prior_evidence_directory=""
host_lock_fd=""
operations_environment_sha256=""
compose_environment_sha256=""
canonical_environment_file=""
canonical_operations_environment_file=""
environment_snapshot_file=""
operations_environment_snapshot_file=""
candidate_staging_root=""
candidate_source_root=""
candidate_tree_id=""
candidate_source_date_epoch=""
previous_cron_schedule_file=""
release_backup_timeout_seconds="5400"
release_online_backup_timeout_seconds="900"
release_quiesced_backup_timeout_seconds="300"
release_images_pinned="false"
router_maintenance_confirmed="false"
router_was_preexisting="false"
router_active_confirmed="false"
router_transition_attempted="false"
database_mutation_started="false"
write_surfaces_stopped="false"
release_acceptance_token=""
previous_container=""
previous_app_was_running="false"
previous_app_public_edge_detached="false"
previous_auth_worker_container=""
previous_auth_worker_was_running="false"
previous_auth_worker_image_id=""
previous_auth_worker_revision=""
scheduler_boundary_bootstrap_required="false"
scheduler_boundary_bootstrap_source_revision=""
scheduler_boundary_bootstrap_receipt=""
scheduler_boundary_bootstrap_receipt_sha256=""
edge_mode="external"
public_base_url=""
app_port=""
declare -a detached_mutator_services=()

usage() {
  cat <<'USAGE'
Usage:
  run-release.sh --mode release --revision <full-sha> --environment <compose.env> \
    --operations-environment <operations.env> --evidence-root <directory> \
    --run-id <id> --scheduler systemd

  run-release.sh --mode rehearsal --revision <full-sha> --environment <rehearsal.env> \
    --evidence-root <directory> --run-id rehearsal-<id>

  run-release.sh --mode initial --revision <full-sha> --environment <compose.env> \
    --operations-environment <operations.env> --evidence-root <directory> \
    --run-id initial-<id> --scheduler systemd \
    [--resume-initial <prior-initial-run-id>]

  A parent that already holds the shared deployment lock passes
  --host-lock-fd <inherited-fd>.

The matching RELEASE_EXECUTION_ACK is mandatory:
  release:<sha>:<run-id>
  initial:<sha>:<run-id>
  rehearsal:<sha>:<run-id>

Resuming an interrupted initial run also requires:
  INITIAL_RESUME_ACK=resume:<sha>:<prior-run-id>:<new-run-id>
USAGE
}

fail() {
  printf 'Business Finlynq release failed: %s\n' "$1" >&2
  exit 1
}

checked_utc_timestamp() {
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || return 1
  printf '%s' "$timestamp"
}

checked_file_sha256() {
  local selected_file="$1" checksum_output digest remainder
  checksum_output="$(sha256sum -- "$selected_file")" || return 1
  read -r digest remainder <<<"$checksum_output" || return 1
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] || return 1
  printf '%s' "$digest"
}

canonical_compose_sha256() {
  local rendered_configuration="$1" normalized_configuration checksum_output
  local digest remainder
  local stable_root="/__business_finlynq_candidate_source__"
  [[ -n "$candidate_source_root" && "$candidate_source_root" == /* ]] || return 1
  # The private materialization root is intentionally random. Compose resolves
  # build contexts and bind sources through that root, so hash a canonical JSON
  # representation without weakening the immutable candidate-tree boundary.
  jq -e --arg stableRoot "$stable_root" '
    all(.. | strings;
      (. != $stableRoot and (startswith($stableRoot + "/") | not)))
  ' <<<"$rendered_configuration" >/dev/null || return 1
  normalized_configuration="$(jq -cS \
    --arg sourceRoot "$candidate_source_root" --arg stableRoot "$stable_root" '
      walk(
        if type == "string" and
          (. == $sourceRoot or startswith($sourceRoot + "/"))
        then $stableRoot + .[($sourceRoot | length):]
        else .
        end
      )
    ' <<<"$rendered_configuration")" || return 1
  checksum_output="$(printf '%s' "$normalized_configuration" | sha256sum)" || return 1
  read -r digest remainder <<<"$checksum_output" || return 1
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] || return 1
  printf '%s' "$digest"
}

git_command_output=""
read_git_output() {
  local selected_repository="$1" description="$2"
  shift 2
  if ! git_command_output="$(git --no-optional-locks -c safe.directory="$selected_repository" \
    -C "$selected_repository" "$@" 2>/dev/null)"; then
    fail "could not inspect $description in the canonical Git checkout"
  fi
}

assert_clean_checkout() {
  local selected_repository="$1" dirty_message="$2" checkout_status
  if ! checkout_status="$(git --no-optional-locks -c safe.directory="$selected_repository" \
    -C "$selected_repository" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    fail "$dirty_message because Git status could not be inspected"
  fi
  [[ -z "$checkout_status" ]] || fail "$dirty_message"
}

while (( $# > 0 )); do
  case "$1" in
    --mode|--revision|--environment|--operations-environment|--evidence-root|--run-id|--scheduler|--host-lock-fd)
      (( $# >= 2 )) || fail "$1 requires a value"
      case "$1" in
        --mode) mode="$2" ;;
        --revision) revision="$2" ;;
        --environment) environment_file="$2" ;;
        --operations-environment) operations_environment_file="$2" ;;
        --evidence-root) evidence_root="$2" ;;
        --run-id) run_id="$2" ;;
        --scheduler) scheduler_mode="$2" ;;
        --host-lock-fd) host_lock_fd="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --resume-initial)
      (( $# >= 2 )) || fail "--resume-initial requires the prior failed run ID"
      initial_state="resume"
      initial_resume_run_id="$2"
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$mode" == "release" || "$mode" == "initial" || "$mode" == "rehearsal" ]] \
  || fail "--mode must be release, initial, or rehearsal"
[[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] || fail "--revision must be a non-zero full 40-character Git SHA"
readonly image_build_compose_project="business-finlynq-build-$revision"
[[ "$image_build_compose_project" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] \
  || fail "derived image-build Compose project is invalid"
readonly release_router_reference="business-finlynq-release-router:v2"
readonly release_router_revision="release-router-v2"
readonly release_router_contract="v2"
readonly release_router_build_compose_project="business-finlynq-release-router-build-v2"
readonly release_router_source_date_epoch="1788998400"
[[ "$run_id" =~ ^[a-z0-9][a-z0-9._-]{2,30}$ ]] || fail "--run-id must be 3-31 lowercase safe characters"
[[ -n "$environment_file" && -n "$evidence_root" ]] || fail "--environment and --evidence-root are required"
[[ "${RELEASE_EXECUTION_ACK:-}" == "$mode:$revision:$run_id" ]] \
  || fail "RELEASE_EXECUTION_ACK must exactly acknowledge mode, revision, and run ID"

if [[ "$mode" == "release" || "$mode" == "initial" ]]; then
  [[ -n "$operations_environment_file" ]] \
    || fail "--operations-environment is required for production modes"
  [[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
    || fail "--scheduler must be systemd or cron for production modes"
  [[ "$mode" != "release" || "$scheduler_mode" == "systemd" ]] \
    || fail "release mode requires the root-managed systemd scheduler"
  if [[ "$mode" == "initial" ]]; then
    [[ "$run_id" == initial-* ]] || fail "an initial run ID must begin with initial-"
    [[ "$scheduler_mode" == "systemd" ]] \
      || fail "initial mode supports only the root-managed systemd scheduler"
    if [[ "$initial_state" == "resume" ]]; then
      [[ "$initial_resume_run_id" =~ ^initial-[a-z0-9][a-z0-9._-]{2,22}$ ]] \
        || fail "--resume-initial must name a safe prior initial run ID"
      [[ "$initial_resume_run_id" != "$run_id" ]] \
        || fail "an initial resume must use a new immutable run ID"
      [[ "${INITIAL_RESUME_ACK:-}" == \
        "resume:$revision:$initial_resume_run_id:$run_id" ]] \
        || fail "INITIAL_RESUME_ACK must exactly acknowledge the interrupted initial retry"
    fi
  fi
else
  [[ "$initial_state" == "fresh" ]] || fail "--resume-initial is valid only in initial mode"
  [[ "$run_id" == rehearsal-* ]] || fail "a rehearsal run ID must begin with rehearsal-"
  [[ -z "$operations_environment_file" && -z "$scheduler_mode" ]] \
    || fail "rehearsal mode does not operate production schedulers or an operations environment"
fi

for command_name in awk bash chmod chown curl date docker env find flock git grep id install jq mkdir mktemp openssl readlink rm runuser sed sha256sum sleep sort stat sync tar tee timeout touch tr xargs; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"
compose_build_help="$(env -i "PATH=$PATH" docker compose build --help 2>/dev/null)" \
  || fail "Docker Compose build capabilities could not be inspected"
grep -F -- '--provenance' <<<"$compose_build_help" >/dev/null \
  || fail "Docker Compose build does not support explicit provenance control"
grep -F -- '--sbom' <<<"$compose_build_help" >/dev/null \
  || fail "Docker Compose build does not support explicit SBOM control"
unset compose_build_help

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
compose_environment_sha256="$(checked_file_sha256 "$canonical_environment_file")" \
  || fail "Compose environment checksum could not be read"
edge_mode_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
  "$canonical_environment_file")"
[[ "$edge_mode_count" == 0 || "$edge_mode_count" == 1 ]] \
  || fail "Compose environment must define BUSINESS_FINLYNQ_EDGE_MODE at most once"
if [[ "$edge_mode_count" == 1 ]]; then
  edge_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$canonical_environment_file")"
fi
[[ "$edge_mode" == external ]] \
  || fail "shared-edge contract v1 requires BUSINESS_FINLYNQ_EDGE_MODE=external"
if [[ "$mode" != "rehearsal" ]]; then
  operations_environment_file="$(validate_secret_environment_file "$operations_environment_file" "operations environment")"
  reject_repository_path "$operations_environment_file" "operations environment"
  canonical_operations_environment_file="$operations_environment_file"
  [[ "$repository_root" == "/home/deploy/business-finlynq" ]] \
    || fail "production modes must run from the checkout used by the installed scheduler"
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
  operations_environment_sha256="$(checked_file_sha256 \
    "$canonical_operations_environment_file")" \
    || fail "operations environment checksum could not be read"
fi

if [[ "$mode" != "rehearsal" ]]; then
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

if [[ "$mode" != "rehearsal" ]]; then
  acquire_release_coordination_lock "production-release-rollback.lock"
else
  acquire_release_coordination_lock "rehearsal-$compose_project.lock"
fi

acquire_host_deployment_lock() {
  local state_directory="/var/lib/business-finlynq" lock_file deploy_gid deploy_uid caller_uid
  local descriptor_path path_identity descriptor_identity path_contract descriptor_contract
  deploy_gid="$(id -g deploy 2>/dev/null)" \
    || fail "host deployment coordination requires the deploy account"
  deploy_uid="$(id -u deploy 2>/dev/null)" \
    || fail "host deployment coordination requires the deploy account"
  caller_uid="$(id -u)" \
    || fail "host deployment coordination could not inspect the caller"
  [[ "$caller_uid" == 0 || "$caller_uid" == "$deploy_uid" ]] \
    || fail "host deployment coordination requires root or the deploy account"
  [[ -d "$state_directory" && ! -L "$state_directory" \
    && "$(readlink -f -- "$state_directory")" == "$state_directory" \
    && "$(stat -c '%u:%g:%a' -- "$state_directory")" == "0:$deploy_gid:775" ]] \
    || fail "shared deployment state directory must be root:deploy mode 0775"
  lock_file="$state_directory/deployment-host.lock"

  validate_opened_host_lock() {
    local selected_descriptor="$1" require_final_contract="$2"
    descriptor_path="/proc/$$/fd/$selected_descriptor"
    [[ -f "$lock_file" && ! -L "$lock_file" \
      && "$(readlink -f -- "$lock_file")" == "$lock_file" \
      && -e "$descriptor_path" \
      && "$(readlink -f -- "$descriptor_path")" == "$lock_file" ]] \
      || fail "opened deployment-host lock differs from its exact protected path"
    path_identity="$(stat -Lc '%d:%i' -- "$lock_file")" \
      || fail "deployment-host lock path identity is unavailable"
    descriptor_identity="$(stat -Lc '%d:%i' -- "$descriptor_path")" \
      || fail "deployment-host lock descriptor identity is unavailable"
    [[ "$path_identity" == "$descriptor_identity" ]] \
      || fail "deployment-host lock descriptor identity differs from its protected path"
    path_contract="$(stat -Lc '%u:%g:%a:%h' -- "$lock_file")" \
      || fail "deployment-host lock path metadata is unavailable"
    descriptor_contract="$(stat -Lc '%u:%g:%a:%h' -- "$descriptor_path")" \
      || fail "deployment-host lock descriptor metadata is unavailable"
    [[ "$path_contract" == "$descriptor_contract" ]] \
      || fail "deployment-host lock descriptor metadata differs from its protected path"
    if [[ "$require_final_contract" == true ]]; then
      [[ "$path_contract" == "0:$deploy_gid:660:1" ]] \
        || fail "deployment-host lock must be root:deploy mode 0660 with one link"
    else
      [[ "$path_contract" =~ ^0:([0-9]+):(600|660):1$ ]] \
        || fail "legacy deployment-host lock is not safe for root normalization"
      if [[ "${BASH_REMATCH[2]}" == 660 ]]; then
        [[ "${BASH_REMATCH[1]}" == "$deploy_gid" ]] \
          || fail "group-writable deployment-host lock has an unexpected group"
      fi
    fi
  }

  if [[ -n "$host_lock_fd" ]]; then
    [[ "$host_lock_fd" =~ ^([3-9]|[1-9][0-9]{1,2})$ \
      && "$(readlink -f -- "/proc/self/fd/$host_lock_fd")" == "$lock_file" ]] \
      || fail "inherited deployment-host lock descriptor is invalid"
    validate_opened_host_lock "$host_lock_fd" "$([[ "$caller_uid" == 0 ]] && printf false || printf true)"
    flock --exclusive --nonblock "$host_lock_fd" \
      || fail "the inherited deployment-host lock is not held by this process tree"
    if [[ "$caller_uid" == 0 ]]; then
      chown --dereference -- 0:"$deploy_gid" "/proc/$$/fd/$host_lock_fd"
      chmod 0660 -- "/proc/$$/fd/$host_lock_fd"
      validate_opened_host_lock "$host_lock_fd" true
    fi
    return 0
  fi

  [[ ! -L "$lock_file" ]] || fail "shared deployment-host lock is symbolic"
  if [[ ! -e "$lock_file" ]]; then
    [[ "$caller_uid" == 0 ]] \
      || fail "deploy requires the pre-existing root-owned deployment-host lock"
    # Noclobber gives creation O_EXCL semantics. A racing entry is accepted only
    # after the same exact regular-file, owner, link-count, and fd checks below.
    (set -o noclobber; umask 0077; : >"$lock_file") 2>/dev/null || true
  fi
  [[ -f "$lock_file" && ! -L "$lock_file" \
    && "$(readlink -f -- "$lock_file")" == "$lock_file" ]] \
    || fail "shared deployment-host lock is unavailable or unsafe"
  if [[ "$caller_uid" == 0 ]]; then
    path_contract="$(stat -Lc '%u:%g:%a:%h' -- "$lock_file")" \
      || fail "deployment-host lock metadata is unavailable"
    [[ "$path_contract" =~ ^0:([0-9]+):(600|660):1$ ]] \
      || fail "legacy deployment-host lock is not safe for root normalization"
    if [[ "${BASH_REMATCH[2]}" == 660 ]]; then
      [[ "${BASH_REMATCH[1]}" == "$deploy_gid" ]] \
        || fail "group-writable deployment-host lock has an unexpected group"
    fi
  else
    [[ "$(stat -Lc '%u:%g:%a:%h' -- "$lock_file")" == "0:$deploy_gid:660:1" ]] \
      || fail "deploy requires the pre-existing root:deploy mode 0660 deployment-host lock"
  fi
  exec 8<>"$lock_file"
  validate_opened_host_lock 8 "$([[ "$caller_uid" == 0 ]] && printf false || printf true)"
  flock --exclusive --nonblock 8 \
    || fail "another production or development deployment is active"
  if [[ "$caller_uid" == 0 ]]; then
    chown --dereference -- 0:"$deploy_gid" /proc/$$/fd/8
    chmod 0660 -- /proc/$$/fd/8
    validate_opened_host_lock 8 true
  fi
}

acquire_host_deployment_lock

if [[ "$mode" == release \
  && ( -e "$active_finalization_marker" || -L "$active_finalization_marker" ) ]]; then
  fail "an earlier active-finalization marker requires continuous-deployment recovery before a manual release"
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
  scheduler_boundary_bootstrap_receipt_sha256="$(checked_file_sha256 "$receipt_file")" \
    || fail "the pre-checkout scheduler-boundary receipt checksum could not be read"
}

verify_scheduler_boundary_bootstrap

cd -- "$repository_root"
read_git_output "$repository_root" "repository root" rev-parse --show-toplevel
[[ "$git_command_output" == "$repository_root" ]] || fail "script is not running from the reviewed repository root"
read_git_output "$repository_root" "checked-out HEAD" rev-parse HEAD
[[ "$git_command_output" == "$revision" ]] || fail "the requested revision is not the checked-out HEAD"
git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  cat-file -e "$revision^{commit}" 2>/dev/null \
  || fail "the requested revision is not a local Git commit"
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
  local command_project="$2"
  shift 2
  local assignment key value separator_seen="false"
  local -a controlled_environment=("PATH=$PATH")
  local -a compose_files=(-f "$candidate_source_root/docker-compose.yml")

  [[ "$command_project" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] \
    || fail "Compose command project is invalid"

  if [[ "$mode" == "rehearsal" ]]; then
    controlled_environment+=("RELEASE_REHEARSAL_PROJECT=$compose_project")
    compose_files+=(-f "$candidate_source_root/deploy/release/docker-compose.rehearsal.yml")
  fi
  if [[ "$release_images_pinned" == "true" ]]; then
    controlled_environment+=(
      "BUSINESS_FINLYNQ_RELEASE_DATABASE_IMAGE=${image_ids[database]}"
      "BUSINESS_FINLYNQ_RELEASE_ROUTER_IMAGE=${image_ids[router]}"
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
      BUSINESS_FINLYNQ_RELEASE_APP_IMAGE)
        [[ "$value" =~ ^sha256:[a-f0-9]{64}$ ]] \
          || fail "rollback-anchor application image override is invalid"
        ;;
      BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN)
        [[ "$value" =~ ^[a-f0-9]{64}$ ]] \
          || fail "release acceptance token override is invalid"
        ;;
      DEMO_LOGIN_ENABLED|DEMO_WRITES_ENABLED|ACCOUNT_LOGIN_ENABLED|AUTH_OIDC_ENABLED|AUTH_OIDC_SIGNUP_ENABLED|ACCOUNT_SIGNUP_ENABLED|AUTH_EMAIL_DELIVERY_ENABLED|SIGNUP_TURNSTILE_ENABLED|BUSINESS_WRITES_ENABLED|BANK_FEEDS_ENABLED)
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
    --project-name "$command_project"
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
  run_compose "" "$compose_project" -- "$@"
}

compose_with_overrides() {
  run_compose "" "$compose_project" "$@"
}

compose_timed() {
  local duration="$1"
  shift
  run_compose "$duration" "$compose_project" -- "$@"
}

compose_timed_with_overrides() {
  local duration="$1"
  shift
  run_compose "$duration" "$compose_project" "$@"
}

compose_image_build() {
  # Compose writes its CLI project name into image labels. Keep that label
  # stable across isolated rehearsal A/B runtime projects so two builds of
  # one commit can be compared by immutable image ID.
  run_compose "" "$image_build_compose_project" -- "$@"
}

compose_release_router_build() {
  # Unlike application images, the listener is built by one stable project
  # and tag. Its image ID therefore stays unchanged across ordinary commits
  # and across production, development, and rehearsal environments.
  run_compose "" "$release_router_build_compose_project" -- "$@"
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
  local completed_at
  completed_at="$(checked_utc_timestamp)" \
    || fail "checkpoint timestamp could not be generated"
  jq -n \
    --arg at "$completed_at" \
    --arg mode "$mode" \
    --arg revision "$revision" \
    --arg runId "$run_id" \
    --arg stage "$checkpoint" \
    '{schemaVersion: 1, product: "business-finlynq", mode: $mode, revision: $revision, runId: $runId, stage: $stage, completedAt: $at}' \
    >"$evidence_directory/$filename"
  chmod 0600 -- "$evidence_directory/$filename"
}

refresh_checksums() {
  [[ -n "$evidence_directory" && -d "$evidence_directory" \
    && ! -L "$evidence_directory" ]] || return 1
  (
    cd -- "$evidence_directory" || exit 1
    if ! find . -maxdepth 1 -type f ! -name SHA256SUMS \
      ! -name .SHA256SUMS.partial \
      ! -name .90-release-complete.json.partial \
      ! -name .99-failure.json.partial -print0 \
      | sort -z \
      | xargs -0 -r sha256sum >.SHA256SUMS.partial; then
      rm -f -- .SHA256SUMS.partial
      exit 1
    fi
    mv -f -- .SHA256SUMS.partial SHA256SUMS || exit 1
    chmod 0600 SHA256SUMS || exit 1
  )
}

sync_evidence_inventory() {
  [[ -n "$evidence_directory" && -d "$evidence_directory" \
    && -f "$evidence_directory/SHA256SUMS" \
    && ! -L "$evidence_directory/SHA256SUMS" ]] \
    || return 1
  # GNU sync -f uses syncfs for the containing filesystem. Sync the inventory
  # itself first, then the directory/filesystem so terminal evidence and its
  # directory entry are durable before a wrapper can publish completion.
  sync -f -- "$evidence_directory/SHA256SUMS" \
    && sync -f -- "$evidence_directory"
}

run_logged() {
  local filename="$1"
  shift
  local command_status=0 display_status=0 chmod_status=0
  local restore_errexit="false"
  if [[ "$-" == *e* ]]; then
    restore_errexit="true"
  fi
  # Keep fail()/exit inside an isolated command scope so the parent EXIT trap
  # cannot run while its diagnostics are still redirected to this log. Capture
  # first, then display through a separately checked tee so either evidence I/O
  # boundary can fail the release. Preserve the caller's errexit state while
  # collecting the isolated command status. Parent-owned recovery state is
  # established explicitly at each call site after its durable postcondition
  # is verified.
  set +e
  (
    trap - EXIT ERR INT TERM
    set -Eeuo pipefail
    "$@"
  ) >"$evidence_directory/$filename" 2>&1
  command_status=$?
  if [[ "$restore_errexit" == "true" ]]; then
    set -e
  fi
  if tee <"$evidence_directory/$filename"; then
    display_status=0
  else
    display_status=$?
  fi
  if chmod 0600 -- "$evidence_directory/$filename"; then
    chmod_status=0
  else
    chmod_status=$?
  fi
  (( command_status == 0 )) || return "$command_status"
  (( display_status == 0 )) || return "$display_status"
  (( chmod_status == 0 )) || return "$chmod_status"
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
      ' <<<"$container_evidence")" \
      || fail "$description container evidence could not be assembled"
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
    ' >"$evidence_directory/$state_evidence_filename" \
    || fail "$description state evidence could not be written"
  chmod 0600 -- "$evidence_directory/$state_evidence_filename" \
    || fail "$description state evidence permissions could not be set"

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

contain_initial_schedule_on_failure() {
  local unit_name load_state enabled_state active_state enabled_status active_status
  local -a timer_units=(
    business-finlynq-backup.timer
    business-finlynq-monitor.timer
    business-finlynq-accounting-evidence.timer
    business-finlynq-demo-reconcile.timer
    business-finlynq-continuous-deployment.timer
  )
  local -a service_units=(
    business-finlynq-backup.service
    business-finlynq-monitor.service
    business-finlynq-accounting-evidence.service
    business-finlynq-demo-reconcile.service
    business-finlynq-continuous-deployment.service
  )
  command -v systemctl >/dev/null 2>&1 || return 1
  for unit_name in "${timer_units[@]}"; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || return 1
    [[ -n "$load_state" && "$load_state" != error ]] || return 1
    [[ "$load_state" == not-found ]] && continue
    systemctl disable --now "$unit_name" >/dev/null 2>&1 || return 1
    enabled_state=""; enabled_status=0
    if enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"; then
      enabled_status=0
    else
      enabled_status=$?
    fi
    [[ "$enabled_status" == "1" && "$enabled_state" == "disabled" ]] || return 1
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    [[ "$active_status" == "3" && "$active_state" == "inactive" ]] || return 1
  done
  for unit_name in "${service_units[@]}"; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || return 1
    [[ -n "$load_state" && "$load_state" != error ]] || return 1
    [[ "$load_state" == not-found ]] && continue
    systemctl stop "$unit_name" >/dev/null 2>&1 || return 1
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    [[ "$active_status" == "3" && "$active_state" == "inactive" ]] || return 1
  done
}

restore_stopped_previous_app_anchor() {
  local anchor_container anchor_image anchor_status restored_at

  [[ "$mode" == "release" \
    && "${previous_app_id:-}" =~ ^sha256:[a-f0-9]{64}$ \
    && "${previous_app_revision:-}" =~ ^[a-f0-9]{40}$ ]] || return 1
  [[ "$(docker image inspect --format '{{.Id}}' "$previous_app_id" 2>/dev/null)" \
    == "$previous_app_id" ]] || return 1

  compose_with_overrides \
    "BUSINESS_FINLYNQ_RELEASE_APP_IMAGE=$previous_app_id" \
    DEMO_LOGIN_ENABLED=false DEMO_WRITES_ENABLED=false \
    ACCOUNT_LOGIN_ENABLED=false AUTH_OIDC_ENABLED=false AUTH_OIDC_SIGNUP_ENABLED=false ACCOUNT_SIGNUP_ENABLED=false \
    AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false \
    BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false -- \
    up --no-start --no-deps --no-build --force-recreate app >/dev/null 2>&1 \
    || return 1
  anchor_container="$(compose ps --all --quiet app 2>/dev/null)"
  [[ "$anchor_container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  anchor_image="$(docker inspect --format '{{.Image}}' "$anchor_container" 2>/dev/null)"
  anchor_status="$(docker inspect --format '{{.State.Status}}' "$anchor_container" 2>/dev/null)"
  [[ "$anchor_image" == "$previous_app_id" && "$anchor_status" == "created" ]] || return 1
  restored_at="$(checked_utc_timestamp)" || return 1
  jq -n \
    --arg at "$restored_at" \
    --arg containerId "$anchor_container" \
    --arg imageId "$anchor_image" \
    --arg revision "$previous_app_revision" \
    '{schemaVersion: 1, product: "business-finlynq", restoredAt: $at, containerId: $containerId, imageId: $imageId, revision: $revision, runtimeStatus: "created", writeGates: "disabled"}' \
    >"$evidence_directory/97-failure-rollback-anchor.json" || return 1
  chmod 0600 -- "$evidence_directory/97-failure-rollback-anchor.json" || return 1
}

ensure_release_recovery_state_directory() {
  [[ ! -L "$release_recovery_state_directory" ]] || return 1
  install -d -o root -g root -m 0700 -- "$release_recovery_state_directory" \
    || return 1
  [[ -d "$release_recovery_state_directory" \
    && ! -L "$release_recovery_state_directory" \
    && "$(readlink -f -- "$release_recovery_state_directory")" \
      == "$release_recovery_state_directory" \
    && "$(stat -c '%u:%g:%a' -- "$release_recovery_state_directory")" == 0:0:700 ]] \
    || return 1
}

write_first_router_recovery_journal() (
  set -Eeuo pipefail
  local app_container_id worker_container_id="" router_container_id="" router_image_id=""
  local created_at temporary
  [[ "$mode" == release && "$database_mutation_started" != true \
    && "$previous_app_was_running" == true \
    && "$previous_container" =~ ^[a-f0-9]{12,64}$ \
    && "$previous_app_id" =~ ^sha256:[a-f0-9]{64}$ \
    && "$previous_app_revision" =~ ^[a-f0-9]{40}$ ]] || return 1
  ensure_release_recovery_state_directory || return 1
  [[ ! -e "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" ]] || return 1
  app_container_id="$(docker inspect --format '{{.Id}}' "$previous_container")" \
    || return 1
  [[ "$app_container_id" =~ ^[a-f0-9]{64}$ \
    && "$(docker inspect --format '{{.Image}}|{{.State.Running}}' \
      "$app_container_id")" == "$previous_app_id|true" ]] || return 1
  if [[ "$router_was_preexisting" == true ]]; then
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_private-frontend release-app "$app_container_id" || return 1
    resolve_release_router_container
    router_container_id="$(docker inspect --format '{{.Id}}' \
      "$release_router_container_id")" || return 1
    router_image_id="$(docker inspect --format '{{.Image}}' \
      "$router_container_id")" || return 1
    [[ "$router_container_id" =~ ^[a-f0-9]{64}$ \
      && "$router_image_id" == "${image_ids[router]}" \
      && "$(docker inspect --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$router_container_id")" == true\|healthy ]] || return 1
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_edge production-app "$router_container_id" || return 1
  else
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_edge production-app "$app_container_id" || return 1
  fi
  if [[ "$previous_auth_worker_was_running" == true ]]; then
    worker_container_id="$(docker inspect --format '{{.Id}}' \
      "$previous_auth_worker_container")" || return 1
    [[ "$worker_container_id" =~ ^[a-f0-9]{64}$ \
      && "$previous_auth_worker_image_id" =~ ^sha256:[a-f0-9]{64}$ \
      && "$previous_auth_worker_revision" == "$previous_app_revision" \
      && "$(docker inspect --format '{{.Image}}|{{.State.Running}}' \
        "$worker_container_id")" == "$previous_auth_worker_image_id|true" ]] || return 1
  fi
  created_at="$(checked_utc_timestamp)" || return 1
  temporary="$(mktemp \
    "$release_recovery_state_directory/.first-router-pre-cutover.XXXXXX")" \
    || return 1
  trap 'rm -f -- "$temporary"' EXIT INT TERM
  jq -n \
    --arg createdAt "$created_at" \
    --arg sourceRevision "$previous_app_revision" \
    --arg candidateRevision "$revision" \
    --arg runId "$run_id" \
    --arg appContainerId "$app_container_id" \
    --arg appImageId "$previous_app_id" \
    --arg routerWasPreexisting "$router_was_preexisting" \
    --arg routerContainerId "$router_container_id" \
    --arg routerImageId "$router_image_id" \
    --arg workerWasRunning "$previous_auth_worker_was_running" \
    --arg workerContainerId "$worker_container_id" \
    --arg workerImageId "$previous_auth_worker_image_id" \
    --arg workerRevision "$previous_auth_worker_revision" '
      {
        schemaVersion: 1,
        product: "business-finlynq",
        kind: "first-router-pre-cutover",
        phase: "pre-router-maintenance",
        createdAt: $createdAt,
        sourceRevision: $sourceRevision,
        candidateRevision: $candidateRevision,
        runId: $runId,
        routerWasPreexisting: ($routerWasPreexisting == "true"),
        router: (if $routerWasPreexisting == "true" then
          {containerId: $routerContainerId, imageId: $routerImageId}
        else
          {containerId: null, imageId: null}
        end),
        databaseMutationStarted: false,
        app: {containerId: $appContainerId, imageId: $appImageId},
        authWorker: (if $workerWasRunning == "true" then
          {wasRunning: true, containerId: $workerContainerId,
            imageId: $workerImageId, revision: $workerRevision}
        else
          {wasRunning: false, containerId: null, imageId: null, revision: null}
        end)
      }
    ' >"$temporary" || return 1
  chmod 0600 -- "$temporary" || return 1
  chown root:root -- "$temporary" || return 1
  [[ "$(stat -c '%u:%g:%a:%h' -- "$temporary")" == 0:0:600:1 ]] \
    || return 1
  sync -f -- "$temporary" || return 1
  mv -- "$temporary" "$first_router_recovery_journal" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  trap - EXIT INT TERM
)

clear_first_router_recovery_journal() {
  local app_container_id="$previous_container" worker_container_id=""
  ensure_release_recovery_state_directory || return 1
  [[ -f "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" \
    && "$(readlink -f -- "$first_router_recovery_journal")" \
      == "$first_router_recovery_journal" \
    && "$(stat -c '%u:%g:%a:%h' -- "$first_router_recovery_journal")" \
      == 0:0:600:1 ]] || return 1
  if [[ "$previous_auth_worker_was_running" == true ]]; then
    worker_container_id="$previous_auth_worker_container"
  fi
  [[ "$app_container_id" =~ ^[a-f0-9]{64}$ \
    && ( "$previous_auth_worker_was_running" != true \
      || "$worker_container_id" =~ ^[a-f0-9]{64}$ ) ]] || return 1
  jq -e \
    --arg sourceRevision "$previous_app_revision" \
    --arg candidateRevision "$revision" \
    --arg appContainerId "$app_container_id" \
    --arg appImageId "$previous_app_id" \
    --arg workerWasRunning "$previous_auth_worker_was_running" \
    --arg workerContainerId "$worker_container_id" \
    --arg workerImageId "$previous_auth_worker_image_id" \
    --arg workerRevision "$previous_auth_worker_revision" '
      type == "object" and
      (keys == (["app", "authWorker", "candidateRevision", "createdAt",
        "databaseMutationStarted", "kind", "phase", "product",
        "router", "routerWasPreexisting", "runId", "schemaVersion", "sourceRevision"] | sort) or
       keys == (["app", "authWorker", "candidateRevision", "createdAt",
        "databaseMutationStarted", "kind", "mutationArmedAt", "phase", "product",
        "router", "routerWasPreexisting", "runId", "schemaVersion", "sourceRevision"] | sort)) and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .kind == "first-router-pre-cutover" and
      ((.phase == "pre-router-maintenance" and .databaseMutationStarted == false) or
        (.phase == "forward-repair-required" and .databaseMutationStarted == true)) and
      .sourceRevision == $sourceRevision and .candidateRevision == $candidateRevision and
      (.runId | type == "string" and test("^[a-z0-9][a-z0-9._-]{2,30}$")) and
      (.routerWasPreexisting | type == "boolean") and
      (if .routerWasPreexisting then
        (.router.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
        (.router.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$"))
      else .router == {containerId: null, imageId: null} end) and
      .app == {containerId: $appContainerId, imageId: $appImageId} and
      .authWorker == (if $workerWasRunning == "true" then
        {wasRunning: true, containerId: $workerContainerId,
          imageId: $workerImageId, revision: $workerRevision}
      else
        {wasRunning: false, containerId: null, imageId: null, revision: null}
      end)
    ' "$first_router_recovery_journal" >/dev/null || return 1
  rm -- "$first_router_recovery_journal" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  first_router_recovery_journal_committed="false"
}

mark_first_router_database_mutation_started() (
  set -Eeuo pipefail
  local armed_at temporary
  [[ "$first_router_recovery_journal_committed" == true \
    && "$first_router_forward_repair_resume" != true ]] || return 1
  ensure_release_recovery_state_directory || return 1
  [[ -f "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" \
    && "$(stat -c '%u:%g:%a:%h' -- "$first_router_recovery_journal")" \
      == 0:0:600:1 ]] || return 1
  jq -e --arg candidateRevision "$revision" --arg sourceRevision "$previous_app_revision" '
    type == "object" and .schemaVersion == 1 and .product == "business-finlynq" and
    .kind == "first-router-pre-cutover" and .phase == "pre-router-maintenance" and
    .databaseMutationStarted == false and (.routerWasPreexisting | type == "boolean") and
    .candidateRevision == $candidateRevision and .sourceRevision == $sourceRevision
  ' "$first_router_recovery_journal" >/dev/null || return 1
  armed_at="$(checked_utc_timestamp)" || return 1
  temporary="$(mktemp \
    "$release_recovery_state_directory/.first-router-forward-repair.XXXXXX")" \
    || return 1
  trap 'rm -f -- "$temporary"' EXIT INT TERM
  jq --arg armedAt "$armed_at" '
    .phase = "forward-repair-required" |
    .databaseMutationStarted = true |
    .mutationArmedAt = $armedAt
  ' "$first_router_recovery_journal" >"$temporary" || return 1
  chmod 0600 -- "$temporary" || return 1
  chown root:root -- "$temporary" || return 1
  sync -f -- "$temporary" || return 1
  mv -f -- "$temporary" "$first_router_recovery_journal" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  trap - EXIT INT TERM
)

load_first_router_forward_repair_journal() {
  local app_container_id app_image_id router_query router_contract router_mode
  local worker_was_running worker_container_id worker_image_id worker_revision
  local journal_source_revision journal_candidate_revision journal_run_id digest_output
  local journal_router_was_preexisting journal_router_container_id journal_router_image_id
  local tagged_source_image tagged_source_worker_image="" current_container current_app_image
  local current_app_inventory current_worker_inventory
  local -a current_app_containers=() current_worker_containers=()
  [[ -e "$first_router_recovery_journal" || -L "$first_router_recovery_journal" ]] \
    || return 1
  ensure_release_recovery_state_directory \
    || fail "first-router forward-repair directory is unsafe"
  [[ -f "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" \
    && "$(readlink -f -- "$first_router_recovery_journal")" \
      == "$first_router_recovery_journal" \
    && "$(stat -c '%u:%g:%a:%h' -- "$first_router_recovery_journal")" \
      == 0:0:600:1 ]] \
    || fail "first-router forward-repair journal is unsafe"
  jq -e --arg candidateRevision "$revision" '
      type == "object" and
      keys == (["app", "authWorker", "candidateRevision", "createdAt",
        "databaseMutationStarted", "kind", "mutationArmedAt", "phase", "product",
        "router", "routerWasPreexisting", "runId", "schemaVersion", "sourceRevision"] | sort) and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .kind == "first-router-pre-cutover" and .phase == "forward-repair-required" and
      .databaseMutationStarted == true and (.routerWasPreexisting | type == "boolean") and
      (if .routerWasPreexisting then
        (.router.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
        (.router.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$"))
      else .router == {containerId: null, imageId: null} end) and
      .candidateRevision == $candidateRevision and
      (.sourceRevision | type == "string" and test("^[a-f0-9]{40}$")) and
      (.runId | type == "string" and test("^[a-z0-9][a-z0-9._-]{2,30}$")) and
      (.createdAt | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.mutationArmedAt | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.app.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
      (.app.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
      (.authWorker.wasRunning | type == "boolean") and
      (if .authWorker.wasRunning then
        (.authWorker.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
        (.authWorker.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
        .authWorker.revision == .sourceRevision
      else
        .authWorker == {wasRunning: false, containerId: null, imageId: null, revision: null}
      end)
    ' "$first_router_recovery_journal" >/dev/null \
    || fail "first-router forward-repair journal does not match this exact candidate"
  journal_source_revision="$(jq -er '.sourceRevision' "$first_router_recovery_journal")"
  journal_candidate_revision="$(jq -er '.candidateRevision' "$first_router_recovery_journal")"
  journal_run_id="$(jq -er '.runId' "$first_router_recovery_journal")"
  app_container_id="$(jq -er '.app.containerId' "$first_router_recovery_journal")"
  app_image_id="$(jq -er '.app.imageId' "$first_router_recovery_journal")"
  worker_was_running="$(jq -r '.authWorker.wasRunning | tostring' \
    "$first_router_recovery_journal")"
  worker_container_id="$(jq -r '.authWorker.containerId // ""' \
    "$first_router_recovery_journal")"
  worker_image_id="$(jq -r '.authWorker.imageId // ""' \
    "$first_router_recovery_journal")"
  worker_revision="$(jq -r '.authWorker.revision // ""' \
    "$first_router_recovery_journal")"
  journal_router_was_preexisting="$(jq -r '.routerWasPreexisting | tostring' \
    "$first_router_recovery_journal")"
  journal_router_container_id="$(jq -r '.router.containerId // ""' \
    "$first_router_recovery_journal")"
  journal_router_image_id="$(jq -r '.router.imageId // ""' \
    "$first_router_recovery_journal")"
  git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    cat-file -e "$journal_source_revision^{commit}" 2>/dev/null \
    || fail "journaled source revision is not a retained local Git commit"
  if [[ "$journal_source_revision" == "$legacy_f8485_revision" ]]; then
    [[ "$app_image_id" == "$legacy_f8485_image_id" ]] \
      || fail "journaled legacy application image differs from the exact compatibility artifact"
  else
    tagged_source_image="$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-app:$journal_source_revision" 2>/dev/null)" \
      || fail "journaled source application tag is unavailable"
    [[ "$app_image_id" == "$tagged_source_image" ]] \
      || fail "journaled source application image lost its immutable tag"
  fi
  if ! current_app_inventory="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=app)"; then
    fail "forward-repair application inventory could not be read"
  fi
  if [[ -n "$current_app_inventory" ]]; then
    mapfile -t current_app_containers <<<"$current_app_inventory"
  fi
  (( ${#current_app_containers[@]} <= 1 )) \
    || fail "forward repair found an ambiguous application inventory"
  if (( ${#current_app_containers[@]} == 1 )); then
    current_container="${current_app_containers[0]}"
    docker inspect "$current_container" | jq -e \
      --arg sourceRevision "$journal_source_revision" \
      --arg sourceImage "$app_image_id" \
      --arg candidateRevision "$revision" \
      --arg candidateImage "${image_ids[app]}" \
      --arg legacyRevision "$legacy_f8485_revision" '
        length == 1 and
        .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
        .[0].Config.Labels["com.docker.compose.service"] == "app" and
        .[0].State.Running == false and .[0].HostConfig.ReadonlyRootfs == true and
        .[0].HostConfig.Privileged == false and
        .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
        ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
        ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
        ((.[0].Image == $sourceImage and
          (if $sourceRevision == $legacyRevision then
             ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
           else
             .[0].Config.Labels["org.opencontainers.image.revision"] == $sourceRevision
           end)) or
         (.[0].Image == $candidateImage and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $candidateRevision))
      ' >/dev/null \
      || fail "forward repair retained an unexpected application container"
    current_app_image="$(docker inspect --format '{{.Image}}' "$current_container")" \
      || fail "forward-repair application image could not be inspected"
    if [[ "$journal_router_was_preexisting" == true \
      || "$current_app_image" == "${image_ids[app]}" ]]; then
      network_alias_has_exact_owner_nonfatal \
        business_finlynq_private-frontend release-app "$current_container" \
        || fail "forward-repair application lost its unique private alias"
    else
      [[ "$current_app_image" == "$app_image_id" \
        && "$(docker inspect --format \
          '{{if index .NetworkSettings.Networks "business_finlynq_edge"}}attached{{end}}' \
          "$current_container")" == "" ]] \
        || fail "forward-repair legacy source application retained the public edge"
    fi
  fi
  if [[ "$worker_was_running" == true ]]; then
    [[ "$(docker image inspect --format '{{.Id}}' "$worker_image_id" 2>/dev/null)" \
      == "$worker_image_id" ]] \
      || fail "journaled source authentication-worker image is unavailable"
    tagged_source_worker_image="$worker_image_id"
  elif [[ "$journal_source_revision" != "$legacy_f8485_revision" ]]; then
    tagged_source_worker_image="$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-auth-worker:$journal_source_revision" 2>/dev/null || true)"
  fi
  if ! current_worker_inventory="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=auth_email_worker)"; then
    fail "forward-repair authentication-worker inventory could not be read"
  fi
  if [[ -n "$current_worker_inventory" ]]; then
    mapfile -t current_worker_containers <<<"$current_worker_inventory"
  fi
  (( ${#current_worker_containers[@]} <= 1 )) \
    || fail "forward repair found an ambiguous authentication-worker inventory"
  if (( ${#current_worker_containers[@]} == 1 )); then
    current_container="${current_worker_containers[0]}"
    docker inspect "$current_container" | jq -e \
      --arg sourceRevision "$journal_source_revision" \
      --arg sourceImage "$tagged_source_worker_image" \
      --arg candidateRevision "$revision" \
      --arg candidateImage "${image_ids[authWorker]}" '
        length == 1 and
        .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
        .[0].Config.Labels["com.docker.compose.service"] == "auth_email_worker" and
        .[0].State.Running == false and .[0].HostConfig.ReadonlyRootfs == true and
        .[0].HostConfig.Privileged == false and
        .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
        ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
        ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
        ((($sourceImage | length) > 0 and .[0].Image == $sourceImage and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $sourceRevision) or
         (.[0].Image == $candidateImage and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $candidateRevision))
      ' >/dev/null \
      || fail "forward repair retained an unexpected authentication-worker container"
  fi
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" \
    || fail "forward-repair release-router inventory could not be read"
  [[ "$router_query" =~ ^[a-f0-9]{64}$ && "$router_query" != *$'\n'* ]] \
    || fail "forward-repair requires exactly one stable release router"
  router_contract="$(docker inspect --format \
    '{{.Id}}|{{.Image}}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "com.business-finlynq.release-router.contract" }}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$router_query")" || fail "forward-repair release router could not be inspected"
  [[ "$router_contract" \
    == "$router_query|${image_ids[router]}|release-router-v2|v2|true|healthy" ]] \
    || fail "forward-repair release router differs from the immutable candidate contract"
  if [[ "$journal_router_was_preexisting" == true ]]; then
    [[ "$router_query" == "$journal_router_container_id" \
      && "${image_ids[router]}" == "$journal_router_image_id" ]] \
      || fail "forward-repair stable router differs from its pre-cutover identity"
  fi
  router_mode="$(docker exec "$router_query" sh -ec '
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  ')" || fail "forward-repair release-router mode could not be inspected"
  [[ "$router_mode" == maintenance ]] \
    || fail "forward-repair release router is not durably in maintenance"
  network_alias_has_exact_owner_nonfatal \
    business_finlynq_edge production-app "$router_query" \
    || fail "forward-repair release router is not the unique public backend"
  digest_output="$(sha256sum -- "$first_router_recovery_journal")" \
    || fail "first-router forward-repair journal could not be hashed"
  first_router_recovery_journal_sha256="${digest_output%% *}"
  [[ "$first_router_recovery_journal_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || fail "first-router forward-repair journal digest is invalid"
  first_router_recovery_source_run_id="$journal_run_id"
  first_router_forward_repair_resume="true"
  first_router_recovery_journal_committed="true"
  database_mutation_started="true"
  router_was_preexisting="true"
  previous_container="$app_container_id"
  previous_app_id="$app_image_id"
  previous_app_revision="$journal_source_revision"
  previous_auth_worker_was_running="$worker_was_running"
  previous_auth_worker_container="$worker_container_id"
  previous_auth_worker_image_id="$worker_image_id"
  previous_auth_worker_revision="$worker_revision"
  export FIRST_ROUTER_FORWARD_REPAIR_ACK="forward-repair:$journal_candidate_revision:$first_router_recovery_journal_sha256"
}

write_active_finalization_marker() (
  set -Eeuo pipefail
  local app_container_id router_container_id created_at temporary
  cleanup_active_finalization_marker_write() {
    local cleanup_status=$?
    trap - EXIT HUP INT TERM
    [[ -z "${temporary:-}" ]] || rm -f -- "$temporary"
    exit "$cleanup_status"
  }
  [[ "$mode" == release && "$revision" =~ ^[a-f0-9]{40}$ \
    && "$final_container" =~ ^[a-f0-9]{12,64}$ \
    && "${image_ids[app]}" =~ ^sha256:[a-f0-9]{64}$ \
    && "${image_ids[router]}" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  ensure_release_recovery_state_directory || return 1
  [[ ! -e "$active_finalization_marker" && ! -L "$active_finalization_marker" ]] \
    || return 1
  app_container_id="$(docker inspect --format '{{.Id}}' "$final_container")" \
    || return 1
  resolve_release_router_container
  router_container_id="$(docker inspect --format '{{.Id}}' \
    "$release_router_container_id")" || return 1
  [[ "$app_container_id" =~ ^[a-f0-9]{64}$ \
    && "$router_container_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  created_at="$(checked_utc_timestamp)" || return 1
  temporary="$(mktemp \
    "$release_recovery_state_directory/.active-finalization.XXXXXX")" || return 1
  trap cleanup_active_finalization_marker_write EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  jq -n \
    --arg createdAt "$created_at" \
    --arg revision "$revision" \
    --arg runId "$run_id" \
    --arg appContainerId "$app_container_id" \
    --arg appImageId "${image_ids[app]}" \
    --arg routerContainerId "$router_container_id" \
    --arg routerImageId "${image_ids[router]}" '
      {
        schemaVersion: 1,
        product: "business-finlynq",
        kind: "active-finalization",
        phase: "terminal-evidence-pending",
        createdAt: $createdAt,
        revision: $revision,
        runId: $runId,
        app: {containerId: $appContainerId, imageId: $appImageId},
        router: {containerId: $routerContainerId, imageId: $routerImageId}
      }
    ' >"$temporary" || return 1
  chmod 0600 -- "$temporary" || return 1
  chown root:root -- "$temporary" || return 1
  [[ "$(stat -c '%u:%g:%a:%h' -- "$temporary")" == 0:0:600:1 ]] \
    || return 1
  sync -f -- "$temporary" || return 1
  mv -- "$temporary" "$active_finalization_marker" || return 1
  temporary=""
  sync -f -- "$release_recovery_state_directory" || return 1
  trap - EXIT HUP INT TERM
)

authorize_active_finalization_marker() (
  set -Eeuo pipefail
  local app_container_id router_container_id authorized_at terminal_evidence_sha256
  local terminal_evidence_file temporary=""
  cleanup_active_finalization_authorization() {
    local cleanup_status=$?
    trap - EXIT HUP INT TERM
    [[ -z "$temporary" ]] || rm -f -- "$temporary"
    exit "$cleanup_status"
  }
  [[ "$mode" == release && "$revision" =~ ^[a-f0-9]{40}$ \
    && "$final_container" =~ ^[a-f0-9]{12,64}$ \
    && "${image_ids[app]}" =~ ^sha256:[a-f0-9]{64}$ \
    && "${image_ids[router]}" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  ensure_release_recovery_state_directory || return 1
  [[ -f "$active_finalization_marker" && ! -L "$active_finalization_marker" \
    && "$(readlink -f -- "$active_finalization_marker")" == "$active_finalization_marker" \
    && "$(stat -c '%u:%g:%a:%h' -- "$active_finalization_marker")" \
      == 0:0:600:1 ]] || return 1
  terminal_evidence_file="$evidence_directory/90-release-complete.json"
  [[ -f "$terminal_evidence_file" && ! -L "$terminal_evidence_file" \
    && "$(stat -c '%u:%g:%a:%h' -- "$terminal_evidence_file")" \
      == 0:0:600:1 ]] || return 1
  terminal_evidence_sha256="$(checked_file_sha256 "$terminal_evidence_file")" \
    || return 1
  app_container_id="$(docker inspect --format '{{.Id}}' "$final_container")" \
    || return 1
  resolve_release_router_container
  router_container_id="$(docker inspect --format '{{.Id}}' \
    "$release_router_container_id")" || return 1
  jq -e \
    --arg revision "$revision" --arg runId "$run_id" \
    --arg appContainerId "$app_container_id" \
    --arg appImageId "${image_ids[app]}" \
    --arg routerContainerId "$router_container_id" \
    --arg routerImageId "${image_ids[router]}" '
      type == "object" and
      keys == (["app", "createdAt", "kind", "phase", "product", "revision",
        "router", "runId", "schemaVersion"] | sort) and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .kind == "active-finalization" and .phase == "terminal-evidence-pending" and
      .revision == $revision and .runId == $runId and
      .app == {containerId: $appContainerId, imageId: $appImageId} and
      .router == {containerId: $routerContainerId, imageId: $routerImageId}
    ' "$active_finalization_marker" >/dev/null || return 1
  authorized_at="$(checked_utc_timestamp)" || return 1
  temporary="$(mktemp \
    "$release_recovery_state_directory/.active-finalization-authorized.XXXXXX")" \
    || return 1
  trap cleanup_active_finalization_authorization EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  jq --arg authorizedAt "$authorized_at" \
    --arg terminalEvidenceSha256 "$terminal_evidence_sha256" '
      .phase = "active-commit-authorized" |
      .authorizedAt = $authorizedAt |
      .terminalEvidenceSha256 = $terminalEvidenceSha256
    ' "$active_finalization_marker" >"$temporary" || return 1
  chmod 0600 -- "$temporary" || return 1
  chown root:root -- "$temporary" || return 1
  [[ "$(stat -c '%u:%g:%a:%h' -- "$temporary")" == 0:0:600:1 ]] \
    || return 1
  sync -f -- "$temporary" || return 1
  mv -f -- "$temporary" "$active_finalization_marker" || return 1
  temporary=""
  sync -f -- "$release_recovery_state_directory" || return 1
  trap - EXIT HUP INT TERM
)

clear_active_finalization_marker() {
  local app_container_id router_container_id terminal_evidence_sha256
  ensure_release_recovery_state_directory || return 1
  [[ -f "$active_finalization_marker" && ! -L "$active_finalization_marker" \
    && "$(readlink -f -- "$active_finalization_marker")" == "$active_finalization_marker" \
    && "$(stat -c '%u:%g:%a:%h' -- "$active_finalization_marker")" \
      == 0:0:600:1 ]] || return 1
  app_container_id="$(docker inspect --format '{{.Id}}' "$final_container")" \
    || return 1
  resolve_release_router_container
  router_container_id="$(docker inspect --format '{{.Id}}' \
    "$release_router_container_id")" || return 1
  terminal_evidence_sha256="$(checked_file_sha256 \
    "$evidence_directory/90-release-complete.json")" || return 1
  jq -e \
    --arg revision "$revision" --arg runId "$run_id" \
    --arg appContainerId "$app_container_id" \
    --arg appImageId "${image_ids[app]}" \
    --arg routerContainerId "$router_container_id" \
    --arg routerImageId "${image_ids[router]}" \
    --arg terminalEvidenceSha256 "$terminal_evidence_sha256" '
      type == "object" and
      keys == (["app", "authorizedAt", "createdAt", "kind", "phase", "product",
        "revision", "router", "runId", "schemaVersion",
        "terminalEvidenceSha256"] | sort) and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .kind == "active-finalization" and .phase == "active-commit-authorized" and
      .revision == $revision and .runId == $runId and
      .terminalEvidenceSha256 == $terminalEvidenceSha256 and
      .app == {containerId: $appContainerId, imageId: $appImageId} and
      .router == {containerId: $routerContainerId, imageId: $routerImageId}
    ' "$active_finalization_marker" >/dev/null || return 1
  rm -- "$active_finalization_marker" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  active_finalization_marker_committed="false"
}

recover_pre_mutation_release() {
  local router_query="" router_state="" health_body="" recovered_at="" app_state="" worker_state=""
  local public_ready="false" maintenance_restore_status=0
  [[ "$mode" == "release" && "$database_mutation_started" != "true" \
    && "$previous_app_was_running" == "true" \
    && "$previous_container" =~ ^[a-f0-9]{12,64}$ \
    && ( "$write_surfaces_stopped" == "true" \
      || "$write_surface_containment_armed" == "true" \
      || "$router_maintenance_confirmed" == "true" ) ]] || return 1

  if [[ "$router_was_preexisting" == "true" ]]; then
    resolve_release_router_container
    [[ -n "$release_router_container_id" ]] || return 1
    docker start "$previous_container" >/dev/null 2>&1 || return 1
  else
    # The first router rollout may fail after the legacy app released the
    # loopback port. Remove only that candidate router, then restart the exact
    # pre-cutover container with its original port and edge-alias contract.
    router_query="$(compose ps --all --quiet release_router 2>/dev/null)" || return 1
    if [[ -n "$router_query" ]]; then
      [[ "$router_query" =~ ^[a-f0-9]{12,64}$ ]] \
        || return 1
      docker rm --force "$router_query" >/dev/null 2>&1 || return 1
    fi
    [[ "$(docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null)" \
      == "$previous_app_id" \
      && "$(docker inspect --format '{{.State.Running}}' "$previous_container" 2>/dev/null)" \
      == false ]] || return 1
    if [[ "$(docker inspect --format \
      '{{if index .NetworkSettings.Networks "business_finlynq_edge"}}attached{{end}}' \
      "$previous_container" 2>/dev/null)" == "" ]]; then
      docker network connect --alias production-app \
        business_finlynq_edge "$previous_container" >/dev/null 2>&1 || return 1
    fi
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_edge production-app "$previous_container" || return 1
    docker start "$previous_container" >/dev/null 2>&1 || return 1
  fi

  # Account-enabled readiness depends on a fresh authentication-worker
  # heartbeat. Restore and attest that exact pre-cutover container before
  # waiting for public readiness, otherwise recovery can deadlock on the gate
  # that only the stopped worker can satisfy.
  if [[ "$previous_auth_worker_was_running" == "true" ]]; then
    docker start "$previous_auth_worker_container" >/dev/null 2>&1 || return 1
    worker_state="$(docker inspect --format \
      '{{.State.Running}}|{{.Image}}|{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
      "$previous_auth_worker_container" 2>/dev/null)" || return 1
    [[ "$worker_state" == "true|$previous_auth_worker_image_id|$previous_auth_worker_revision" ]] \
      || return 1
  fi

  # Restore and health-check the exact accepted upstream before returning a
  # stopped router to active service. The app healthcheck can itself depend on
  # the worker heartbeat, so both containers must be running first.
  for _ in {1..60}; do
    app_state="$(docker inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$previous_container" 2>/dev/null)" || return 1
    [[ "$app_state" == true\|healthy ]] && break
    sleep 2
  done
  [[ "$app_state" == true\|healthy ]] || return 1

  if [[ "$router_was_preexisting" == "true" ]]; then
    [[ "$(docker inspect --format '{{.State.Running}}' \
      "$release_router_container_id" 2>/dev/null)" == true ]] \
      || docker start "$release_router_container_id" >/dev/null 2>&1 || return 1
    for _ in {1..30}; do
      router_state="$(docker inspect --format \
        '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$release_router_container_id" 2>/dev/null)" || return 1
      [[ "$router_state" == true\|healthy ]] && break
      sleep 1
    done
    [[ "$router_state" == true\|healthy ]] || return 1
    # Keep the restart contract fail-closed while briefly exposing the exact
    # previous release for its public recovery proof. A failed proof explicitly
    # reloads maintenance; only a successful proof may persist active.
    persist_release_router_mode maintenance >/dev/null 2>&1 || return 1
    reload_release_router_configuration Caddyfile >/dev/null 2>&1 || return 1
  fi

  for _ in {1..60}; do
    health_body=""
    if ! app_state="$(docker inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$previous_container" 2>/dev/null)"; then
      app_state=""
    fi
    if [[ "$app_state" == true\|healthy ]] \
      && health_body="$(curl --fail --silent --show-error --max-time 5 \
        "$public_base_url/api/health" 2>/dev/null)" \
      && jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
        <<<"$health_body" >/dev/null; then
      public_ready="true"
      break
    fi
    sleep 2
  done
  if [[ "$public_ready" != true ]]; then
    if [[ "$router_was_preexisting" == "true" ]]; then
      maintenance_restore_status=0
      persist_release_router_mode maintenance >/dev/null 2>&1 \
        || maintenance_restore_status=1
      reload_release_router_configuration Caddyfile.maintenance >/dev/null 2>&1 \
        || maintenance_restore_status=1
      if (( maintenance_restore_status == 0 )); then
        router_active_confirmed="false"
        router_maintenance_confirmed="true"
      fi
    fi
    return 1
  fi

  if [[ "$router_was_preexisting" != true ]]; then
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_edge production-app "$previous_container" || return 1
    previous_app_public_edge_detached="false"
  fi

  if [[ "$router_was_preexisting" == "true" ]]; then
    if ! persist_release_router_mode active >/dev/null 2>&1; then
      maintenance_restore_status=0
      persist_release_router_mode maintenance >/dev/null 2>&1 \
        || maintenance_restore_status=1
      reload_release_router_configuration Caddyfile.maintenance >/dev/null 2>&1 \
        || maintenance_restore_status=1
      if (( maintenance_restore_status == 0 )); then
        router_active_confirmed="false"
        router_maintenance_confirmed="true"
      fi
      return 1
    fi
    router_active_confirmed="true"
    router_maintenance_confirmed="false"
  fi

  recovered_at="$(checked_utc_timestamp)" || return 1
  jq -n --arg at "$recovered_at" --arg appContainerId "$previous_container" \
    --arg appImageId "$previous_app_id" --arg revision "$previous_app_revision" \
    --arg routerPreserved "$router_was_preexisting" \
    '{schemaVersion: 1, product: "business-finlynq", recoveredAt: $at,
      result: "pre-mutation-availability-restored", appContainerId: $appContainerId,
      appImageId: $appImageId, revision: $revision,
      stableRouterPreserved: ($routerPreserved == "true"), databaseMutationStarted: false,
      schedulersRemainPaused: true}' \
    >"$evidence_directory/97-pre-mutation-auto-recovery.json" || return 1
  chmod 0600 -- "$evidence_directory/97-pre-mutation-auto-recovery.json" || return 1
  if [[ "${first_router_recovery_journal_committed:-false}" == true ]]; then
    clear_first_router_recovery_journal || return 1
  fi
}

contain_project_services_on_failure() {
  local service_name query container_id contract running observed_project observed_service
  local containment_status=0
  for service_name in "$@"; do
    if ! query="$(docker ps --all --quiet --no-trunc \
      --filter "label=com.docker.compose.project=$compose_project" \
      --filter "label=com.docker.compose.service=$service_name" 2>/dev/null)"; then
      containment_status=1
      continue
    fi
    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] && continue
      if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
        containment_status=1
        continue
      fi
      contract="$(docker inspect --format \
        '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{.State.Running}}' \
        "$container_id" 2>/dev/null)" || {
          containment_status=1
          continue
        }
      IFS='|' read -r observed_project observed_service running <<<"$contract"
      if [[ "$observed_project" != "$compose_project" \
        || "$observed_service" != "$service_name" ]]; then
        containment_status=1
        continue
      fi
      if [[ "$running" == true ]]; then
        docker stop --time 30 "$container_id" >/dev/null 2>&1 || true
      fi
      running="$(docker inspect --format '{{.State.Running}}' \
        "$container_id" 2>/dev/null)" || {
          containment_status=1
          continue
        }
      if [[ "$running" == true ]]; then
        docker kill "$container_id" >/dev/null 2>&1 || true
        running="$(docker inspect --format '{{.State.Running}}' \
          "$container_id" 2>/dev/null)" || {
            containment_status=1
            continue
          }
      fi
      [[ "$running" == false ]] || containment_status=1
    done <<<"$query"
  done
  return "$containment_status"
}

network_alias_has_exact_owner_nonfatal() {
  local network="$1" alias="$2" expected_container="$3"
  local expected_full_id network_query container networks owner_count=0
  expected_full_id="$(docker inspect --format '{{.Id}}' "$expected_container" 2>/dev/null)" \
    || return 1
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}' 2>/dev/null)" || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container" 2>/dev/null)" || return 1
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
      [[ "$container" == "$expected_full_id" ]] || return 1
    fi
  done <<<"$network_query"
  [[ "$owner_count" == 1 ]]
}

stop_public_alias_owners_during_failure() {
  local network_query container networks running remaining owner_count=0 result=0
  local identity project service
  network_query="$(docker ps --all --no-trunc \
    --filter network=business_finlynq_edge --format '{{.ID}}' 2>/dev/null)" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || { result=1; continue; }
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container" 2>/dev/null)" || { result=1; continue; }
    if jq -e '
      has("business_finlynq_edge") and
      any(.business_finlynq_edge.Aliases[]?; . == "production-app")
    ' <<<"$networks" >/dev/null; then
      identity="$(docker inspect --format \
        '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
        "$container" 2>/dev/null)" || { result=1; continue; }
      IFS='|' read -r project service <<<"$identity"
      if [[ "$project" != business-finlynq \
        || ( "$service" != app && "$service" != release_router ) ]]; then
        result=1
        continue
      fi
      running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
        || { result=1; continue; }
      if [[ "$running" == true ]]; then
        docker stop --time 30 "$container" >/dev/null 2>&1 || true
        running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
          || { result=1; continue; }
      fi
      [[ "$running" == false ]] || result=1
    fi
  done <<<"$network_query"
  remaining="$(docker ps --no-trunc \
    --filter network=business_finlynq_edge --format '{{.ID}}' 2>/dev/null)" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container" 2>/dev/null)" || return 1
    if jq -e '
      has("business_finlynq_edge") and
      any(.business_finlynq_edge.Aliases[]?; . == "production-app")
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
    fi
  done <<<"$remaining"
  [[ "$result" == 0 && "$owner_count" == 0 ]]
}

force_router_maintenance_during_failure() {
  local query token status body running image_id router_contract
  query="$(docker ps --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter 'label=com.docker.compose.service=release_router' 2>/dev/null)" \
    || return 1
  [[ "$query" =~ ^[a-f0-9]{64}$ && "$query" != *$'\n'* ]] || return 1
  router_contract="$(docker inspect --format \
    '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ index .Config.Labels "com.business-finlynq.release-router.contract" }}' \
    "$query" 2>/dev/null)" || return 1
  [[ "$router_contract" == "$compose_project|release_router|$release_router_revision|$release_router_contract" ]] \
    || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$query" 2>/dev/null)" || return 1
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  token="$release_acceptance_token"
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || token="$(openssl rand -hex 32 2>/dev/null)" \
    || return 1
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$query" 2>/dev/null)" \
    || return 1
  if [[ "$running" != true ]]; then
    # A stopped listener is already fail-closed. Update its non-secret state
    # volume offline so a later daemon/container restart also chooses
    # maintenance, without briefly starting the active configuration here.
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
      --volumes-from "$query" --entrypoint sh "$image_id" -ec '
        set -eu
        [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
        temporary="/state/.mode.$$"
        trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
        printf "maintenance\n" >"$temporary"
        chmod 0600 "$temporary"
        mv -f "$temporary" /state/mode
        sync /state/mode 2>/dev/null || sync
        sync -f /state 2>/dev/null || sync
        trap - EXIT INT TERM
      ' >/dev/null 2>&1 || return 1
    network_alias_has_exact_owner_nonfatal \
      business_finlynq_edge production-app "$query" || return 1
    router_maintenance_confirmed="true"
    router_active_confirmed="false"
    return 0
  fi
  docker exec "$query" sh -ec '
    set -eu
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    temporary="/state/.mode.$$"
    trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
    printf "maintenance\n" >"$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" /state/mode
    sync /state/mode 2>/dev/null || sync
    sync -f /state 2>/dev/null || sync
    trap - EXIT INT TERM
  ' >/dev/null 2>&1 || return 1
  docker exec --env "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$token" \
    "$query" caddy reload --config /etc/caddy/Caddyfile.maintenance \
    --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 \
    || return 1
  status="$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' "$public_base_url/api/health" 2>/dev/null)" \
    || return 1
  [[ "$status" == 503 ]] || return 1
  body="$(curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$app_port/_business-finlynq/release-router/live" 2>/dev/null)" \
    || return 1
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$body" >/dev/null || return 1
  network_alias_has_exact_owner_nonfatal \
    business_finlynq_edge production-app "$query" || return 1
  release_acceptance_token="$token"
  router_maintenance_confirmed="true"
  router_active_confirmed="false"
}

on_exit() {
  local status=$? failure_at="" failure_record_temporary=""
  local failure_record_published="false"
  trap - EXIT ERR
  trap '' HUP INT TERM
  if (( status != 0 )); then
    if [[ "$router_transition_attempted" == "true" \
      && -n "$public_base_url" && -n "$app_port" \
      && ( "$mode" != release || "$terminal_evidence_committed" != true ) ]]; then
      if ! force_router_maintenance_during_failure; then
        router_query="$(docker ps --all --quiet --no-trunc \
          --filter "label=com.docker.compose.project=$compose_project" \
          --filter 'label=com.docker.compose.service=release_router' 2>/dev/null || true)"
        if [[ "$router_query" =~ ^[a-f0-9]{64}$ && "$router_query" != *$'\n'* ]]; then
          docker stop --time 30 "$router_query" >/dev/null 2>&1 || true
        fi
        if ! stop_public_alias_owners_during_failure; then
          printf '%s\n' \
            "URGENT: failed release could not stop every running production-app alias owner." >&2
        fi
        printf '%s\n' \
          "URGENT: failed release could not prove router maintenance; the scoped router was stopped fail-closed." >&2
      fi
    fi
    if [[ "$mode" == "release" && "$terminal_evidence_committed" != true \
      && "$scheduler_pause_attempted" == "true" \
      && "$schedulers_paused" != "true" ]]; then
      if pause_schedulers allow-already-paused >/dev/null 2>&1; then
        schedulers_paused="true"
      else
        schedulers_paused="false"
        printf '%s\n' \
          "URGENT: release failure occurred during scheduler pause and containment retry failed." >&2
      fi
    fi
    if [[ "$mode" == "release" && "$terminal_evidence_committed" != true \
      && "$schedulers_resumed" == "true" ]]; then
      if pause_schedulers allow-already-paused >/dev/null 2>&1; then
        schedulers_paused="true"
      else
        schedulers_paused="false"
        printf '%s\n' "URGENT: release failure occurred after scheduler resume and automatic re-pause failed." >&2
      fi
      schedulers_resumed="false"
    fi
    if [[ "$mode" == "initial" && "$initial_schedule_installed" == "true" ]]; then
      if contain_initial_schedule_on_failure; then
        initial_schedulers_verified="true"
      else
        initial_schedulers_verified="false"
        printf '%s\n' \
          "URGENT: initial-production failure could not prove all scheduled timers disabled." >&2
      fi
    fi
    if [[ "$detached_mutator_containment_armed" == "true" ]]; then
      if ! contain_project_services_on_failure "${detached_mutator_services[@]}"; then
        printf '%s\n' \
          "URGENT: failed release could not prove detached database mutators quiescent." >&2
      fi
    fi
    if [[ "$terminal_evidence_committed" != "true" \
      && ( "$write_surface_containment_armed" == "true" \
        || "$candidate_started" == "true" ) ]]; then
      if ! contain_project_services_on_failure app auth_email_worker; then
        printf '%s\n' \
          "URGENT: failed release could not prove application write surfaces quiescent." >&2
      fi
    fi
    if [[ "$mode" == "release" && "$database_mutation_started" != "true" \
      && ( "$write_surfaces_stopped" == "true" \
        || "$write_surface_containment_armed" == "true" \
        || "$router_maintenance_confirmed" == "true" ) ]]; then
      if recover_pre_mutation_release; then
        write_surface_containment_armed="false"
        printf '%s\n' \
          "The exact pre-cutover application was automatically restored; schedulers remain paused." >&2
      else
        printf '%s\n' \
          "URGENT: pre-mutation availability could not be restored automatically." >&2
      fi
    fi
    if [[ "$candidate_started" == "true" \
      && "$terminal_evidence_committed" != "true" ]]; then
      if [[ "$mode" == "release" ]]; then
        if restore_stopped_previous_app_anchor; then
          printf '%s\n' "Stopped previous-application rollback anchor restored for a safe retry." >&2
        else
          printf '%s\n' "URGENT: failed to restore the stopped previous-application rollback anchor." >&2
        fi
      fi
    fi
    if [[ "$terminal_evidence_committed" == "true" ]]; then
      printf '%s\n' \
        "Accepted candidate evidence and active-finalization authorization are durable; the exact candidate is eligible for strict active-last recovery." >&2
    fi
    if failure_at="$(checked_utc_timestamp)"; then
      failure_record_temporary="$evidence_directory/.99-failure.json.partial"
      if [[ -e "$failure_record_temporary" || -L "$failure_record_temporary" \
        || -e "$evidence_directory/99-failure.json" \
        || -L "$evidence_directory/99-failure.json" ]]; then
        printf '%s\n' \
          "URGENT: failed release evidence path already exists; this run is not resumable." >&2
      elif jq -n \
        --arg at "$failure_at" \
        --arg mode "$mode" \
        --arg revision "$revision" \
        --arg runId "$run_id" \
        --arg stage "$stage" \
        --argjson exitCode "$status" \
        --arg schedulersPaused "$schedulers_paused" \
        --arg initialTimersDisabled "$initial_schedulers_verified" \
        --arg routerMaintenanceConfirmed "$router_maintenance_confirmed" \
        '{schemaVersion: 1, product: "business-finlynq", status: "failed", failedAt: $at, mode: $mode, revision: $revision, runId: $runId, stage: $stage, exitCode: $exitCode, schedulersRemainPaused: ($schedulersPaused == "true"), releaseRouterMaintenanceConfirmed: ($routerMaintenanceConfirmed == "true"), initialTimersRemainDisabled: (if $mode == "initial" then ($initialTimersDisabled == "true") else null end)}' \
        >"$failure_record_temporary" 2>/dev/null \
        && chmod 0600 -- "$failure_record_temporary" 2>/dev/null \
        && mv -- "$failure_record_temporary" \
          "$evidence_directory/99-failure.json" 2>/dev/null; then
        failure_record_published="true"
      else
        rm -f -- "$failure_record_temporary" >/dev/null 2>&1 || true
        printf '%s\n' \
          "URGENT: failed release record could not be published atomically; this run is not resumable." >&2
      fi
    else
      printf '%s\n' \
        "URGENT: failed release timestamp could not be generated; this run is not resumable." >&2
    fi
    if [[ -e "$evidence_directory/.90-release-complete.json.partial" \
      || -L "$evidence_directory/.90-release-complete.json.partial" ]]; then
      if [[ -f "$evidence_directory/.90-release-complete.json.partial" \
        && ! -L "$evidence_directory/.90-release-complete.json.partial" \
        && "$(stat -c '%u:%a:%h' -- \
          "$evidence_directory/.90-release-complete.json.partial" 2>/dev/null)" \
          == 0:600:1 ]]; then
        rm -- "$evidence_directory/.90-release-complete.json.partial" \
          >/dev/null 2>&1 || printf '%s\n' \
          "URGENT: incomplete terminal-evidence staging file could not be removed." >&2
      else
        printf '%s\n' \
          "URGENT: unsafe terminal-evidence staging path remains in the evidence directory." >&2
      fi
    fi
    capture_rehearsal_database_failure || true
    rehearsal_cleanup
    if ! refresh_checksums || ! sync_evidence_inventory; then
      printf '%s\n' \
        "URGENT: failed release evidence could not be checksummed and durably synchronized; do not use it for resume." >&2
    fi
    if [[ "$failure_record_published" != "true" ]]; then
      printf '%s\n' \
        "URGENT: no durable failure record exists; do not use this evidence for resume." >&2
    fi
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
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$scheduler_boundary_bootstrap_required" == "true" ]]; then
  install -m 0600 -- "$scheduler_boundary_bootstrap_receipt" \
    "$evidence_directory/05-scheduler-boundary-bootstrap.json"
  retained_scheduler_receipt_sha256="$(checked_file_sha256 \
    "$evidence_directory/05-scheduler-boundary-bootstrap.json")" \
    || fail "retained scheduler-boundary bootstrap receipt could not be hashed"
  [[ "$retained_scheduler_receipt_sha256" \
    == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
    || fail "retained scheduler-boundary bootstrap receipt differs from the protected source"
fi

stage="materialize-candidate-git-tree"
candidate_staging_root="$(mktemp -d /tmp/business-finlynq-release.XXXXXX)"
chmod 0700 -- "$candidate_staging_root"
candidate_source_root="$candidate_staging_root/repository"
mkdir -m 0700 -- "$candidate_source_root"
candidate_git_tree_file="$candidate_staging_root/candidate-git-tree.txt"
if ! git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  ls-tree -r --full-tree "$revision" >"$candidate_git_tree_file"; then
  fail "candidate Git tree could not be inspected before materialization"
fi
if awk '$1 == "160000" { found = 1 } END { exit found ? 0 : 1 }' "$candidate_git_tree_file"; then
  fail "candidate contains a Git submodule that cannot be materialized by the release archive"
fi
git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  archive --format=tar "$revision" \
  | tar --extract --file=- --directory="$candidate_source_root" --no-same-owner --same-permissions
read_git_output "$repository_root" "candidate Git tree" rev-parse "$revision^{tree}"
candidate_tree_id="$git_command_output"
[[ "$candidate_tree_id" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || fail "candidate Git tree ID is invalid"
read_git_output "$repository_root" "candidate commit timestamp" show -s --format=%ct "$revision"
candidate_source_date_epoch="$git_command_output"
[[ "$candidate_source_date_epoch" =~ ^[1-9][0-9]{0,11}$ ]] \
  || fail "candidate commit timestamp is invalid"
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
environment_snapshot_sha256="$(checked_file_sha256 "$environment_snapshot_file")" \
  || fail "private Compose environment snapshot could not be hashed"
[[ "$environment_snapshot_sha256" == "$compose_environment_sha256" ]] \
  || fail "private Compose environment snapshot differs from its validated source"
environment_file="$environment_snapshot_file"
if [[ "$mode" != "rehearsal" ]]; then
  operations_environment_snapshot_file="$(mktemp)"
  install -m 0600 -- "$canonical_operations_environment_file" "$operations_environment_snapshot_file"
  operations_environment_snapshot_sha256="$(checked_file_sha256 \
    "$operations_environment_snapshot_file")" \
    || fail "private operations environment snapshot could not be hashed"
  [[ "$operations_environment_snapshot_sha256" == "$operations_environment_sha256" ]] \
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
  "release_router:$release_router_reference" \
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

app_port="$(jq -r '.services.release_router.ports[] | select(.target == 3000) | .published' <<<"$rendered_compose")"
[[ "$app_port" =~ ^[0-9]+$ && "$app_port" -ge 1024 && "$app_port" -le 65535 ]] || fail "rendered app port is invalid"
[[ "$(jq -r '[.services.app.ports[]? | select(.target == 3000)] | length' <<<"$rendered_compose")" == "0" ]] \
  || fail "application container must not publish the release listener"
router_frontend_network_name="$(jq -r '.networks.business_finlynq_frontend.name // empty' <<<"$rendered_compose")"
router_control_network_name="$(jq -r '.networks.business_finlynq_router_control.name // empty' <<<"$rendered_compose")"
router_edge_network_name="$(jq -r '.networks.business_finlynq_edge.name // empty' <<<"$rendered_compose")"
router_public_alias="$(jq -r '.services.release_router.networks.business_finlynq_edge.aliases[0] // empty' <<<"$rendered_compose")"
router_state_volume_name="$(jq -r '.volumes.business_finlynq_release_router_state.name // empty' <<<"$rendered_compose")"
[[ -n "$router_frontend_network_name" && -n "$router_control_network_name" \
  && -n "$router_edge_network_name" \
  && "$router_public_alias" =~ ^[a-z0-9][a-z0-9-]{2,62}$ \
  && "$router_state_volume_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$ ]] \
  || fail "release-router network identity is incomplete"
[[ "$(jq -r '.services.app.networks.business_finlynq_frontend.aliases[0] // empty' <<<"$rendered_compose")" == "release-app" ]] \
  || fail "application does not use the reviewed internal release-router alias"
app_origin="$(jq -r '.services.app.environment.APP_ORIGIN // empty' <<<"$rendered_compose")"
session_cookie_name="$(jq -r '.services.app.environment.SESSION_COOKIE_NAME // empty' <<<"$rendered_compose")"
public_base_url=""

for gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED AUTH_OIDC_ENABLED AUTH_OIDC_SIGNUP_ENABLED \
  ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED SIGNUP_TURNSTILE_ENABLED \
  BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED YAHOO_FX_ENABLED; do
  gate_value="$(jq -r --arg gate "$gate" '.services.app.environment[$gate] // empty' <<<"$rendered_compose")"
  [[ "$gate_value" == "true" || "$gate_value" == "false" ]] || fail "app gate $gate is not an explicit boolean"
  printf -v "release_$gate" '%s' "$gate_value"
done

backup_directory="$(jq -r '.services.backup.volumes[] | select(.target == "/backups") | .source' <<<"$rendered_compose")"
verify_backup_directory="$(jq -r '.services.verify_latest_backup.volumes[] | select(.target == "/backups") | .source' <<<"$rendered_compose")"
scanner_image_reference="$(jq -r '.services.evidence_scanner.image // empty' <<<"$rendered_compose")"
[[ "$scanner_image_reference" =~ ^clamav/clamav@sha256:[a-f0-9]{64}$ ]] \
  || fail "evidence scanner is not pinned to the reviewed ClamAV digest"
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

read_compose_value() {
  local key="$1" count value
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "Compose environment key is invalid"
  count="$(awk -F= -v selected="$key" '$1 == selected { count++ } END { print count + 0 }' \
    "$canonical_environment_file")"
  [[ "$count" == 1 ]] || fail "Compose environment must define $key exactly once"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' \
    "$canonical_environment_file")"
  [[ -n "$value" ]] || fail "Compose environment contains an empty $key"
  printf '%s' "$value"
}

if [[ "$mode" != "rehearsal" ]]; then
  if [[ "$mode" == "initial" ]]; then
    for initial_resource_contract in \
      "BUSINESS_FINLYNQ_PGDATA_VOLUME:business_finlynq_pgdata" \
      "BUSINESS_FINLYNQ_PRIVATE_NETWORK:business_finlynq_private" \
      "BUSINESS_FINLYNQ_EGRESS_NETWORK:business_finlynq_egress" \
      "BUSINESS_FINLYNQ_EDGE_NETWORK:business_finlynq_edge" \
      "BUSINESS_FINLYNQ_RESTORE_DRILL_NETWORK:business_finlynq_restore_drill"; do
      initial_resource_key="${initial_resource_contract%%:*}"
      initial_resource_name="${initial_resource_contract#*:}"
      [[ "$(read_compose_value "$initial_resource_key")" == "$initial_resource_name" ]] \
        || fail "initial production Compose environment does not use the canonical $initial_resource_key"
    done
  fi
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
  MONITOR_EDGE_MODE="$(read_operations_value MONITOR_EDGE_MODE)"
  [[ "$MONITOR_EDGE_MODE" == external ]] \
    || fail "production monitoring must follow shared-edge contract v1"
  MONITOR_EXTERNAL_EDGE_PROJECT="$(read_operations_value MONITOR_EXTERNAL_EDGE_PROJECT)"
  MONITOR_EXTERNAL_EDGE_SERVICE="$(read_operations_value MONITOR_EXTERNAL_EDGE_SERVICE)"
  MONITOR_EXTERNAL_EDGE_NETWORK="$(read_operations_value MONITOR_EXTERNAL_EDGE_NETWORK)"
  MONITOR_EXPECT_AUTH_EMAIL_WORKER="$(read_operations_value MONITOR_EXPECT_AUTH_EMAIL_WORKER)"
  MONITOR_EXPECT_OUTBOX_PUBLISHER="$(read_operations_value MONITOR_EXPECT_OUTBOX_PUBLISHER)"
  MONITOR_REQUIRE_OFFSITE="$(read_operations_value MONITOR_REQUIRE_OFFSITE)"
  MONITOR_EXPECT_SCHEDULERS_ACTIVE="$(read_operations_value MONITOR_EXPECT_SCHEDULERS_ACTIVE)"
  MONITOR_EXPECT_DEMO_MAINTENANCE="$(read_operations_value MONITOR_EXPECT_DEMO_MAINTENANCE)"
  export BUSINESS_FINLYNQ_IMAGE_REVISION MONITOR_EXPECT_REVISION MONITOR_MAINTENANCE_SCHEDULER \
    MONITOR_BASE_URL MONITOR_HOSTNAME MONITOR_BACKUP_DIR MONITOR_MAX_BACKUP_AGE_HOURS \
    SCHEDULED_BACKUP_TIMEOUT_SECONDS \
    MONITOR_MAX_BACKUP_ACTIVE_SECONDS MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS \
    ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS MONITOR_MIN_TLS_DAYS \
    MONITOR_MAX_DISK_PERCENT MONITOR_EXPECT_EDGE MONITOR_EDGE_MODE \
    MONITOR_EXTERNAL_EDGE_PROJECT MONITOR_EXTERNAL_EDGE_SERVICE MONITOR_EXTERNAL_EDGE_NETWORK \
    MONITOR_EXPECT_AUTH_EMAIL_WORKER \
    MONITOR_EXPECT_OUTBOX_PUBLISHER MONITOR_REQUIRE_OFFSITE \
    MONITOR_EXPECT_SCHEDULERS_ACTIVE \
    MONITOR_EXPECT_DEMO_MAINTENANCE
  for explicit_boolean in MONITOR_EXPECT_EDGE MONITOR_EXPECT_AUTH_EMAIL_WORKER \
    MONITOR_EXPECT_OUTBOX_PUBLISHER MONITOR_REQUIRE_OFFSITE \
    MONITOR_EXPECT_SCHEDULERS_ACTIVE MONITOR_EXPECT_DEMO_MAINTENANCE; do
    [[ "${!explicit_boolean}" == "true" || "${!explicit_boolean}" == "false" ]] \
      || fail "$explicit_boolean must be explicitly true or false in the canonical operations environment"
  done
  for explicit_number in MONITOR_MAX_BACKUP_AGE_HOURS SCHEDULED_BACKUP_TIMEOUT_SECONDS \
    MONITOR_MAX_BACKUP_ACTIVE_SECONDS \
    MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS \
    MONITOR_MIN_TLS_DAYS MONITOR_MAX_DISK_PERCENT; do
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
  release_online_backup_timeout_seconds="$release_backup_timeout_seconds"
  (( release_online_backup_timeout_seconds <= 900 )) \
    || release_online_backup_timeout_seconds=900
  release_quiesced_backup_timeout_seconds="$release_backup_timeout_seconds"
  (( release_quiesced_backup_timeout_seconds <= 300 )) \
    || release_quiesced_backup_timeout_seconds=300
  [[ "$MONITOR_BASE_URL" =~ ^https:// ]] || fail "production monitor base URL must use HTTPS"
  [[ "$MONITOR_EXPECT_EDGE" == "true" ]] || fail "the production release requires the reviewed edge boundary"
  [[ "$MONITOR_EDGE_MODE" == external ]] \
    || fail "MONITOR_EDGE_MODE must follow shared-edge contract v1"
  [[ "$MONITOR_EDGE_MODE" == "$edge_mode" ]] \
    || fail "monitor and Compose edge modes differ"
  if [[ "$edge_mode" == external ]]; then
    [[ "$MONITOR_EXTERNAL_EDGE_PROJECT" == "$(read_compose_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT)" \
      && "$MONITOR_EXTERNAL_EDGE_SERVICE" == "$(read_compose_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE)" \
      && "$MONITOR_EXTERNAL_EDGE_NETWORK" == "$(read_compose_value BUSINESS_FINLYNQ_EDGE_NETWORK)" ]] \
      || fail "monitor external-edge identity differs from the Compose contract"
  fi
  if [[ "$mode" == "release" ]]; then
    [[ "$MONITOR_REQUIRE_OFFSITE" == "true" ]] \
      || fail "production release requires off-site backup verification"
    [[ "$MONITOR_EXPECT_SCHEDULERS_ACTIVE" == "true" ]] \
      || fail "production release requires active scheduled operations"
  else
    [[ "$edge_mode" == "external" ]] \
      || fail "initial production requires the externally managed edge contract"
    [[ "$MONITOR_REQUIRE_OFFSITE" == "false" ]] \
      || fail "initial production must explicitly defer off-site backup verification"
    [[ "$MONITOR_EXPECT_SCHEDULERS_ACTIVE" == "false" ]] \
      || fail "initial production must leave every scheduled timer disabled"
    [[ "$release_DEMO_LOGIN_ENABLED" == "true" \
      && "$release_DEMO_WRITES_ENABLED" == "true" \
      && "$release_ACCOUNT_LOGIN_ENABLED" == "false" \
      && "$release_AUTH_OIDC_ENABLED" == "false" \
      && "$release_AUTH_OIDC_SIGNUP_ENABLED" == "false" \
      && "$release_ACCOUNT_SIGNUP_ENABLED" == "false" \
      && "$release_AUTH_EMAIL_DELIVERY_ENABLED" == "false" \
      && "$release_SIGNUP_TURNSTILE_ENABLED" == "false" \
      && "$release_BUSINESS_WRITES_ENABLED" == "false" \
      && "$release_BANK_FEEDS_ENABLED" == "false" \
      && "$release_YAHOO_FX_ENABLED" == "false" ]] \
      || fail "initial production requires the contained synthetic-demo gate posture"
    [[ "$(jq -r '.services.backup.environment.BACKUP_REQUIRE_OFFSITE // empty' \
      <<<"$rendered_compose")" == "false" ]] \
      || fail "initial production backup must explicitly disable off-site delivery"
    [[ "$(jq -r '.services.verify_latest_backup.environment.BACKUP_REQUIRE_OFFSITE_MARKER // empty' \
      <<<"$rendered_compose")" == "false" ]] \
      || fail "initial production backup verification must explicitly defer the off-site marker"
    jq -e '
      .volumes.business_finlynq_pgdata.name == "business_finlynq_pgdata" and
      .volumes.business_finlynq_clamav.name == "business_finlynq_pgdata_clamav" and
      .networks.business_finlynq_private.name == "business_finlynq_private" and
      .networks.business_finlynq_evidence.name == "business_finlynq_private_evidence" and
      .networks.business_finlynq_egress.name == "business_finlynq_egress" and
      .networks.business_finlynq_scanner_egress.name == "business_finlynq_egress_scanner" and
      .networks.business_finlynq_edge.name == "business_finlynq_edge" and
      .networks.business_finlynq_edge.external == true
    ' <<<"$rendered_compose" >/dev/null \
      || fail "initial production must use the canonical production resource names"
    if ! initial_restore_compose="$(compose --profile operations --profile auth-email \
      --profile acceptance --profile restore-drill config --format json)"; then
      fail "initial production restore-drill Compose configuration could not be rendered"
    fi
    jq -e '
      .networks.business_finlynq_restore_drill.name == "business_finlynq_restore_drill" and
      .networks.business_finlynq_restore_drill.internal == true
    ' <<<"$initial_restore_compose" >/dev/null \
      || fail "initial production must use the canonical restore-drill network"
    if ! initial_secret_sources="$(jq -r '.secrets[]?.file // empty' \
      <<<"$initial_restore_compose" | sort -u)"; then
      fail "initial secret-source inventory could not be rendered"
    fi
    [[ -n "$initial_secret_sources" ]] \
      || fail "initial secret-source inventory is empty"
    while IFS= read -r secret_source; do
      [[ "$secret_source" == /* ]] \
        || fail "initial production secret sources must use durable absolute host paths"
      reject_repository_path "$secret_source" "initial production secret source"
    done <<<"$initial_secret_sources"
    initial_disabled_secret_source="$(jq -r '
      [
        .secrets.business_finlynq_document_google_secret.file,
        .secrets.business_finlynq_document_microsoft_secret.file,
        .secrets.business_finlynq_oidc_client_secret.file,
        .secrets.business_finlynq_oidc_identity_map.file,
        .secrets.business_finlynq_resend_api_key.file,
        .secrets.business_finlynq_turnstile_secret_key.file,
        .secrets.business_finlynq_rclone_config.file,
        .secrets.business_finlynq_backup_receiver_ssh_private_key.file,
        .secrets.business_finlynq_backup_receiver_known_hosts.file,
        .secrets.business_finlynq_backup_receiver_receipt_public_key.file,
        .secrets.business_finlynq_backup_age_identity.file,
        .secrets.business_finlynq_restore_db_password.file
      ] | unique | if length == 1 then .[0] else "" end
    ' <<<"$initial_restore_compose")" \
      || fail "disabled initial secret-source contract could not be read"
    [[ -n "$initial_disabled_secret_source" \
      && -f "$initial_disabled_secret_source" && ! -L "$initial_disabled_secret_source" \
      && ! -s "$initial_disabled_secret_source" ]] \
      || fail "disabled initial providers and recovery inputs must share one durable empty placeholder"
    unset initial_restore_compose
    for required_secret in business_finlynq_app_db_password \
      business_finlynq_root_kek business_finlynq_identity_secret \
      business_finlynq_auth_worker_db_password business_finlynq_backup_db_password \
      business_finlynq_backup_age_recipient; do
      required_secret_source="$(jq -r --arg secret "$required_secret" \
        '.secrets[$secret].file // empty' <<<"$rendered_compose")" \
        || fail "required initial secret source could not be read: $required_secret"
      [[ -n "$required_secret_source" && -f "$required_secret_source" \
        && ! -L "$required_secret_source" && -s "$required_secret_source" ]] \
        || fail "required initial secret material is unavailable: $required_secret"
    done
  fi
  [[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "$release_ACCOUNT_LOGIN_ENABLED" ]] \
    || fail "auth-worker monitor expectation must match the account-login gate"
  [[ "$MONITOR_BACKUP_DIR" == "$backup_directory" ]] || fail "operations monitor and Compose backup directory differ"
  [[ "$app_port" == "3100" ]] || fail "production app listener must remain on loopback port 3100"
  [[ "$app_origin" == "$MONITOR_BASE_URL" ]] || fail "production APP_ORIGIN must exactly match the monitored HTTPS origin"
  [[ "$session_cookie_name" == "__Host-business_finlynq_session" ]] \
    || fail "production release requires the host-only secure session cookie"
  public_base_url="$MONITOR_BASE_URL"
else
  rehearsal_resources="$(jq -r '.volumes[].name, .networks[].name' <<<"$rendered_compose")"
  [[ -n "$rehearsal_resources" ]] || fail "rehearsal resource names are missing"
  while IFS= read -r resource_name; do
    [[ "$resource_name" == "$compose_project"-* ]] \
      || fail "rehearsal resource can escape its isolated project: $resource_name"
    case "$resource_name" in
      business_finlynq_pgdata|business_finlynq_private|business_finlynq_egress|business_finlynq_edge|business_finlynq_development_edge|business_finlynq_restore_drill)
        fail "rehearsal resolved a production resource name"
        ;;
    esac
  done <<<"$rehearsal_resources"
  [[ "$app_port" != "3100" ]] || fail "rehearsal must use a non-production loopback port"
  [[ "$app_origin" == "http://127.0.0.1:$app_port" ]] || fail "rehearsal APP_ORIGIN must be its isolated loopback listener"
  [[ -n "$session_cookie_name" && "$session_cookie_name" != __Host-* ]] || fail "rehearsal must use a non-__Host session cookie"
  [[ "$backup_directory" == "$evidence_root"/* ]] || fail "rehearsal backups must stay below the evidence root"
  [[ "$(jq -r '.services.backup.environment.BACKUP_REQUIRE_OFFSITE' <<<"$rendered_compose")" == "false" ]] \
    || fail "rehearsal backup must not contact an off-site remote"
  [[ "$(jq -r '.services.verify_latest_backup.environment.BACKUP_REQUIRE_OFFSITE_MARKER' <<<"$rendered_compose")" == "false" ]] \
    || fail "rehearsal backup verifier must not require an off-site marker"
  [[ "$release_DEMO_LOGIN_ENABLED" == "true" && "$release_DEMO_WRITES_ENABLED" == "true" ]] \
    || fail "release rehearsal requires the writable synthetic demo acceptance path"
  public_base_url="$app_origin"
fi

scanner_volume_name="$(jq -r '.volumes.business_finlynq_clamav.name // empty' <<<"$rendered_compose")" \
  || fail "evidence-scanner volume name could not be read"
scanner_evidence_network_name="$(jq -r '.networks.business_finlynq_evidence.name // empty' <<<"$rendered_compose")" \
  || fail "evidence-scanner private network name could not be read"
scanner_egress_network_name="$(jq -r '.networks.business_finlynq_scanner_egress.name // empty' <<<"$rendered_compose")" \
  || fail "evidence-scanner egress network name could not be read"
[[ -n "$scanner_volume_name" && -n "$scanner_evidence_network_name" \
  && -n "$scanner_egress_network_name" ]] \
  || fail "evidence-scanner resource names are missing"

compose_hash="$(canonical_compose_sha256 "$rendered_compose")" \
  || fail "rendered Compose configuration checksum could not be computed"
[[ "$compose_hash" =~ ^[a-f0-9]{64}$ ]] \
  || fail "rendered Compose configuration checksum is invalid"
unset rendered_compose
plan_started_at="$(checked_utc_timestamp)" \
  || fail "release-plan timestamp could not be generated"
git_tree_manifest_sha256="$(checked_file_sha256 \
  "$evidence_directory/03-candidate-git-tree.txt")" \
  || fail "candidate Git-tree manifest checksum could not be read"
staged_tree_manifest_sha256="$(checked_file_sha256 \
  "$evidence_directory/04-staged-tree-sha256.txt")" \
  || fail "staged-tree manifest checksum could not be read"
clean_environment=false
[[ "$mode" == rehearsal ]] && clean_environment=true
jq -n \
  --arg startedAt "$plan_started_at" \
  --arg mode "$mode" \
  --arg revision "$revision" \
  --arg runId "$run_id" \
  --arg project "$compose_project" \
  --arg composeSha256 "$compose_hash" \
  --arg operationsEnvironmentSha256 "$operations_environment_sha256" \
  --arg initialState "$initial_state" \
  --arg initialResumeRunId "$initial_resume_run_id" \
  --arg candidateTreeId "$candidate_tree_id" \
  --arg gitTreeManifestSha256 "$git_tree_manifest_sha256" \
  --arg stagedTreeManifestSha256 "$staged_tree_manifest_sha256" \
  --arg baseUrl "$public_base_url" \
  --argjson cleanEnvironment "$clean_environment" \
  '{schemaVersion: 1, product: "business-finlynq", status: "started", startedAt: $startedAt, mode: $mode, revision: $revision, runId: $runId, candidateTreeId: $candidateTreeId, gitTreeManifestSha256: $gitTreeManifestSha256, stagedTreeManifestSha256: $stagedTreeManifestSha256, composeProject: $project, composeConfigurationSha256: $composeSha256, operationsEnvironmentSha256: (if $operationsEnvironmentSha256 == "" then null else $operationsEnvironmentSha256 end), acceptanceBaseUrl: $baseUrl, cleanEnvironment: $cleanEnvironment, initialState: (if $mode == "initial" then $initialState else null end), resumedFromRunId: (if $initialResumeRunId == "" then null else $initialResumeRunId end)}' \
  >"$evidence_directory/00-release-plan.json"
chmod 0600 -- "$evidence_directory/00-release-plan.json"

record_initial_input_attestations() {
  [[ "$mode" == "initial" ]] || return 0
  local secret_source metadata owner_uid group_gid mode_bits byte_size secret_sha256
  local secret_attestations='[]'
  while IFS= read -r secret_source; do
    [[ -n "$secret_source" && -f "$secret_source" && ! -L "$secret_source" ]] \
      || fail "initial secret-source attestation found an unsafe path"
    metadata="$(stat -c '%u|%g|%a|%s' -- "$secret_source")"
    IFS='|' read -r owner_uid group_gid mode_bits byte_size <<<"$metadata"
    [[ "$owner_uid" == "0" && "$group_gid" =~ ^[0-9]+$ \
      && "$mode_bits" =~ ^[0-7]{3,4}$ && "$byte_size" =~ ^[0-9]+$ ]] \
      || fail "initial secret-source metadata is invalid"
    (( (8#$mode_bits & 8#007) == 0 )) \
      || fail "initial secret source is accessible by other users: $secret_source"
    secret_sha256="$(checked_file_sha256 "$secret_source")" \
      || fail "initial secret-source checksum could not be read"
    secret_attestations="$(jq -c --arg path "$secret_source" \
      --arg sha256 "$secret_sha256" --argjson ownerUid "$owner_uid" \
      --argjson groupGid "$group_gid" --arg mode "$mode_bits" \
      --argjson bytes "$byte_size" \
      '. + [{path: $path, sha256: $sha256, ownerUid: $ownerUid,
        groupGid: $groupGid, mode: $mode, bytes: $bytes}]' \
      <<<"$secret_attestations")" \
      || fail "initial secret-source attestation could not be assembled"
  done <<<"$initial_secret_sources"
  (( $(jq 'length' <<<"$secret_attestations") > 0 )) \
    || fail "initial secret-source attestation is empty"
  jq -n --arg revision "$revision" --arg composeEnvironmentSha256 "$compose_environment_sha256" \
    --arg operationsEnvironmentSha256 "$operations_environment_sha256" \
    --argjson secrets "$secret_attestations" \
    '{schemaVersion: 1, product: "business-finlynq", revision: $revision,
      composeEnvironmentSha256: $composeEnvironmentSha256,
      operationsEnvironmentSha256: $operationsEnvironmentSha256, secrets: $secrets}' \
    >"$evidence_directory/06-initial-inputs.json"
  chmod 0600 -- "$evidence_directory/06-initial-inputs.json"
}

record_initial_input_attestations

quiesce_and_verify_initial_schedulers() {
  [[ "$mode" == "initial" ]] || return 0
  command -v systemctl >/dev/null 2>&1 \
    || fail "systemctl is unavailable for initial scheduler containment"
  local unit_name load_state enabled_state active_state enabled_status active_status
  local -a timer_units=(
    business-finlynq-backup.timer
    business-finlynq-monitor.timer
    business-finlynq-accounting-evidence.timer
    business-finlynq-demo-reconcile.timer
    business-finlynq-continuous-deployment.timer
  )
  local -a service_units=(
    business-finlynq-backup.service
    business-finlynq-monitor.service
    business-finlynq-accounting-evidence.service
    business-finlynq-demo-reconcile.service
    business-finlynq-continuous-deployment.service
  )

  # Refresh systemd before inspecting exact units. This closes the failure
  # boundary where a partial unit copy happened before the installer's own
  # daemon-reload and prevents a stale not-found cache from hiding an enabled
  # wants symlink.
  systemctl daemon-reload \
    || fail "systemd could not reload before initial scheduler containment"

  for unit_name in "${timer_units[@]}"; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || fail "initial scheduler unit state could not be inspected: $unit_name"
    [[ "$load_state" != "error" && -n "$load_state" ]] \
      || fail "initial scheduler unit returned an invalid load state: $unit_name"
    if [[ "$load_state" != "not-found" ]]; then
      systemctl disable --now "$unit_name" \
        || fail "initial scheduler timer could not be disabled: $unit_name"
    fi
    enabled_state=""; enabled_status=0
    if enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"; then
      enabled_status=0
    else
      enabled_status=$?
    fi
    if [[ "$load_state" == "not-found" ]]; then
      [[ "$enabled_status" != "0" && "$enabled_state" != "enabled" \
        && ! -e "/etc/systemd/system/$unit_name" \
        && ! -L "/etc/systemd/system/$unit_name" ]] \
        || fail "not-found initial timer still has installed or enabled state: $unit_name"
    else
      [[ "$enabled_status" == "1" && "$enabled_state" == "disabled" ]] \
        || fail "initial scheduler timer is not exactly disabled: $unit_name"
    fi
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    if [[ "$load_state" == "not-found" ]]; then
      [[ "$active_status" != "0" && "$active_state" != "active" ]] \
        || fail "not-found initial timer is unexpectedly active: $unit_name"
    else
      [[ "$active_status" == "3" && "$active_state" == "inactive" ]] \
        || fail "initial scheduler timer is not exactly inactive: $unit_name"
    fi
  done
  for unit_name in "${service_units[@]}"; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || fail "initial scheduler service state could not be inspected: $unit_name"
    [[ "$load_state" != "error" && -n "$load_state" ]] \
      || fail "initial scheduler service returned an invalid load state: $unit_name"
    if [[ "$load_state" != "not-found" ]]; then
      systemctl stop "$unit_name" \
        || fail "initial scheduler service could not be stopped: $unit_name"
    else
      [[ ! -e "/etc/systemd/system/$unit_name" \
        && ! -L "/etc/systemd/system/$unit_name" ]] \
        || fail "not-found initial service still has an installed unit: $unit_name"
    fi
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    if [[ "$load_state" == "not-found" ]]; then
      [[ "$active_status" != "0" && "$active_state" != "active" ]] \
        || fail "not-found initial service is unexpectedly active: $unit_name"
    else
      [[ "$active_status" == "3" && "$active_state" == "inactive" ]] \
        || fail "initial scheduler service is not exactly inactive: $unit_name"
    fi
  done

  unit_name=business-finlynq-development-deployment.timer
  active_state=""; active_status=0
  if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
    active_status=0
  else
    active_status=$?
  fi
  [[ "$active_status" != "0" && "$active_state" != "active" ]] \
    || fail "development deployment timer must remain inactive during production bootstrap"
  enabled_state=""; enabled_status=0
  if enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"; then
    enabled_status=0
  else
    enabled_status=$?
  fi
  [[ "$enabled_status" != "0" \
    && ( "$enabled_state" == "disabled" || "$enabled_state" == "not-found" ) ]] \
    || fail "development deployment timer must remain disabled during production bootstrap"

  # A service with no [Install] section is reported as static by systemd and
  # `is-enabled --quiet` succeeds for that classification. Only its active
  # state is meaningful; the timer above is the independently enabled unit.
  unit_name=business-finlynq-development-deployment.service
  active_state=""; active_status=0
  if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
    active_status=0
  else
    active_status=$?
  fi
  [[ "$active_status" != "0" && "$active_state" != "active" ]] \
    || fail "development deployment service must remain inactive during production bootstrap"
  initial_schedulers_verified="true"
  printf '%s\n' "Production operation/deployment schedulers are disabled and services are quiescent."
}

verify_initial_state_contract() {
  [[ "$mode" == "initial" ]] || return 0
  local resource_name container_id container_contract service_name image_revision
  local expected_volume_label expected_network_label expected_network_internal prior_record
  local logical_image expected_resume_image_id volume_names network_names
  local prior_failure_record prior_plan prior_rollback
  local failed_initial_record=""
  local resumable_router_container_id="" resumable_router_running="false"
  local resumable_router_expected_image_id="" router_health_state=""
  local router_state_volume_present="false" router_maintenance_status=""
  local -a project_containers=()
  local -a forbidden_volumes=(
    business_finlynq_pgdata
    business_finlynq_pgdata_clamav
    business_finlynq_private-release-router-state-v2
  )
  local -a forbidden_networks=(
    business_finlynq_private
    business_finlynq_private_evidence
    business_finlynq_egress
    business_finlynq_egress_scanner
    business_finlynq_private-frontend
    business_finlynq_private-router-control
    business_finlynq_restore_drill
  )

  initial_schedule_installed="true"
  quiesce_and_verify_initial_schedulers

  read_docker_output "initial production project containers" ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq'
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] \
      || fail "Docker returned an invalid initial production container ID"
    project_containers+=("$container_id")
  done <<<"$docker_query_output"

  if [[ "$initial_state" == "fresh" ]]; then
    (( ${#project_containers[@]} == 0 )) \
      || fail "fresh initial production requires no preexisting Business Finlynq production containers"
  else
    prior_evidence_directory="$evidence_root/$revision/$initial_resume_run_id"
    [[ -d "$prior_evidence_directory" && ! -L "$prior_evidence_directory" \
      && "$(readlink -f -- "$prior_evidence_directory")" == "$prior_evidence_directory" \
      && "$(stat -c '%u:%a' -- "$prior_evidence_directory")" == "0:700" ]] \
      || fail "acknowledged prior initial evidence directory is unavailable or unsafe"
    prior_failure_record="$prior_evidence_directory/99-failure.json"
    prior_plan="$prior_evidence_directory/00-release-plan.json"
    prior_rollback="$prior_evidence_directory/12-rollback-artifact.json"
    for prior_record in "$prior_failure_record" "$prior_plan" "$prior_rollback" \
      "$prior_evidence_directory/06-initial-inputs.json" \
      "$prior_evidence_directory/11-images.json" \
      "$prior_evidence_directory/SHA256SUMS"; do
      [[ -f "$prior_record" && ! -L "$prior_record" \
        && "$(stat -c '%u:%a' -- "$prior_record")" == "0:600" ]] \
        || fail "acknowledged prior initial evidence is incomplete or unsafe"
    done
    [[ ! -e "$prior_evidence_directory/90-release-complete.json" \
      && ! -L "$prior_evidence_directory/90-release-complete.json" ]] \
      || fail "an accepted initial run cannot authorize resume"
    if ! awk '
      NF != 2 || $1 !~ /^[a-f0-9]{64}$/ || $2 !~ /^\.\/[A-Za-z0-9][A-Za-z0-9._-]*$/ {
        exit 1
      }
    ' "$prior_evidence_directory/SHA256SUMS"; then
      fail "acknowledged prior initial checksum inventory is unsafe"
    fi
    (
      cd -- "$prior_evidence_directory"
      sha256sum --check --strict --quiet SHA256SUMS
    ) || fail "acknowledged prior initial evidence failed checksum verification"
    jq -e --arg revision "$revision" --arg priorRunId "$initial_resume_run_id" '
      .schemaVersion == 1 and .product == "business-finlynq" and
      .status == "failed" and .mode == "initial" and .revision == $revision and
      .runId == $priorRunId and .initialTimersRemainDisabled == true
    ' "$prior_failure_record" >/dev/null \
      || fail "acknowledged prior failure record does not match the resume contract"
    jq -e --arg revision "$revision" --arg priorRunId "$initial_resume_run_id" \
      --arg composeSha256 "$compose_hash" \
      --arg operationsSha256 "$operations_environment_sha256" '
      .schemaVersion == 1 and .product == "business-finlynq" and
      .status == "started" and .mode == "initial" and .revision == $revision and
      .runId == $priorRunId and .composeConfigurationSha256 == $composeSha256 and
      .operationsEnvironmentSha256 == $operationsSha256
    ' "$prior_plan" >/dev/null \
      || fail "acknowledged prior initial environment hashes differ from this resume"
    jq -e --arg revision "$revision" '
      .schemaVersion == 1 and .previous == null and
      .candidate.revision == $revision and .databaseRollback == "forward-repair-only"
    ' "$prior_rollback" >/dev/null \
      || fail "acknowledged prior initial rollback evidence is invalid"
    cmp -s -- "$prior_evidence_directory/06-initial-inputs.json" \
      "$evidence_directory/06-initial-inputs.json" \
      || fail "initial secret/input attestations changed since the acknowledged failure"
    failed_initial_record="$prior_failure_record"
    resumable_router_expected_image_id="$(jq -er \
      '.images[] | select(.name == "router") | .imageId' \
      "$prior_evidence_directory/11-images.json")" \
      || fail "prior image inventory could not be parsed for the release router"
    [[ "$resumable_router_expected_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || fail "prior image inventory has no stable release-router image"

    for container_id in "${project_containers[@]}"; do
      read_docker_output "resumable initial container contract" inspect --format \
        '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"imageReference":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}' \
        "$container_id"
      container_contract="$docker_query_output"
      jq -e '
        type == "object" and
        keys == ["health", "imageId", "imageReference", "project", "revision",
          "running", "service", "status"] and
        .project == "business-finlynq" and
        (.service | type == "string" and length > 0) and
        (.revision == null or (.revision | type == "string")) and
        (.imageReference | type == "string" and length > 0) and
        (.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
        (.running | type == "boolean") and
        ((.running == true and .status == "running") or
          (.running == false and (.status == "exited" or .status == "created"))) and
        (.health == null or (.health | type == "string"))
      ' <<<"$container_contract" >/dev/null \
        || fail "resumable container contract is malformed or escaped the project"
      project_name="$(jq -er '.project' <<<"$container_contract")" \
        || fail "resumable container project could not be parsed"
      service_name="$(jq -er '.service' <<<"$container_contract")" \
        || fail "resumable container service could not be parsed"
      image_revision="$(jq -r '.revision // ""' <<<"$container_contract")" \
        || fail "resumable container revision could not be parsed"
      image_reference="$(jq -er '.imageReference' <<<"$container_contract")" \
        || fail "resumable container image reference could not be parsed"
      image_id="$(jq -er '.imageId' <<<"$container_contract")" \
        || fail "resumable container image ID could not be parsed"
      container_running="$(jq -r '
        if (.running | type) == "boolean"
        then (.running | tostring)
        else error("running is not boolean")
        end
      ' <<<"$container_contract")" \
        || fail "resumable container running state could not be parsed"
      container_status="$(jq -er '.status' <<<"$container_contract")" \
        || fail "resumable container lifecycle state could not be parsed"
      container_health="$(jq -r '.health // ""' <<<"$container_contract")" \
        || fail "resumable container health could not be parsed"
      [[ "$project_name" == business-finlynq ]] \
        || fail "resumable container escaped the production Compose project"
      case "$service_name" in
        release_router)
          [[ -z "$resumable_router_container_id" ]] \
            || fail "initial resume found duplicate release-router containers"
          resumable_router_container_id="$container_id"
          resumable_router_running="$container_running"
          expected_resume_image_id="$resumable_router_expected_image_id"
          [[ "$expected_resume_image_id" =~ ^sha256:[a-f0-9]{64}$ \
            && "$image_id" == "$expected_resume_image_id" ]] \
            || fail "resumable release-router image ID differs from prior evidence"
          [[ "$image_revision" == "$release_router_revision" \
            && ( "$image_reference" == "$release_router_reference" \
              || "$image_reference" == "$expected_resume_image_id" ) ]] \
            || fail "resumable release router is not the stable reviewed contract"
          read_docker_output "resumable stable release-router runtime" inspect "$container_id"
          jq -e --arg imageId "$expected_resume_image_id" \
            --arg stateVolume "$router_state_volume_name" \
            --arg revision "$release_router_revision" --arg contract "$release_router_contract" '
            length == 1 and .[0].Image == $imageId and
            .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
            .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
            .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
            .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
            .[0].Config.User == "10001:10001" and
            .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
            .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
            (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
            (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true")) != null and
            ((.[0].Mounts // []) | length) == 1 and
            .[0].Mounts[0].Type == "volume" and .[0].Mounts[0].Name == $stateVolume and
            .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
            .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
            .[0].Config.Cmd == ["serve"]
          ' <<<"$docker_query_output" >/dev/null \
            || fail "resumable release-router runtime differs from its hardened contract"
          if [[ "$container_running" == true ]]; then
            [[ "$container_health" == healthy ]] \
              || fail "running resumable release-router container is not healthy"
            read_docker_output "resumable release-router durable mode" exec "$container_id" sh -ec '
              [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
              [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
              cat /state/mode
            '
            [[ "$docker_query_output" == active || "$docker_query_output" == maintenance ]] \
              || fail "resumable release-router durable mode is invalid"
          fi
          ;;
        database|backup|provision_auth_worker_role|migrate|reconcile_runtime_grants|reconcile_auth_worker_grants|reconcile_backup_grants|verify_database_contract|bootstrap_demo|provision_backup|verify_accounting_evidence|app|release_acceptance|verify_latest_backup)
          [[ "$image_revision" == "$revision" ]] \
            || fail "resumable $service_name container is not from the interrupted revision"
          logical_image=operations
          case "$service_name" in
            database) logical_image=database ;;
            app) logical_image=app ;;
            migrate|verify_database_contract|bootstrap_demo) logical_image=migrator ;;
            release_acceptance) logical_image=acceptance ;;
          esac
          expected_resume_image_id="$(jq -r --arg name "$logical_image" \
            '.images[] | select(.name == $name) | .imageId' \
            "$prior_evidence_directory/11-images.json")" \
            || fail "prior image inventory could not be parsed for $logical_image"
          [[ "$expected_resume_image_id" =~ ^sha256:[a-f0-9]{64}$ \
            && "$image_id" == "$expected_resume_image_id" ]] \
            || fail "resumable $service_name container image ID differs from prior evidence"
          ;;
        evidence_scanner)
          read_docker_output "resumable pinned scanner image" image inspect --format '{{.Id}}' \
            "$scanner_image_reference"
          [[ "$image_reference" == "$scanner_image_reference" \
            && "$image_id" == "$docker_query_output" ]] \
            || fail "resumable evidence scanner does not use the pinned image reference"
          ;;
        *) fail "initial resume found an unexpected production service: ${service_name:-missing}" ;;
      esac
      if [[ "$service_name" == database || "$service_name" == evidence_scanner \
        || "$service_name" == release_router ]]; then
        if [[ "$container_running" == true ]]; then
          [[ "$container_health" == healthy ]] \
            || fail "running resumable $service_name container is not healthy"
        fi
      elif [[ "$container_running" == true ]]; then
        read_docker_output "stopped resumable $service_name container" stop --time 30 "$container_id"
        read_docker_output "quiescent resumable $service_name container" inspect \
          --format '{{.State.Running}}|{{.State.Status}}' "$container_id"
        [[ "$docker_query_output" == false\|exited ]] \
          || fail "resumable $service_name container could not be proven quiescent"
      fi
    done
  fi

  read_docker_output "Docker volumes before initial production" volume ls --format '{{.Name}}'
  volume_names="$docker_query_output"
  for resource_name in "${forbidden_volumes[@]}"; do
    if grep -Fxq -- "$resource_name" <<<"$volume_names"; then
      if [[ "$initial_state" == "fresh" \
        || ( "$resource_name" != business_finlynq_pgdata \
          && "$resource_name" != business_finlynq_pgdata_clamav \
          && "$resource_name" != business_finlynq_private-release-router-state-v2 ) ]]; then
        fail "initial production found a disallowed preexisting production volume: $resource_name"
      fi
      expected_volume_label=business_finlynq_pgdata
      [[ "$resource_name" == business_finlynq_pgdata_clamav ]] \
        && expected_volume_label=business_finlynq_clamav
      [[ "$resource_name" == business_finlynq_private-release-router-state-v2 ]] \
        && expected_volume_label=business_finlynq_release_router_state
      read_docker_output "resumable production volume $resource_name" volume inspect "$resource_name"
      jq -e --arg name "$resource_name" --arg logical "$expected_volume_label" '
        length == 1 and .[0].Name == $name and .[0].Driver == "local" and
        .[0].Scope == "local" and (.[0].Options == null or .[0].Options == {}) and
        (.[0].Mountpoint | type == "string" and endswith("/volumes/" + $name + "/_data")) and
        .[0].Labels["com.docker.compose.project"] == "business-finlynq" and
        .[0].Labels["com.docker.compose.volume"] == $logical
      ' <<<"$docker_query_output" >/dev/null \
        || fail "resumable production volume ownership is invalid: $resource_name"
      if [[ "$resource_name" == business_finlynq_private-release-router-state-v2 ]]; then
        router_state_volume_present="true"
        if [[ "$resumable_router_running" == "true" ]]; then
          read_docker_output "resumable release-router state volume" run --rm --network none \
            --read-only --cap-drop ALL --security-opt no-new-privileges \
            --pids-limit 32 --memory 32m --cpus 0.25 \
            --mount "type=volume,src=$resource_name,dst=/state,readonly" \
            --entrypoint sh "$resumable_router_expected_image_id" -ec '
              [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
              [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
              mode="$(cat /state/mode)"
              [[ "$mode" == active || "$mode" == maintenance ]]
              printf "%s" "$mode"
            '
          [[ "$docker_query_output" == active || "$docker_query_output" == maintenance ]] \
            || fail "resumable release-router state volume contains an invalid mode"
        fi
      fi
    fi
  done
  read_docker_output "Compose-owned volumes before initial production" volume ls \
    --filter 'label=com.docker.compose.project=business-finlynq' --format '{{.Name}}'
  while IFS= read -r resource_name; do
    [[ -z "$resource_name" ]] && continue
    if [[ "$initial_state" == "fresh" \
      || ( "$resource_name" != business_finlynq_pgdata \
        && "$resource_name" != business_finlynq_pgdata_clamav \
        && "$resource_name" != business_finlynq_private-release-router-state-v2 ) ]]; then
      fail "initial production found an unexpected Compose-owned volume: $resource_name"
    fi
  done <<<"$docker_query_output"

  read_docker_output "Docker networks before initial production" network ls --format '{{.Name}}'
  network_names="$docker_query_output"
  for resource_name in "${forbidden_networks[@]}"; do
    if grep -Fxq -- "$resource_name" <<<"$network_names"; then
      if [[ "$initial_state" == "fresh" || "$resource_name" == business_finlynq_restore_drill ]]; then
        fail "initial production found a disallowed preexisting production network: $resource_name"
      fi
      expected_network_label=business_finlynq_private
      expected_network_internal=false
      case "$resource_name" in
        business_finlynq_private)
          expected_network_label=business_finlynq_private
          expected_network_internal=true
          ;;
        business_finlynq_private_evidence)
          expected_network_label=business_finlynq_evidence
          expected_network_internal=true
          ;;
        business_finlynq_egress)
          expected_network_label=business_finlynq_egress
          ;;
        business_finlynq_egress_scanner)
          expected_network_label=business_finlynq_scanner_egress
          ;;
        business_finlynq_private-frontend)
          expected_network_label=business_finlynq_frontend
          expected_network_internal=true
          ;;
        business_finlynq_private-router-control)
          expected_network_label=business_finlynq_router_control
          ;;
      esac
      read_docker_output "resumable production network $resource_name" network inspect "$resource_name"
      jq -e --arg name "$resource_name" --arg logical "$expected_network_label" \
        --arg internal "$expected_network_internal" '
        length == 1 and .[0].Name == $name and .[0].Driver == "bridge" and
        .[0].Scope == "local" and .[0].Internal == ($internal == "true") and
        .[0].Attachable == false and .[0].Ingress == false and
        (.[0].IPAM.Driver == "default") and
        (.[0].IPAM.Config | type == "array" and length == 1) and
        .[0].Labels["com.docker.compose.project"] == "business-finlynq" and
        .[0].Labels["com.docker.compose.network"] == $logical
      ' <<<"$docker_query_output" >/dev/null \
        || fail "resumable production network ownership is invalid: $resource_name"
      if [[ "$resource_name" == business_finlynq_private-router-control ]]; then
        jq -e '.[0].Options == {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.enable_ip_masquerade": "false"
        }' <<<"$docker_query_output" >/dev/null \
          || fail "resumable router control network permits unreviewed forwarding"
      fi
    fi
  done
  grep -Fxq -- business_finlynq_edge <<<"$network_names" \
    || fail "initial production requires the pre-created external production ingress network"
  read_docker_output "Compose-owned networks before initial production" network ls \
    --filter 'label=com.docker.compose.project=business-finlynq' --format '{{.Name}}'
  while IFS= read -r resource_name; do
    [[ -z "$resource_name" ]] && continue
    if [[ "$initial_state" == "fresh" ]]; then
      fail "fresh initial production found an unexpected Compose-owned network: $resource_name"
    fi
    case "$resource_name" in
      business_finlynq_private|business_finlynq_private_evidence|business_finlynq_egress|business_finlynq_egress_scanner|business_finlynq_private-frontend|business_finlynq_private-router-control) ;;
      *) fail "initial resume found an unexpected Compose-owned network: $resource_name" ;;
    esac
  done <<<"$docker_query_output"

  if [[ "$initial_state" == "resume" \
    && "$router_state_volume_present" == "true" \
    && "$resumable_router_running" != "true" ]]; then
    # A daemon interruption can leave either the exact stopped router or only
    # its Compose-owned volume. Normalize that already-attested volume through
    # the exact prior router image before any listener is started. The helper
    # accepts only an empty Docker-created directory or the exact prior mode
    # sentinel and commits maintenance with file and directory durability.
    read_docker_output "normalized resumable release-router state" run --rm \
      --network none --read-only --user 0:0 --cap-drop ALL \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
      --pids-limit 32 --memory 32m --cpus 0.25 \
      --mount "type=volume,src=$router_state_volume_name,dst=/state" \
      --entrypoint sh "$resumable_router_expected_image_id" -ec '
        set -eu
        [[ -d /state && ! -L /state ]]
        unexpected="$(find /state -mindepth 1 -maxdepth 1 \
          ! -path /state/mode -print -quit)"
        [[ -z "$unexpected" ]]
        directory_contract="$(stat -c "%u:%g:%a" /state)"
        if [[ ! -e /state/mode && ! -L /state/mode ]]; then
          case "$directory_contract" in
            0:0:700|0:0:755|10001:10001:700) ;;
            *) exit 1 ;;
          esac
        else
          [[ -f /state/mode && ! -L /state/mode \
            && "$directory_contract" == 10001:10001:700 ]]
          [[ "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
          prior_mode="$(cat /state/mode)"
          [[ "$prior_mode" == active || "$prior_mode" == maintenance ]]
        fi
        temporary="/state/.mode.$$"
        trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
        printf "maintenance\n" >"$temporary"
        chmod 0600 "$temporary"
        chown 10001:10001 "$temporary"
        sync "$temporary" 2>/dev/null || sync
        if [[ "$directory_contract" != 10001:10001:700 ]]; then
          chmod 0700 /state
          chown 10001:10001 /state
        fi
        mv -f "$temporary" /state/mode
        sync /state/mode 2>/dev/null || sync
        sync -f /state 2>/dev/null || sync
        trap - EXIT INT TERM
        [[ "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
        [[ -f /state/mode && ! -L /state/mode \
          && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 \
          && "$(cat /state/mode)" == maintenance ]]
        printf maintenance
      '
    [[ "$docker_query_output" == maintenance ]] \
      || fail "resumable release-router state could not be normalized to maintenance"

    if [[ -n "$resumable_router_container_id" ]]; then
      router_transition_attempted="true"
      read_docker_output "restarted resumable release router" start \
        "$resumable_router_container_id"
      [[ "$docker_query_output" == "$resumable_router_container_id" \
        || "$docker_query_output" == "${resumable_router_container_id:0:12}" ]] \
        || fail "Docker returned an unexpected resumed release-router identity"
      for _ in {1..60}; do
        router_health_state="$(docker inspect --format \
          '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
          "$resumable_router_container_id")" \
          || fail "resumed release-router health could not be inspected"
        [[ "$router_health_state" == true\|healthy ]] && break
        sleep 2
      done
      [[ "$router_health_state" == true\|healthy ]] \
        || fail "exact resumable release router did not become healthy"
      read_docker_output "resumed release-router durable maintenance" exec \
        "$resumable_router_container_id" sh -ec '
          [[ -f /state/mode && ! -L /state/mode \
            && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
          cat /state/mode
        '
      [[ "$docker_query_output" == maintenance ]] \
        || fail "resumed release router did not retain durable maintenance"
      curl --fail --silent --show-error --max-time 5 \
        "http://127.0.0.1:$app_port/_business-finlynq/release-router/live" \
        | jq -e 'type == "object" and keys == ["status"] and \
          .status == "release-router-live"' >/dev/null \
        || fail "resumed release-router private liveness is unavailable"
      router_maintenance_status="$(curl --silent --show-error --max-time 10 \
        --header "X-Request-Id: initial-resume-$run_id" \
        --output /dev/null --write-out '%{http_code}' \
        "$public_base_url/api/health")" \
        || fail "resumed release-router maintenance response is unavailable"
      [[ "$router_maintenance_status" == 503 ]] \
        || fail "resumed release router did not start in public maintenance"
      router_maintenance_confirmed="true"
      router_was_preexisting="true"
    fi
  fi

  [[ ! -e /home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance \
    && ! -L /home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance ]] \
    || fail "initial production cannot begin with a scheduler-maintenance marker"
  if [[ "$initial_state" == "fresh" ]]; then
    bash "$candidate_source_root/deploy/edge/verify-external-edge.sh" --scope preflight
    printf '%s\n' \
      "Fresh production state accepted; only the attested external ingress network is pre-created."
  else
    bash "$candidate_source_root/deploy/edge/verify-external-edge.sh" --scope development
    printf 'Interrupted initial state accepted for exact-revision replay from %s.\n' \
      "$failed_initial_record"
  fi
}

if [[ "$mode" == "initial" ]]; then
  stage="initial-fresh-state-contract"
  # Arm containment in the parent before the first scheduler mutation. Keep
  # the successful attestation flag in the parent so any later failure can
  # publish a truthful, resumable timer boundary.
  initial_schedule_installed="true"
  if [[ "$initial_state" == "resume" ]]; then
    prior_evidence_directory="$evidence_root/$revision/$initial_resume_run_id"
  fi
  run_logged 01-initial-fresh-state.log verify_initial_state_contract
  initial_schedulers_verified="true"
  write_checkpoint 02-initial-fresh-state.json initial-state-accepted
fi

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
# The stable router is not part of an ordinary application release. Rebuilding
# its shared v1 tag here could make monitoring observe a different tag even
# though the accepted listener was deliberately left untouched. Reuse the
# already-attested image for routine releases; bootstrap it only when the
# deployment has no router yet (initial/rehearsal/one-time legacy transition).
if [[ "$mode" == "release" ]]; then
  release_router_prebuild_query="$(compose ps --all --quiet release_router)" \
    || fail "pre-build release-router inventory could not be read"
  [[ -z "$release_router_prebuild_query" \
    || ( "$release_router_prebuild_query" =~ ^[a-f0-9]{12,64}$ \
      && "$release_router_prebuild_query" != *$'\n'* ) ]] \
    || fail "pre-build release-router inventory is ambiguous"
  [[ -z "$release_router_prebuild_query" ]] || router_was_preexisting="true"
fi
read_docker_output "pre-build stable release-router image" image ls \
  --quiet --no-trunc "$release_router_reference"
release_router_prebuild_image_id="$docker_query_output"
[[ -z "$release_router_prebuild_image_id" \
  || ( "$release_router_prebuild_image_id" =~ ^sha256:[a-f0-9]{64}$ \
    && "$release_router_prebuild_image_id" != *$'\n'* ) ]] \
  || fail "pre-build stable release-router image inventory is ambiguous"
if [[ -z "$release_router_prebuild_image_id" \
  && "$router_was_preexisting" == "true" ]]; then
  fail "the running stable release router has lost its canonical local image tag"
fi
if [[ -n "$release_router_prebuild_image_id" ]]; then
  run_logged 10-release-router-build.log printf '%s\n' \
    "Reusing the existing separately versioned release-router image without rebuilding its shared tag."
else
  run_logged 10-release-router-build.log compose_release_router_build build \
    --provenance=false --sbom=false \
    --build-arg "SOURCE_DATE_EPOCH=$release_router_source_date_epoch" release_router
fi
run_logged 10-image-build.log compose_image_build --profile operations --profile auth-email --profile acceptance build \
  --provenance=false --sbom=false \
  --build-arg "SOURCE_DATE_EPOCH=$candidate_source_date_epoch" \
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
  "router=$release_router_reference" \
  "app=business-finlynq-app:$revision" \
  "migrator=business-finlynq-migrator:$revision" \
  "authWorker=business-finlynq-auth-worker:$revision" \
  "acceptance=business-finlynq-acceptance:$revision" \
  "operations=business-finlynq-operations:$revision"; do
  logical_name="${image_name%%=*}"
  image_reference="${image_name#*=}"
  image_id="$(docker image inspect --format '{{.Id}}' "$image_reference")"
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_reference")"
  image_compose_project="$(docker image inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$image_reference")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "$logical_name image has no immutable image ID"
  if [[ "$logical_name" == router ]]; then
    [[ "$image_revision" == "$release_router_revision" ]] \
      || fail "release-router image does not carry the stable reviewed revision"
    [[ "$image_compose_project" == "$release_router_build_compose_project" ]] \
      || fail "release-router image did not originate from its canonical build project"
    [[ "$(docker image inspect --format \
      '{{ index .Config.Labels "com.business-finlynq.release-router.contract" }}' \
      "$image_reference")" == "$release_router_contract" ]] \
      || fail "release-router image does not carry the reviewed contract version"
  else
    [[ "$image_revision" == "$revision" ]] || fail "$logical_name image OCI revision does not match the release"
    [[ "$image_compose_project" == "$image_build_compose_project" ]] \
      || fail "$logical_name image did not originate from the revision-bound Compose build project"
  fi
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
router_config_sha256="$(
  cd -- "$candidate_source_root/deploy/release/router" \
    && sha256sum Caddyfile Caddyfile.maintenance entrypoint.sh \
    | awk '{print $1}' | sha256sum | awk '{print $1}'
)" || fail "release-router configuration checksum could not be read"
[[ "$router_config_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "release-router configuration checksum is invalid"
run_logged 10-release-router-image-content.log docker run --rm --network none --read-only \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 64m --cpus 0.25 \
  --entrypoint /bin/sh "${image_ids[router]}" -ec \
  'test "$(stat -c "%u:%g:%a:%F" /etc/caddy/Caddyfile)" = "0:0:444:regular file" && test "$(stat -c "%u:%g:%a:%F" /etc/caddy/Caddyfile.maintenance)" = "0:0:444:regular file" && test "$(stat -c "%u:%g:%a:%F" /usr/local/bin/release-router-entrypoint)" = "0:0:555:regular file" && test ! -L /etc/caddy/Caddyfile && test ! -L /etc/caddy/Caddyfile.maintenance && test ! -L /usr/local/bin/release-router-entrypoint && sha256sum /etc/caddy/Caddyfile /etc/caddy/Caddyfile.maintenance /usr/local/bin/release-router-entrypoint | awk '\''{print $1}'\'' | sha256sum' \
  | grep -F "$router_config_sha256  -" >/dev/null \
  || fail "release-router image does not contain the exact reviewed configuration"

# From this point onward every release-run service, including browser
# acceptance, resolves the immutable IDs just inspected rather than mutable
# commit-shaped tags.
release_images_pinned="true"
pinned_compose="$(compose --profile operations --profile auth-email --profile acceptance config --format json)"
[[ "$(jq -r '.services.release_router.image // empty' <<<"$pinned_compose")" == "${image_ids[router]}" ]] \
  || fail "pinned Compose configuration does not bind the immutable release-router image"
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
pinned_compose_hash="$(canonical_compose_sha256 "$pinned_compose")" \
  || fail "pinned Compose configuration checksum could not be computed"
unset pinned_compose
[[ "$pinned_compose_hash" =~ ^[a-f0-9]{64}$ ]] || fail "pinned Compose configuration checksum is invalid"
jq -n --argjson images "$image_evidence" --arg pinnedComposeSha256 "$pinned_compose_hash" \
  '{schemaVersion: 1, pinnedComposeConfigurationSha256: $pinnedComposeSha256, images: $images}' \
  >"$evidence_directory/11-images.json"
chmod 0600 -- "$evidence_directory/11-images.json"
if [[ "$mode" == "initial" && "$initial_state" == "resume" ]]; then
  cmp -s -- "$prior_evidence_directory/11-images.json" "$evidence_directory/11-images.json" \
    || fail "initial resume rebuilt image IDs or pinned Compose configuration differently"
fi

attest_evidence_scanner() {
  local scanner_container scanner_runtime expected_scanner_image_id now signature_record
  local signature_path signature_uid signature_gid signature_mode signature_mtime
  local signature_count=0 signature_inventory signature_evidence='[]' verified_at

  capture_compose_container_id "running evidence-scanner container" ps --quiet evidence_scanner
  scanner_container="$captured_compose_container_id"
  read_docker_output "evidence-scanner runtime contract" inspect \
    --format '{"imageId":{{json .Image}},"user":{{json .Config.User}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"status":{{json .State.Status}},"healthy":{{json .State.Health.Status}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}' \
    "$scanner_container"
  scanner_runtime="$docker_query_output"
  read_docker_output "pinned evidence-scanner image" image inspect --format '{{.Id}}' \
    "$scanner_image_reference"
  expected_scanner_image_id="$docker_query_output"
  jq -e --arg imageId "$expected_scanner_image_id" \
    --arg evidenceNetwork "$scanner_evidence_network_name" \
    --arg egressNetwork "$scanner_egress_network_name" \
    --arg volumeName "$scanner_volume_name" '
    type == "object" and
    .imageId == $imageId and .user == "100:101" and .readOnly == true and
    .status == "running" and .healthy == "healthy" and
    ([.networks | keys[]] | sort) ==
      ([$egressNetwork, $evidenceNetwork] | sort) and
    (.mounts | length) == 1 and .mounts[0].Type == "volume" and
    .mounts[0].Name == $volumeName and
    .mounts[0].Destination == "/var/lib/clamav" and .mounts[0].RW == true
  ' <<<"$scanner_runtime" >/dev/null \
    || fail "evidence scanner runtime differs from the pinned non-root healthy contract"

  signature_inventory="$(compose exec -T evidence_scanner /bin/sh -ec '
    found=false
    for path in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do
      [ -f "$path" ] || continue
      found=true
      stat -c "%n|%u|%g|%a|%Y" "$path"
    done
    [ "$found" = true ]
  ')" || fail "evidence scanner signature inventory could not be read"
  now="$(date +%s)" \
    || fail "current time could not be read during scanner attestation"
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || fail "current time is invalid during scanner attestation"
  while IFS='|' read -r signature_path signature_uid signature_gid signature_mode signature_mtime; do
    [[ "$signature_path" =~ ^/var/lib/clamav/[A-Za-z0-9_.-]+\.(cvd|cld)$ \
      && "$signature_uid" == "100" && "$signature_gid" == "101" \
      && "$signature_mode" =~ ^[0-7]{3,4}$ \
      && "$signature_mtime" =~ ^[1-9][0-9]*$ ]] \
      || fail "evidence scanner returned unsafe signature metadata"
    (( (8#$signature_mode & 8#002) == 0 )) \
      || fail "evidence scanner signature is writable by other users"
    (( signature_mtime <= now + 300 )) \
      || fail "evidence scanner signature is future-dated"
    signature_evidence="$(jq -c \
      --arg path "$signature_path" --argjson uid "$signature_uid" \
      --argjson gid "$signature_gid" --arg mode "$signature_mode" \
      --argjson modifiedAtUnixtime "$signature_mtime" \
      '. + [{path: $path, uid: $uid, gid: $gid, mode: $mode,
        modifiedAtUnixtime: $modifiedAtUnixtime}]' <<<"$signature_evidence")" \
      || fail "evidence scanner signature evidence could not be assembled"
    signature_count=$((signature_count + 1))
  done <<<"$signature_inventory"
  (( signature_count > 0 )) || fail "evidence scanner has no accepted signature databases"

  verified_at="$(checked_utc_timestamp)" \
    || fail "evidence-scanner attestation timestamp could not be generated"
  jq -n --arg at "$verified_at" \
    --arg containerId "$scanner_container" --arg imageReference "$scanner_image_reference" \
    --arg imageId "$expected_scanner_image_id" --argjson signatures "$signature_evidence" \
    '{schemaVersion: 1, product: "business-finlynq", verifiedAt: $at,
      containerId: $containerId, imageReference: $imageReference, imageId: $imageId,
      runtimeUser: "100:101", readOnlyRootFilesystem: true, signatures: $signatures}' \
    >"$evidence_directory/14-evidence-scanner.json" \
    || fail "evidence-scanner attestation could not be written"
  chmod 0600 -- "$evidence_directory/14-evidence-scanner.json" \
    || fail "evidence-scanner attestation permissions could not be set"
}

probe_evidence_scanner() {
  compose run --rm --no-deps -T app node -e '
    const net = require("node:net");
    function query(parts) {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "evidence_scanner", port: 3310 });
        const chunks = [];
        const deadline = setTimeout(() => { socket.destroy(); reject(new Error("scanner probe timed out")); }, 15000);
        socket.on("connect", () => { for (const part of parts) socket.write(part); });
        socket.on("data", (part) => {
          chunks.push(part);
          if (part.includes(0)) { clearTimeout(deadline); socket.destroy(); resolve(Buffer.concat(chunks).toString("utf8").replace(/\0.*$/s, "")); }
        });
        socket.on("error", (error) => { clearTimeout(deadline); reject(error); });
        socket.on("end", () => { clearTimeout(deadline); resolve(Buffer.concat(chunks).toString("utf8").replace(/\0.*$/s, "")); });
      });
    }
    function acceptedClamdDatabaseUpdatedAt(version, now = Date.now()) {
      const match = /^ClamAV [^/\s]+\/[1-9]\d*\/((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4})$/.exec(version);
      const updatedAt = match ? Date.parse(`${match[1]} UTC`) : Number.NaN;
      const parsed = Number.isFinite(updatedAt) ? new Date(updatedAt) : null;
      const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const canonical = parsed
        ? `${weekdays[parsed.getUTCDay()]} ${months[parsed.getUTCMonth()]} ${String(parsed.getUTCDate()).padStart(2, " ")} ${String(parsed.getUTCHours()).padStart(2, "0")}:${String(parsed.getUTCMinutes()).padStart(2, "0")}:${String(parsed.getUTCSeconds()).padStart(2, "0")} ${parsed.getUTCFullYear()}`
        : "";
      if (!match || canonical !== match[1] || now - updatedAt > 7 * 86400_000 || updatedAt > now + 300_000) {
        throw new Error("scanner signatures are unavailable, stale, or future-dated");
      }
      return parsed.toISOString();
    }
    (async () => {
      const version = await query([Buffer.from("zVERSION\0", "binary")]);
      const databaseUpdatedAt = acceptedClamdDatabaseUpdatedAt(version);
      const sample = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
      const length = Buffer.alloc(4); length.writeUInt32BE(sample.length);
      const result = await query([Buffer.from("zINSTREAM\0", "binary"), length, sample, Buffer.alloc(4)]);
      if (!/EICAR/i.test(result) || !/FOUND/.test(result)) process.exit(1);
      console.log(JSON.stringify({ versionAccepted: true, version, databaseUpdatedAt,
        eicarDetected: true, response: result.trim() }));
    })().catch((error) => { console.error(error.message); process.exit(1); });
  '
}

record_running_database_image() {
  local output_file="$1"
  local database_container actual_image_id verified_at
  [[ "$output_file" == "$evidence_directory"/* && ! -e "$output_file" && ! -L "$output_file" ]] \
    || fail "database image evidence target is unsafe or already exists"
  database_container="$(compose ps --quiet database)"
  [[ "$database_container" =~ ^[a-f0-9]{12,64}$ ]] \
    || fail "running database container identity is missing or invalid"
  actual_image_id="$(docker inspect --format '{{.Image}}' "$database_container")"
  [[ "$actual_image_id" == "${image_ids[database]}" ]] \
    || fail "running database does not use the immutable reviewed database image"
  verified_at="$(checked_utc_timestamp)" \
    || fail "database-image attestation timestamp could not be generated"
  jq -n \
    --arg verifiedAt "$verified_at" \
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
  if [[ -e "$first_router_recovery_journal" || -L "$first_router_recovery_journal" ]]; then
    load_first_router_forward_repair_journal
  else
    previous_container="$(compose ps --all --quiet app)"
    [[ "$previous_container" =~ ^[a-f0-9]{12,64}$ ]] \
      || fail "exactly one existing app container is required; use a reviewed initial-install procedure"
    previous_container="$(docker inspect --format '{{.Id}}' "$previous_container")" \
      || fail "the previous application container identity could not be normalized"
    previous_app_id="$(docker inspect --format '{{.Image}}' "$previous_container")"
    previous_app_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$previous_container")"
    if [[ -z "$previous_app_revision" || "$previous_app_revision" == "<no value>" ]]; then
      [[ "$previous_app_id" == "$legacy_f8485_image_id" \
        && "${ROLLBACK_COMPATIBILITY_ACK:-}" == f8485-one-release-only ]] \
        || fail "the previous app has no OCI revision and is not the acknowledged exact f8485 compatibility image"
      previous_app_revision="$legacy_f8485_revision"
    fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$previous_container")" == true ]] \
      || fail "the previous application container is not running before release"
    previous_app_was_running="true"
    previous_auth_worker_container="$(compose --profile auth-email ps --all --quiet auth_email_worker)"
    [[ -z "$previous_auth_worker_container" \
      || ( "$previous_auth_worker_container" =~ ^[a-f0-9]{12,64}$ \
        && "$previous_auth_worker_container" != *$'\n'* ) ]] \
      || fail "previous authentication-worker container inventory is ambiguous"
    if [[ -n "$previous_auth_worker_container" \
      && "$(docker inspect --format '{{.State.Running}}' "$previous_auth_worker_container")" == true ]]; then
      previous_auth_worker_container="$(docker inspect --format '{{.Id}}' \
        "$previous_auth_worker_container")" \
        || fail "the previous authentication-worker identity could not be normalized"
      previous_auth_worker_was_running="true"
      previous_auth_worker_image_id="$(docker inspect --format '{{.Image}}' \
        "$previous_auth_worker_container")"
      previous_auth_worker_revision="$(docker inspect --format \
        '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
        "$previous_auth_worker_container")"
    fi
  fi
  [[ "$previous_auth_worker_was_running" == "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" ]] \
    || fail "the pre-cutover authentication-worker runtime does not match its reviewed gate"
  if [[ "$previous_auth_worker_was_running" == true ]]; then
    [[ "$previous_auth_worker_image_id" =~ ^sha256:[a-f0-9]{64}$ \
      && "$previous_auth_worker_revision" == "$previous_app_revision" \
      && "$(docker image inspect --format '{{.Id}}' \
        "$previous_auth_worker_image_id")" == "$previous_auth_worker_image_id" ]] \
      || fail "the pre-cutover authentication worker is not the retained immutable release"
  fi
  [[ "$previous_app_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "the previous app has no immutable image ID"
  [[ "$previous_app_revision" =~ ^[a-f0-9]{40}$ && ! "$previous_app_revision" =~ ^0+$ ]] || fail "the previous app has no full OCI revision"
  [[ "$(docker image inspect --format '{{.Id}}' "$previous_app_id")" == "$previous_app_id" ]] || fail "the previous application image is not retained locally"
  git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    cat-file -e "$previous_app_revision^{commit}" 2>/dev/null \
    || fail "the previous deployed revision is not a local Git commit"
  if [[ "$scheduler_boundary_bootstrap_required" == "true" ]]; then
    [[ "$scheduler_boundary_bootstrap_source_revision" == "$previous_app_revision" ]] \
      || fail "pre-checkout scheduler bootstrap source does not match the deployed application revision"
    current_scheduler_receipt_sha256="$(checked_file_sha256 \
      "$scheduler_boundary_bootstrap_receipt")" \
      || fail "protected scheduler-boundary bootstrap receipt could not be hashed"
    [[ "$current_scheduler_receipt_sha256" \
      == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
      || fail "the protected scheduler-boundary bootstrap receipt changed during release"
  fi
  if [[ "$scheduler_mode" == cron ]]; then
    previous_cron_schedule_file="$(mktemp)"
    git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
      show "$previous_app_revision:deploy/cron/managed-crontab" \
      >"$previous_cron_schedule_file" \
      || fail "the previous deployed revision has no reviewable managed cron schedule"
    chmod 0600 -- "$previous_cron_schedule_file"
  fi
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

if [[ "$mode" == "initial" || "$mode" == "rehearsal" ]]; then
  if [[ "$mode" == "initial" ]]; then
    stage="initial-evidence-scanner-bootstrap"
  else
    stage="rehearsal-evidence-scanner-bootstrap"
  fi
  run_logged 13-evidence-scanner-start.log compose_timed 15m up --detach --wait \
    --no-build --force-recreate evidence_scanner
  run_logged 14-evidence-scanner-attestation.log attest_evidence_scanner
  if [[ "$mode" == "initial" ]]; then
    stage="initial-evidence-scanner-eicar-boundary"
  else
    stage="rehearsal-evidence-scanner-eicar-boundary"
  fi
  run_logged 15-evidence-scanner-eicar.log probe_evidence_scanner
  write_checkpoint 16-evidence-scanner-eicar.json evidence-scanner-eicar-boundary-passed
fi

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

disable_and_verify_initial_schedule() {
  [[ "$mode" == "initial" && "$scheduler_mode" == "systemd" ]] \
    || fail "disabled initial schedule verification was requested outside initial systemd mode"
  local unit_name enabled_state active_state enabled_status active_status
  local -a timer_units=(
    business-finlynq-backup.timer
    business-finlynq-monitor.timer
    business-finlynq-accounting-evidence.timer
    business-finlynq-demo-reconcile.timer
  )
  local -a service_units=(
    business-finlynq-backup.service
    business-finlynq-monitor.service
    business-finlynq-accounting-evidence.service
    business-finlynq-demo-reconcile.service
  )

  systemctl disable --now "${timer_units[@]}"
  for unit_name in "${timer_units[@]}"; do
    enabled_state=""; enabled_status=0
    if enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"; then
      enabled_status=0
    else
      enabled_status=$?
    fi
    [[ "$enabled_status" == "1" && "$enabled_state" == "disabled" ]] \
      || fail "initial scheduled timer is not exactly disabled: $unit_name"
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    [[ "$active_status" == "3" && "$active_state" == "inactive" ]] \
      || fail "initial scheduled timer is not exactly inactive: $unit_name"
  done
  for unit_name in "${service_units[@]}"; do
    active_state=""; active_status=0
    if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
      active_status=0
    else
      active_status=$?
    fi
    [[ "$active_status" == "3" && "$active_state" == "inactive" ]] \
      || fail "initial scheduled service is not quiescent: $unit_name"
  done
  printf '%s\n' "All four production operation timers are installed, disabled, and inactive."
}

run_fresh_systemd_oneshot() {
  local service_name="$1" description="$2"
  local active_state active_status
  case "$service_name" in
    business-finlynq-accounting-evidence.service|business-finlynq-monitor.service) ;;
    *) fail "release acceptance requested an unsupported systemd service" ;;
  esac
  # systemd 259 clears InvocationID and ExecMain*TimestampMonotonic when a
  # Type=oneshot unit without RemainAfterExit returns to inactive. The caller
  # removes the prior metric first and validates a newly written, timestamped,
  # success metric after this synchronous start; that durable output is the
  # cross-version proof that this exact invocation ran successfully.
  systemctl start "$service_name" \
    || fail "$description could not be started"
  active_state=""; active_status=0
  if active_state="$(systemctl is-active "$service_name" 2>/dev/null)"; then
    active_status=0
  else
    active_status=$?
  fi
  [[ "$active_status" == "3" && "$active_state" == "inactive" ]] \
    || fail "$description did not return to the expected inactive one-shot state"
  printf 'Started %s; durable metric verification follows.\n' "$service_name"
}

verify_fresh_cron_job_status() {
  local job_name="$1" started_at="$2"
  local deploy_uid status_directory status_file completed_at now accepted_timestamp
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
  accepted_timestamp="$(checked_utc_timestamp)" \
    || fail "cron completion acceptance timestamp could not be generated"
  printf 'Cron %s completion record accepted at %s (completedAt=%s).\n' \
    "$job_name" "$accepted_timestamp" "$completed_at"
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
  local router_mode="${1:-strict}" started_at completed_timestamp
  [[ "$router_mode" == strict || "$router_mode" == transitional-maintenance ]] \
    || fail "monitor acceptance requested an invalid router-mode policy"
  if [[ "$scheduler_mode" == "cron" && "$router_mode" == strict ]]; then
    clear_cron_job_status monitor
  fi
  clear_release_metric_file MONITOR_METRICS_FILE /var/lib/business-finlynq/host.prom \
    "host-monitor metric"
  started_at="$(date +%s)"
  [[ "$started_at" =~ ^[1-9][0-9]*$ ]] \
    || fail "monitor acceptance start time is invalid"
  if [[ "$router_mode" == transitional-maintenance ]]; then
    # The scheduled monitor intentionally remains strict. During final release
    # acceptance only, invoke the reviewed implementation directly so it can
    # attest the live candidate while the restart sentinel is still
    # maintenance; its freshly replaced metric is verified below unchanged.
    (
      cd -- "$repository_root"
      runuser -u deploy -- bash "$repository_root/deploy/monitoring/check-production.sh" \
        --allow-transitional-router-maintenance
    )
  elif [[ "$scheduler_mode" == "systemd" ]]; then
    run_fresh_systemd_oneshot business-finlynq-monitor.service \
      "the resumed systemd monitor"
  else
    bash "$repository_root/deploy/cron/run-job.sh" monitor
    verify_fresh_cron_job_status monitor "$started_at"
  fi
  verify_fresh_host_monitor_metrics "$started_at"
  completed_timestamp="$(checked_utc_timestamp)" \
    || fail "monitor acceptance timestamp could not be generated"
  printf 'Installed %s monitor acceptance completed at %s.\n' \
    "$scheduler_mode" "$completed_timestamp"
}

run_installed_accounting_evidence() {
  local started_at completed_timestamp
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
  completed_timestamp="$(checked_utc_timestamp)" \
    || fail "accounting-evidence acceptance timestamp could not be generated"
  printf 'Installed %s accounting-evidence seed completed at %s.\n' \
    "$scheduler_mode" "$completed_timestamp"
}

record_scheduler_boundary_version() {
  local deploy_uid lock_directory boundary_file temporary_file accepted_at
  deploy_uid="$(id -u deploy)"
  lock_directory="/home/deploy/.local/state/business-finlynq/release-locks"
  boundary_file="$lock_directory/scheduler-boundary.json"
  [[ ! -L "$boundary_file" \
    && ( ! -e "$boundary_file" \
      || ( -f "$boundary_file" && "$(stat -c '%u:%a' -- "$boundary_file")" == "$deploy_uid:600" ) ) ]] \
    || fail "installed scheduler boundary record became unsafe"
  accepted_at="$(checked_utc_timestamp)" \
    || fail "scheduler-boundary timestamp could not be generated"
  temporary_file="$(mktemp "$lock_directory/.scheduler-boundary.XXXXXX")"
  jq -n \
    --arg product business-finlynq \
    --arg installedRevision "$revision" \
    --arg scheduler "$scheduler_mode" \
    --arg acceptedAt "$accepted_at" \
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
    current_scheduler_receipt_sha256="$(checked_file_sha256 \
      "$scheduler_boundary_bootstrap_receipt")" \
      || fail "scheduler-boundary bootstrap receipt could not be hashed before acceptance"
    [[ "$current_scheduler_receipt_sha256" \
      == "$scheduler_boundary_bootstrap_receipt_sha256" ]] \
      || fail "the scheduler-boundary bootstrap receipt changed before acceptance"
    rm -- "$scheduler_boundary_bootstrap_receipt"
    sync -f -- "$lock_directory"
    [[ ! -e "$scheduler_boundary_bootstrap_receipt" \
      && ! -L "$scheduler_boundary_bootstrap_receipt" ]] \
      || fail "accepted scheduler-boundary bootstrap receipt could not be retired"
  fi
}

verify_unique_network_alias_owner() {
  local network="$1" alias="$2" expected_container="$3" description="$4"
  local expected_full_id network_query container networks owner_count=0
  expected_full_id="$(docker inspect --format '{{.Id}}' "$expected_container")" \
    || fail "$description expected container identity could not be inspected"
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$description expected container identity is invalid"
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}')" \
    || fail "$description network endpoints could not be enumerated"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] \
      || fail "$description network returned an invalid endpoint ID"
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container")" \
      || fail "$description network endpoint could not be inspected"
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
      [[ "$container" == "$expected_full_id" ]] \
        || fail "$description alias is owned by another network endpoint"
    fi
  done <<<"$network_query"
  [[ "$owner_count" == 1 ]] \
    || fail "$description alias must be owned exactly once on $network"
}

verify_release_router_runtime() {
  local evidence_file="$1" router_container router_runtime router_state_mode verified_at

  capture_compose_container_id "running release-router container" ps --quiet release_router
  router_container="$captured_compose_container_id"
  read_docker_output "release-router runtime contract" inspect \
    --format '{"imageId":{{json .Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"contract":{{json (index .Config.Labels "com.business-finlynq.release-router.contract")}},"user":{{json .Config.User}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"init":{{json .HostConfig.Init}},"status":{{json .State.Status}},"healthy":{{json .State.Health.Status}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}}}' \
    "$router_container"
  router_runtime="$docker_query_output"
  jq -e \
    --arg imageId "${image_ids[router]}" \
    --arg revision "$release_router_revision" \
    --arg contract "$release_router_contract" \
    --arg frontendNetwork "$router_frontend_network_name" \
    --arg controlNetwork "$router_control_network_name" \
    --arg edgeNetwork "$router_edge_network_name" \
    --arg stateVolume "$router_state_volume_name" \
    --arg publicAlias "$router_public_alias" \
    --arg port "$app_port" '
      type == "object" and
      .imageId == $imageId and .revision == $revision and .contract == $contract and
      .user == "10001:10001" and .readOnly == true and .init == true and
      .status == "running" and .healthy == "healthy" and
      (.capDrop | sort) == ["ALL"] and
      (.securityOpt | index("no-new-privileges:true")) != null and
      (.mounts | length) == 1 and
      .mounts[0].Type == "volume" and .mounts[0].Name == $stateVolume and
      .mounts[0].Destination == "/state" and .mounts[0].RW == true and
      (.tmpfs | keys | sort) == ["/config", "/data", "/tmp"] and
      (.portBindings["3000/tcp"] | length) == 1 and
      .portBindings["3000/tcp"][0].HostIp == "127.0.0.1" and
      .portBindings["3000/tcp"][0].HostPort == $port and
      (.networks | keys | sort) ==
        ([$controlNetwork, $edgeNetwork, $frontendNetwork] | sort) and
      (.networks[$edgeNetwork].Aliases | index($publicAlias)) != null and
      .entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
      .command == ["serve"]
    ' <<<"$router_runtime" >/dev/null \
    || fail "running release router differs from the immutable hardened contract"
  verify_unique_network_alias_owner \
    "$router_edge_network_name" "$router_public_alias" "$router_container" \
    "release-router public backend"
  read_docker_output "release-router durable mode" exec "$router_container" sh -ec '
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  '
  router_state_mode="$docker_query_output"
  [[ "$router_state_mode" == active || "$router_state_mode" == maintenance ]] \
    || fail "release-router durable mode is invalid"
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$app_port/_business-finlynq/release-router/live" \
    | jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' >/dev/null \
    || fail "release-router process liveness contract failed"
  verified_at="$(checked_utc_timestamp)" \
    || fail "release-router verification timestamp could not be generated"
  jq -n \
    --arg at "$verified_at" \
    --arg containerId "$router_container" \
    --arg imageId "${image_ids[router]}" \
    --arg revision "$release_router_revision" \
    --arg contract "$release_router_contract" \
    --arg configSha256 "$router_config_sha256" \
    --arg publicAlias "$router_public_alias" \
    --arg frontendNetwork "$router_frontend_network_name" \
    --arg controlNetwork "$router_control_network_name" \
    --arg edgeNetwork "$router_edge_network_name" \
    --arg stateVolume "$router_state_volume_name" \
    --arg stateMode "$router_state_mode" \
    '{schemaVersion: 1, product: "business-finlynq", verifiedAt: $at,
      service: "release_router", containerId: $containerId, imageId: $imageId,
      revision: $revision, contractVersion: $contract, configSha256: $configSha256,
      processHealth: "healthy", durableStateVolume: $stateVolume,
      durableMode: $stateMode, publicAlias: $publicAlias,
      networks: ([$controlNetwork, $edgeNetwork, $frontendNetwork] | sort)}' \
    >"$evidence_directory/$evidence_file"
  chmod 0600 -- "$evidence_directory/$evidence_file"
}

release_router_container_id=""
resolve_release_router_container() {
  local query
  query="$(compose ps --all --quiet release_router)" \
    || fail "release-router container inventory could not be read"
  [[ -z "$query" || ( "$query" =~ ^[a-f0-9]{12,64}$ && "$query" != *$'\n'* ) ]] \
    || fail "release-router container inventory is ambiguous"
  release_router_container_id="$query"
}

persist_release_router_mode() {
  local mode="$1"
  [[ "$mode" == active || "$mode" == maintenance ]] \
    || fail "release-router durable mode requested an invalid value"
  resolve_release_router_container
  [[ -n "$release_router_container_id" ]] \
    || fail "release-router durable mode requested without a container"
  docker exec "$release_router_container_id" sh -ec '
    set -eu
    mode="$1"
    [[ "$mode" == active || "$mode" == maintenance ]]
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    temporary="/state/.mode.$$"
    trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
    printf "%s\n" "$mode" >"$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" /state/mode
    sync /state/mode 2>/dev/null || sync
    sync -f /state 2>/dev/null || sync
    trap - EXIT INT TERM
    [[ -f /state/mode && ! -L /state/mode \
      && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 \
      && "$(cat /state/mode)" == "$mode" ]]
  ' sh "$mode" || fail "release-router durable mode could not be committed"
}

reload_release_router_configuration() {
  local selected_config="$1"
  [[ "$selected_config" == Caddyfile || "$selected_config" == Caddyfile.maintenance ]] \
    || fail "release-router reload requested an unknown configuration"
  resolve_release_router_container
  [[ -n "$release_router_container_id" ]] \
    || fail "release-router reload requested without a container"
  if [[ "$selected_config" == Caddyfile.maintenance ]]; then
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
      || fail "release-router maintenance token is unavailable"
    docker exec --env \
      "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$release_acceptance_token" \
      "$release_router_container_id" caddy reload \
      --config "/etc/caddy/$selected_config" --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock
  else
    docker exec "$release_router_container_id" caddy reload \
      --config "/etc/caddy/$selected_config" --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock
  fi
}

verify_release_router_maintenance() {
  local live_body="$evidence_directory/28-release-router-live.json"
  local health_headers="$evidence_directory/28-release-router-maintenance.headers"
  local health_body="$evidence_directory/28-release-router-maintenance.json"
  local route_headers="$evidence_directory/28-release-router-route.headers"
  local route_body="$evidence_directory/28-release-router-route.txt"
  local live_status="" health_status="" route_status="" attempt

  for attempt in {1..15}; do
    live_status=""
    if live_status="$(curl --silent --show-error --max-time 5 \
      --header "X-Request-Id: release-maintenance-$run_id" \
      --output "$live_body" --write-out '%{http_code}' \
      "$public_base_url/api/live")" \
      && [[ "$live_status" == "200" ]] \
      && jq -e 'type == "object" and keys == ["status"] and .status == "live"' \
        "$live_body" >/dev/null; then
      break
    fi
    sleep 2
  done
  [[ "$live_status" == "200" ]] \
    || fail "release router did not keep public liveness available during maintenance"

  health_status="$(curl --silent --show-error --max-time 10 \
    --header "X-Request-Id: release-maintenance-$run_id" \
    --dump-header "$health_headers" --output "$health_body" --write-out '%{http_code}' \
    "$public_base_url/api/health")" \
    || fail "release-router maintenance response could not be reached"
  [[ "$health_status" == "503" ]] \
    || fail "release-router maintenance response must be HTTP 503"
  jq -e 'type == "object" and keys == ["status"] and .status == "unavailable"' \
    "$health_body" >/dev/null \
    || fail "release-router maintenance readiness body is invalid"
  grep -Eiq '^cache-control:.*no-store' "$health_headers" \
    || fail "release-router maintenance response is cacheable"
  grep -Eiq '^retry-after:[[:space:]]*5[[:space:]]*$' "$health_headers" \
    || fail "release-router maintenance response lacks its bounded retry advice"

  route_status="$(curl --silent --show-error --max-time 10 \
    --header "X-Request-Id: release-maintenance-$run_id" \
    --dump-header "$route_headers" --output "$route_body" --write-out '%{http_code}' \
    "$public_base_url/")" \
    || fail "release-router public maintenance route could not be reached"
  [[ "$route_status" == "503" \
    && "$(tr -d '\r' <"$route_body")" == "Service temporarily unavailable.\\n" ]] \
    || fail "release router did not block public application traffic"
  grep -Eiq '^cache-control:.*no-store' "$route_headers" \
    || fail "release-router public maintenance route is cacheable"
  grep -Eiq '^retry-after:[[:space:]]*5[[:space:]]*$' "$route_headers" \
    || fail "release-router public maintenance route lacks retry advice"
  chmod 0600 -- "$live_body" "$health_headers" "$health_body" "$route_headers" "$route_body"
}

enter_release_router_maintenance() {
  [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
    || fail "release acceptance token is unavailable or invalid"
  # Persist the fail-closed restart choice before changing the live process.
  persist_release_router_mode maintenance
  reload_release_router_configuration Caddyfile.maintenance
  verify_release_router_maintenance
  router_maintenance_confirmed="true"
  router_active_confirmed="false"
}

activate_release_router_live() {
  # Keep durable maintenance throughout every final acceptance gate. A host or
  # daemon restart before the terminal evidence is sealed therefore remains
  # fail-closed even though the already-running Caddy process serves the
  # candidate for public verification.
  reload_release_router_configuration Caddyfile
}

commit_release_router_active() {
  # This atomic sentinel rename is the last acceptance commit. The terminal
  # evidence already authorizes exact recovery if power is lost immediately
  # before this write; no unaccepted candidate can restart active.
  persist_release_router_mode active
  router_active_confirmed="true"
  router_maintenance_confirmed="false"
}

wait_for_router_upstream_drain() {
  local connection_count="" attempt drained_at
  for attempt in {1..60}; do
    resolve_release_router_container
    [[ -n "$release_router_container_id" ]] \
      || fail "release router disappeared during upstream drain"
    connection_count="$(docker exec "$release_router_container_id" sh -ec '
      awk '\''$4 == "01" && $3 ~ /:0BB8$/ { count++ } END { print count + 0 }'\'' \
        /proc/net/tcp /proc/net/tcp6
    ')" || fail "release-router upstream drain could not be inspected"
    [[ "$connection_count" =~ ^[0-9]+$ ]] \
      || fail "release-router upstream drain returned an invalid count"
    [[ "$connection_count" == 0 ]] && break
    sleep 1
  done
  [[ "$connection_count" == 0 ]] \
    || fail "in-flight release-router application requests did not drain"
  drained_at="$(checked_utc_timestamp)" \
    || fail "router-drain timestamp could not be generated"
  jq -n --arg at "$drained_at" \
    '{schemaVersion: 1, product: "business-finlynq", verifiedAt: $at,
      upstream: "release-app:3000", establishedConnections: 0}' \
    >"$evidence_directory/24-router-upstream-drain.json"
  chmod 0600 -- "$evidence_directory/24-router-upstream-drain.json"
}

wait_for_application_database_disconnect() {
  local session_count="" attempt disconnected_at
  for attempt in {1..60}; do
    session_count="$(compose exec -T database sh -ec '
      export PGPASSWORD="$POSTGRES_PASSWORD"
      exec psql --no-psqlrc -X -A -t -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND backend_type = '\''client backend'\'';"
    ')" || fail "database client-session drain could not be inspected"
    [[ "$session_count" =~ ^[0-9]+$ ]] \
      || fail "database client-session drain returned an invalid count"
    [[ "$session_count" == 0 ]] && break
    sleep 1
  done
  [[ "$session_count" == 0 ]] \
    || fail "database client sessions did not fully drain before the recovery point"
  disconnected_at="$(checked_utc_timestamp)" \
    || fail "database-disconnect timestamp could not be generated"
  jq -n --arg at "$disconnected_at" \
    '{schemaVersion: 1, product: "business-finlynq", verifiedAt: $at,
      scope: "all-client-backends-in-application-database", remainingSessions: 0}' \
    >"$evidence_directory/24-database-session-disconnect.json"
  chmod 0600 -- "$evidence_directory/24-database-session-disconnect.json"
}

# A normal application release reuses the already-running, separately
# versioned router. Absence is accepted only for the one-time legacy rollout,
# an initial install/resume, or an isolated rehearsal.
resolve_release_router_container
if [[ "$mode" == "release" && "$edge_mode" == "external" ]]; then
  stage="pre-cutover-external-edge"
  if [[ "$first_router_forward_repair_resume" == true ]]; then
    pre_cutover_edge_arguments=(
      --scope production --warmup-host production
      --expected-production-revision "$revision"
      --allow-first-router-forward-repair "$first_router_recovery_journal_sha256"
    )
  else
    pre_cutover_edge_arguments=(
      --scope production --warmup-host production
      --expected-production-revision "$previous_app_revision"
    )
    if [[ -z "$release_router_container_id" ]]; then
      pre_cutover_edge_arguments+=(--allow-pre-router-production)
    elif [[ "$previous_app_revision" == "$legacy_f8485_revision" ]]; then
      pre_cutover_edge_arguments+=(--allow-f8485-minimal-production-health)
    fi
  fi
  run_logged 19-pre-cutover-external-edge.log \
    bash "$candidate_source_root/deploy/edge/verify-external-edge.sh" \
      "${pre_cutover_edge_arguments[@]}"
fi

if [[ -n "$release_router_container_id" ]]; then
  router_was_preexisting="true"
  verify_release_router_runtime 19-pre-cutover-release-router-runtime.json
fi

if [[ "$mode" == "release" ]]; then
  stage="pause-schedulers"
  scheduler_pause_attempted="true"
  run_logged 20-pause-schedulers.log pause_schedulers
  schedulers_paused="true"
  write_checkpoint 21-schedulers-paused.json schedulers-paused
  if [[ "$scheduler_mode" == "cron" ]]; then
    previous_schedule_sha256="$(checked_file_sha256 "$previous_cron_schedule_file")" \
      || fail "previous cron schedule checksum could not be read"
    candidate_schedule_sha256="$(checked_file_sha256 \
      "$candidate_source_root/deploy/cron/managed-crontab")" \
      || fail "candidate cron schedule checksum could not be read"
    jq -n \
      --arg previousRevision "$previous_app_revision" \
      --arg previousScheduleSha256 "$previous_schedule_sha256" \
      --arg candidateRevision "$revision" \
      --arg candidateScheduleSha256 "$candidate_schedule_sha256" \
      '{schemaVersion: 1, previousRevision: $previousRevision, previousScheduleSha256: $previousScheduleSha256, candidateRevision: $candidateRevision, candidateScheduleSha256: $candidateScheduleSha256, previousScheduleRemoved: true}' \
      >"$evidence_directory/22-cron-schedule-transition.json"
    chmod 0600 -- "$evidence_directory/22-cron-schedule-transition.json"
  fi
fi

stage="stop-write-surfaces"
stop_write_surfaces() {
  if [[ "$mode" == "release" ]]; then
    # The recovery point must cover every mutation accepted by the old release.
    # Quiesce the delivery worker first. On all post-bootstrap releases the
    # router is already holding new public requests in maintenance while the
    # app finishes any active database transaction.
    compose --profile auth-email stop --timeout 60 auth_email_worker
    if [[ "$router_was_preexisting" == "true" ]]; then
      wait_for_router_upstream_drain
    fi
    compose stop --timeout 60 app
    wait_for_application_database_disconnect
  fi
  read_compose_output "running application write surface" ps --status running --quiet app
  [[ -z "$compose_query_output" ]] || fail "application write surface is still running"
  read_compose_output "running authentication-worker write surface" \
    --profile auth-email ps --status running --quiet auth_email_worker
  [[ -z "$compose_query_output" ]] || fail "authentication worker is still running"
  write_surfaces_stopped="true"
  printf '%s\n' "Application and authentication-worker write surfaces are stopped."
}

detach_previous_app_public_edge() {
  local attachment
  [[ "$mode" == release && "$router_was_preexisting" != true \
    && "$previous_container" =~ ^[a-f0-9]{12,64}$ \
    && "$router_edge_network_name" == business_finlynq_edge \
    && "$router_public_alias" == production-app ]] || return 1
  [[ "$(docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null)" \
    == "$previous_app_id" \
    && "$(docker inspect --format '{{.State.Running}}' "$previous_container" 2>/dev/null)" \
    == false ]] || return 1
  attachment="$(docker inspect --format \
    '{{json (index .NetworkSettings.Networks "business_finlynq_edge")}}' \
    "$previous_container" 2>/dev/null)" || return 1
  jq -e --arg alias "$router_public_alias" '
    type == "object" and any(.Aliases[]?; . == $alias)
  ' <<<"$attachment" >/dev/null || return 1
  # Arm recovery before the mutating Docker call. The recovery path inspects the
  # real attachment, so interruption between disconnect and return is safe.
  previous_app_public_edge_detached="true"
  docker network disconnect --force "$router_edge_network_name" "$previous_container"
  [[ "$(docker inspect --format \
    '{{if index .NetworkSettings.Networks "business_finlynq_edge"}}attached{{end}}' \
    "$previous_container" 2>/dev/null)" == "" ]] || return 1
}

cleanup_failed_backup_service_containers() {
  local service_name="$1" container_id query_output=""
  local -a backup_containers=()
  [[ "$service_name" == backup || "$service_name" == verify_latest_backup ]] \
    || fail "backup failure containment received an unexpected service"
  if ! query_output="$(timeout --signal=TERM --kill-after=5s 30s \
    env -i "PATH=$PATH" docker ps --all --quiet \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter "label=com.docker.compose.service=$service_name")"; then
    return 1
  fi
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] \
      || fail "Docker returned an invalid backup container ID during containment"
    backup_containers+=("$container_id")
  done <<<"$query_output"
  (( ${#backup_containers[@]} > 0 )) || return 0
  timeout --signal=TERM --kill-after=5s 2m env -i "PATH=$PATH" \
    docker rm --force -- "${backup_containers[@]}" >/dev/null 2>&1 \
    || return 1
  if ! query_output="$(timeout --signal=TERM --kill-after=5s 30s \
    env -i "PATH=$PATH" docker ps --all --quiet \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter "label=com.docker.compose.service=$service_name")"; then
    return 1
  fi
  [[ -z "$query_output" ]]
}

cleanup_failed_backup_containers() {
  cleanup_failed_backup_service_containers backup
}

cleanup_failed_backup_verifier_containers() {
  cleanup_failed_backup_service_containers verify_latest_backup
}

run_backup() (
  local timeout_seconds="${1:-$release_backup_timeout_seconds}" backup_status=0
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$timeout_seconds" -le 5400 ]] \
    || fail "release backup timeout is outside the reviewed envelope"
  if compose_timed_with_overrides "${timeout_seconds}s" \
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

capture_backup_manifest_from_log() {
  local log_filename="$1" result_records="" result_json="" backup_manifest_basename=""
  local -a result_lines=()
  [[ "$log_filename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]log$ \
    && -f "$evidence_directory/$log_filename" \
    && ! -L "$evidence_directory/$log_filename" ]] \
    || fail "backup producer log is missing or unsafe"
  result_records="$(sed -n 's/^BUSINESS_FINLYNQ_BACKUP_RESULT=//p' \
    "$evidence_directory/$log_filename")" \
    || fail "backup producer result could not be extracted"
  [[ -n "$result_records" ]] \
    || fail "backup producer did not emit exactly one committed result"
  mapfile -t result_lines <<<"$result_records"
  (( ${#result_lines[@]} == 1 )) \
    || fail "backup producer did not emit exactly one committed result"
  result_json="${result_lines[0]}"
  backup_manifest_basename="$(jq -er '
    if type == "object" and
      keys == ["manifestBasename", "product", "schemaVersion"] and
      .schemaVersion == 1 and .product == "business-finlynq" and
      (.manifestBasename | type == "string" and
        test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.manifest\\.json$"))
    then .manifestBasename
    else error("invalid backup producer result")
    end
  ' <<<"$result_json")" \
    || fail "backup producer emitted an invalid committed result"
  [[ "$backup_manifest_basename" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+[.]manifest[.]json$ ]] \
    || fail "backup producer emitted an unsafe manifest basename"
  printf '%s' "$backup_manifest_basename"
}

verify_backup_and_record_evidence() {
  local manifest_basename="$1"
  local evidence_filename="${2:-33-backup-evidence.json}"
  local workflow_deadline_seconds="$3"
  local verifier_output evidence_records evidence_json verifier_timeout_seconds verifier_status=0
  local -a evidence_lines=()
  [[ "$manifest_basename" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+[.]manifest[.]json$ ]] \
    || fail "exact backup manifest basename is unsafe"
  [[ "$evidence_filename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]json$ ]] \
    || fail "immutable backup evidence filename is unsafe"
  if ! verifier_timeout_seconds="$(remaining_backup_workflow_seconds \
    "$workflow_deadline_seconds")"; then
    cleanup_failed_backup_verifier_containers \
      || fail "expired backup verifier container could not be contained and removed"
    printf '%s\n' "Backup verification exceeded the shared producer/verifier deadline." >&2
    return 124
  fi
  if verifier_output="$(compose_timed "${verifier_timeout_seconds}s" \
    --profile operations run --rm --no-deps -T \
    verify_latest_backup \
    /usr/local/bin/business-finlynq-check-latest-backup \
      --manifest-basename "$manifest_basename" --emit-evidence 2>&1)"; then
    verifier_status=0
  else
    verifier_status=$?
  fi
  if (( verifier_status != 0 )); then
    printf '%s\n' "$verifier_output"
    cleanup_failed_backup_verifier_containers \
      || fail "failed backup verifier container could not be contained and removed"
    return "$verifier_status"
  fi
  printf '%s\n' "$verifier_output"
  evidence_records="$(printf '%s\n' "$verifier_output" \
    | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p')" \
    || fail "immutable backup evidence lines could not be extracted"
  [[ -n "$evidence_records" ]] \
    || fail "immutable backup verifier did not emit exactly one evidence record"
  mapfile -t evidence_lines <<<"$evidence_records"
  (( ${#evidence_lines[@]} == 1 )) \
    || fail "immutable backup verifier did not emit exactly one evidence record"
  evidence_json="${evidence_lines[0]}"
  jq -e --arg sourceRevision "$backup_source_revision" --arg toolRevision "$revision" \
    --arg manifestBasename "$manifest_basename" '
    type == "object" and
    keys == ["applicationRevision", "backupToolRevision", "createdAt",
      "encryptedArchive", "encryptedBytes", "encryption", "format",
      "manifestBasename", "product", "schemaVersion", "sha256",
      "sourceApplicationRevision"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .applicationRevision == $sourceRevision and
    .sourceApplicationRevision == $sourceRevision and
    .backupToolRevision == $toolRevision and
    .manifestBasename == $manifestBasename and
    .encryption == "age" and .format == "postgres-custom" and
    (.createdAt | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.encryptedArchive | type == "string" and
      test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.dump\\.age$")) and
    .encryptedArchive == ($manifestBasename | sub("\\.manifest\\.json$"; ".dump.age")) and
    (.encryptedBytes | type == "number" and . == floor and . > 0) and
    (.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' <<<"$evidence_json" >/dev/null \
    || fail "immutable backup verifier emitted invalid release evidence"
  jq '.' <<<"$evidence_json" >"$evidence_directory/$evidence_filename" \
    || fail "immutable backup evidence could not be written"
  chmod 0600 -- "$evidence_directory/$evidence_filename" \
    || fail "immutable backup evidence permissions could not be set"
}

remaining_backup_workflow_seconds() {
  local workflow_deadline_seconds="$1" remaining_seconds
  [[ "$workflow_deadline_seconds" =~ ^[1-9][0-9]*$ ]] \
    || fail "backup workflow deadline is invalid"
  remaining_seconds=$((workflow_deadline_seconds - SECONDS))
  (( remaining_seconds > 0 )) || return 124
  printf '%s' "$remaining_seconds"
}

run_backup_before_deadline() {
  local workflow_deadline_seconds="$1" remaining_seconds
  remaining_seconds="$(remaining_backup_workflow_seconds \
    "$workflow_deadline_seconds")" || return $?
  run_backup "$remaining_seconds"
}

run_verified_backup_workflow() {
  local timeout_seconds="$1" producer_log="$2" verifier_log="$3"
  local evidence_filename="${4:-33-backup-evidence.json}"
  local workflow_deadline_seconds backup_manifest_basename=""
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$timeout_seconds" -le 5400 ]] \
    || fail "verified backup workflow timeout is outside the reviewed envelope"
  [[ "$producer_log" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]log$ \
    && "$verifier_log" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]log$ ]] \
    || fail "verified backup workflow log filename is unsafe"

  # This coordinator intentionally runs in the parent shell. `run_logged`
  # isolates each command, while the exact manifest parsed after the producer
  # remains parent-owned and is passed explicitly to the verifier. Both Docker
  # phases consume one absolute deadline rather than receiving independent caps.
  workflow_deadline_seconds=$((SECONDS + timeout_seconds))
  run_logged "$producer_log" run_backup_before_deadline "$workflow_deadline_seconds"
  backup_manifest_basename="$(capture_backup_manifest_from_log "$producer_log")" \
    || fail "exact backup manifest identity could not be captured"
  run_logged "$verifier_log" verify_backup_and_record_evidence \
    "$backup_manifest_basename" "$evidence_filename" "$workflow_deadline_seconds"
}

release_recovery_lsn=""
release_recovery_system_identifier=""
release_recovery_timeline_id=""
release_recovery_database=""
release_recovery_unlogged_relations=""
release_recovery_prepared_transactions=""
release_recovery_sequences=""
release_recovery_foreign_tables=""
release_recovery_active_client_transactions=""
read_release_database_recovery_boundary() {
  local boundary="" extra=""
  boundary="$(compose exec -T database sh -ec '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql --no-psqlrc -X -A -t -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "SELECT concat_ws(chr(124), pg_current_wal_insert_lsn()::text, (SELECT system_identifier::text FROM pg_control_system()), (SELECT timeline_id::text FROM pg_control_checkpoint()), current_database(), (SELECT count(*)::text FROM pg_class WHERE relpersistence = chr(117)), (SELECT count(*)::text FROM pg_prepared_xacts WHERE database = current_database()), (SELECT count(*)::text FROM pg_class WHERE ascii(relkind::text) = 83), (SELECT count(*)::text FROM pg_class WHERE ascii(relkind::text) = 102), (SELECT count(*)::text FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND backend_type = concat(chr(99), chr(108), chr(105), chr(101), chr(110), chr(116), chr(32), chr(98), chr(97), chr(99), chr(107), chr(101), chr(110), chr(100)) AND xact_start IS NOT NULL));"
  ')" || fail "database recovery boundary could not be inspected"
  IFS='|' read -r release_recovery_lsn release_recovery_system_identifier \
    release_recovery_timeline_id release_recovery_database \
    release_recovery_unlogged_relations release_recovery_prepared_transactions \
    release_recovery_sequences release_recovery_foreign_tables \
    release_recovery_active_client_transactions extra <<<"$boundary"
  release_recovery_lsn="${release_recovery_lsn^^}"
  [[ -z "$extra" && "$release_recovery_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ \
    && "$release_recovery_system_identifier" =~ ^[1-9][0-9]+$ \
    && "$release_recovery_timeline_id" =~ ^[1-9][0-9]*$ \
    && "$release_recovery_database" == business_finlynq \
    && "$release_recovery_unlogged_relations" =~ ^[0-9]+$ \
    && "$release_recovery_prepared_transactions" =~ ^[0-9]+$ \
    && "$release_recovery_sequences" =~ ^[0-9]+$ \
    && "$release_recovery_foreign_tables" =~ ^[0-9]+$ \
    && "$release_recovery_active_client_transactions" =~ ^[0-9]+$ ]] \
    || fail "database recovery boundary identity or sanitized relation counts are invalid"
}

release_recovery_boundary_supports_online_reuse() {
  [[ "$release_recovery_unlogged_relations" == 0 \
    && "$release_recovery_prepared_transactions" == 0 \
    && "$release_recovery_sequences" == 0 \
    && "$release_recovery_foreign_tables" == 0 \
    && "$release_recovery_active_client_transactions" == 0 ]]
}

write_release_database_recovery_sample() {
  local filename="$1" phase="$2" lsn="$3" system_identifier="$4"
  local timeline_id="$5" database_name="$6" container_id="$7"
  local unlogged_relations="$8" prepared_transactions="$9"
  local sequence_relations="${10}" foreign_tables="${11}"
  local active_client_transactions="${12}" recorded_at=""
  [[ "$filename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]json$ \
    && "$phase" =~ ^[a-z][a-z0-9-]*$ \
    && "$lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ \
    && "$system_identifier" =~ ^[1-9][0-9]+$ \
    && "$timeline_id" =~ ^[1-9][0-9]*$ \
    && "$database_name" == business_finlynq \
    && "$container_id" =~ ^[a-f0-9]{12,64}$ \
    && "$unlogged_relations" =~ ^[0-9]+$ \
    && "$prepared_transactions" =~ ^[0-9]+$ \
    && "$sequence_relations" =~ ^[0-9]+$ \
    && "$foreign_tables" =~ ^[0-9]+$ \
    && "$active_client_transactions" =~ ^[0-9]+$ ]] \
    || fail "database recovery sample is invalid"
  recorded_at="$(checked_utc_timestamp)" \
    || fail "database recovery sample timestamp could not be generated"
  jq -n --arg at "$recorded_at" --arg phase "$phase" --arg lsn "$lsn" \
    --arg systemIdentifier "$system_identifier" --arg timelineId "$timeline_id" \
    --arg database "$database_name" --arg containerId "$container_id" \
    --argjson unloggedRelations "$unlogged_relations" \
    --argjson preparedTransactions "$prepared_transactions" \
    --argjson sequenceRelations "$sequence_relations" \
    --argjson foreignTables "$foreign_tables" \
    --argjson activeClientTransactions "$active_client_transactions" \
    '{schemaVersion: 1, product: "business-finlynq", recordedAt: $at,
      phase: $phase, database: $database, databaseContainerId: $containerId,
      systemIdentifier: $systemIdentifier, timelineId: ($timelineId | tonumber),
      walInsertLsn: $lsn, unloggedRelations: $unloggedRelations,
      preparedTransactions: $preparedTransactions,
      sequenceRelations: $sequenceRelations, foreignTables: $foreignTables,
      activeClientTransactions: $activeClientTransactions,
      onlineBackupEligible: ($unloggedRelations == 0 and
        $preparedTransactions == 0 and $sequenceRelations == 0 and
        $foreignTables == 0 and $activeClientTransactions == 0),
      onlineBackupIneligibilityReasons: [
        if $unloggedRelations > 0 then "unlogged-relations" else empty end,
        if $preparedTransactions > 0 then "prepared-transactions" else empty end,
        if $sequenceRelations > 0 then "sequences" else empty end,
        if $foreignTables > 0 then "foreign-tables" else empty end,
        if $activeClientTransactions > 0 then "active-client-transactions" else empty end
      ]}' \
    >"$evidence_directory/$filename" \
    || fail "database recovery sample could not be written"
  chmod 0600 -- "$evidence_directory/$filename" \
    || fail "database recovery sample permissions could not be set"
}

record_release_backup_recovery_point() {
  local strategy="$1" start_lsn="$2" final_lsn="$3"
  local decision_reason="${4:-}" identity_stable="${5:-}" recorded_at=""
  local online_backup_json="null" eligibility_json="null"
  [[ "$strategy" == online-no-wal-advance || "$strategy" == quiesced-fallback \
    || "$strategy" == quiesced-worker-active \
    || "$strategy" == quiesced-online-ineligible ]] \
    || fail "release backup recovery strategy is invalid"
  [[ -f "$evidence_directory/33-backup-evidence.json" \
    && ! -L "$evidence_directory/33-backup-evidence.json" ]] \
    || fail "release backup recovery evidence is incomplete"
  if [[ "$strategy" == quiesced-worker-active \
    || "$strategy" == quiesced-online-ineligible ]]; then
    [[ -z "$start_lsn" && -z "$final_lsn" \
      && ! -e "$evidence_directory/22-online-backup-evidence.json" \
      && ! -L "$evidence_directory/22-online-backup-evidence.json" ]] \
      || fail "skipped online backup recovery evidence has an online snapshot"
    if [[ "$strategy" == quiesced-worker-active ]]; then
      [[ "$decision_reason" == authentication-worker-active \
        && -z "$identity_stable" \
        && ! -e "$evidence_directory/22-online-backup-eligibility.json" \
        && ! -L "$evidence_directory/22-online-backup-eligibility.json" ]] \
        || fail "worker-active online-backup skip evidence is invalid"
    else
      [[ "$decision_reason" == database-online-reuse-ineligible \
        && -z "$identity_stable" \
        && -f "$evidence_directory/22-online-backup-eligibility.json" \
        && ! -L "$evidence_directory/22-online-backup-eligibility.json" ]] \
        || fail "database-ineligible online-backup skip evidence is invalid"
      eligibility_json="$(jq -c '.' \
        "$evidence_directory/22-online-backup-eligibility.json")" \
        || fail "online backup eligibility evidence could not be loaded"
    fi
  else
    if [[ "$strategy" == online-no-wal-advance ]]; then
      [[ -z "$decision_reason" && "$identity_stable" == true ]] \
        || fail "reused online backup decision evidence is invalid"
    else
      [[ "$decision_reason" == wal-advanced \
        || "$decision_reason" == database-identity-changed \
        || "$decision_reason" == online-reuse-became-ineligible ]] \
        || fail "fallback online backup decision evidence is invalid"
      [[ "$identity_stable" == true || "$identity_stable" == false ]] \
        || fail "fallback database identity evidence is invalid"
    fi
    [[ "$start_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ \
      && "$final_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ \
      && -f "$evidence_directory/22-online-backup-start.json" \
      && ! -L "$evidence_directory/22-online-backup-start.json" \
      && -f "$evidence_directory/29-online-backup-final.json" \
      && ! -L "$evidence_directory/29-online-backup-final.json" \
      && -f "$evidence_directory/22-online-backup-evidence.json" \
      && ! -L "$evidence_directory/22-online-backup-evidence.json" ]] \
      || fail "online backup recovery evidence is incomplete"
    eligibility_json="$(jq -c '.' \
      "$evidence_directory/22-online-backup-start.json")" \
      || fail "online backup start-boundary evidence could not be loaded"
    online_backup_json="$(jq -c '.' \
      "$evidence_directory/22-online-backup-evidence.json")" \
      || fail "online backup recovery evidence could not be loaded"
  fi
  recorded_at="$(checked_utc_timestamp)" \
    || fail "release backup recovery-point timestamp could not be generated"
  jq -n --arg at "$recorded_at" --arg strategy "$strategy" \
    --arg startLsn "$start_lsn" --arg finalLsn "$final_lsn" \
    --arg decisionReason "$decision_reason" --arg identityStable "$identity_stable" \
    --argjson online "$online_backup_json" \
    --argjson eligibility "$eligibility_json" \
    --argjson onlineTimeoutSeconds "$release_online_backup_timeout_seconds" \
    --argjson quiescedTimeoutSeconds "$release_quiesced_backup_timeout_seconds" \
    --slurpfile selected "$evidence_directory/33-backup-evidence.json" '
      {
        schemaVersion: 1,
        product: "business-finlynq",
        recordedAt: $at,
        strategy: $strategy,
        onlineBackup: $online,
        onlineBackupEligibility: $eligibility,
        onlineBackupDecisionReason:
          (if $decisionReason == "" then null else $decisionReason end),
        databaseIdentityStableAcrossOnlineBackup:
          (if $identityStable == "" then null else ($identityStable == "true") end),
        selectedRecoveryPoint: $selected[0],
        walInsertLsnBeforeOnlineBackup: (if $startLsn == "" then null else $startLsn end),
        walInsertLsnAfterWriteSurfaceDrain: (if $finalLsn == "" then null else $finalLsn end),
        walAdvanced: (if $startLsn == "" then null else ($startLsn != $finalLsn) end),
        publicApplicationAvailableDuringOnlineBackup:
          (if $startLsn == "" then null else true end),
        onlineBackupSkippedBecauseAuthenticationWorkerWasActive:
          ($strategy == "quiesced-worker-active"),
        onlineBackupTimeoutSeconds: $onlineTimeoutSeconds,
        quiescedFallbackTimeoutSeconds: $quiescedTimeoutSeconds
      }
    ' >"$evidence_directory/33-backup-recovery-point.json" \
    || fail "release backup recovery-point evidence could not be written"
  chmod 0600 -- "$evidence_directory/33-backup-recovery-point.json" \
    || fail "release backup recovery-point evidence permissions could not be set"
}

if [[ "$mode" == release && "$first_router_forward_repair_resume" != true ]]; then
  write_first_router_recovery_journal \
    || fail "release pre-cutover recovery journal could not be committed"
  first_router_recovery_journal_committed="true"
fi

online_backup_start_lsn=""
online_backup_final_lsn=""
online_backup_system_identifier=""
online_backup_timeline_id=""
online_backup_database=""
online_backup_database_container_id=""
online_backup_skip_reason=""
online_backup_identity_stable=""
online_backup_fallback_reason=""
if [[ "$mode" == release ]]; then
  backup_source_revision="$previous_app_revision"
  stage="prepare-pre-migration-backup"
  run_logged 22-online-provision-backup-role.log \
    compose --profile operations run --rm --no-deps provision_backup
  if [[ "$previous_auth_worker_was_running" != true ]]; then
    # A live email worker writes its readiness heartbeat every two seconds.
    # Stopping it would make public readiness fail, while ignoring its WAL
    # would make the recovery point inexact. Attempt the online optimization
    # only when the accepted release does not require that worker.
    stage="online-pre-migration-backup"
    online_backup_database_container_id="$(compose ps --quiet database)" \
      || fail "online backup database container could not be resolved"
    [[ "$online_backup_database_container_id" =~ ^[a-f0-9]{12,64}$ ]] \
      || fail "online backup requires exactly one database container"
    read_release_database_recovery_boundary
    online_backup_start_lsn="$release_recovery_lsn"
    online_backup_system_identifier="$release_recovery_system_identifier"
    online_backup_timeline_id="$release_recovery_timeline_id"
    online_backup_database="$release_recovery_database"
    if release_recovery_boundary_supports_online_reuse; then
      write_release_database_recovery_sample \
        22-online-backup-start.json before-online-backup "$online_backup_start_lsn" \
        "$online_backup_system_identifier" "$online_backup_timeline_id" \
        "$online_backup_database" "$online_backup_database_container_id" \
        "$release_recovery_unlogged_relations" \
        "$release_recovery_prepared_transactions" \
        "$release_recovery_sequences" "$release_recovery_foreign_tables" \
        "$release_recovery_active_client_transactions"
      run_verified_backup_workflow "$release_online_backup_timeout_seconds" \
        22-online-encrypted-backup.log 22-online-backup-verification.log \
        22-online-backup-evidence.json
    else
      # Unsupported relation/transaction semantics do not fail the release.
      # Record only sanitized counts, then use the short quiesced path.
      write_release_database_recovery_sample \
        22-online-backup-eligibility.json online-backup-eligibility \
        "$online_backup_start_lsn" "$online_backup_system_identifier" \
        "$online_backup_timeline_id" "$online_backup_database" \
        "$online_backup_database_container_id" \
        "$release_recovery_unlogged_relations" \
        "$release_recovery_prepared_transactions" \
        "$release_recovery_sequences" "$release_recovery_foreign_tables" \
        "$release_recovery_active_client_transactions"
      online_backup_start_lsn=""
      online_backup_skip_reason="database-online-reuse-ineligible"
    fi
  else
    online_backup_skip_reason="authentication-worker-active"
  fi
fi

# `run_logged` deliberately isolates its command in a subshell. Create this
# capability in the parent before either maintenance transition so the live
# router, the readiness probe, and the browser container all receive one exact
# short-lived value.
release_acceptance_token="$(openssl rand -hex 32)" \
  || fail "release acceptance token generation failed"
[[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
  || fail "release acceptance token generation failed"

if [[ "$router_was_preexisting" == "true" ]]; then
  stage="enter-graceful-maintenance"
  router_transition_attempted="true"
  run_logged 23-release-router-maintenance.log enter_release_router_maintenance
  router_maintenance_confirmed="true"
  router_active_confirmed="false"
fi
write_surface_containment_armed="true"
run_logged 25-stop-write-surfaces.log stop_write_surfaces
if [[ "$mode" == release && "$router_was_preexisting" != true ]]; then
  detach_previous_app_public_edge
fi
write_surfaces_stopped="true"
write_checkpoint 26-write-surfaces-stopped.json write-surfaces-stopped-before-backup

if [[ "$router_was_preexisting" != "true" ]]; then
  stage="bootstrap-release-router"
  router_transition_attempted="true"
  run_logged 27-release-router-start.log \
    compose up --detach --wait --no-deps --no-build release_router
  verify_release_router_runtime 27-release-router-runtime.json
  stage="enter-bootstrap-maintenance"
  run_logged 28-release-router-maintenance.log enter_release_router_maintenance
  router_maintenance_confirmed="true"
  router_active_confirmed="false"
else
  verify_release_router_runtime 27-release-router-runtime.json
fi

stage="pre-migration-backup"
if [[ "$mode" == rehearsal ]]; then
  run_logged 29-rehearsal-database-start.log compose_timed 10m up --detach --wait --no-build database
  record_running_database_image "$evidence_directory/29-rehearsal-database-image.json"
  backup_source_revision="$revision"
  run_logged 30-provision-backup-role.log \
    compose --profile operations run --rm --no-deps provision_backup
  run_verified_backup_workflow "$release_backup_timeout_seconds" \
    31-encrypted-backup.log 32-backup-verification.log
elif [[ "$mode" == release ]]; then
  if [[ -z "$online_backup_start_lsn" ]]; then
    run_verified_backup_workflow "$release_quiesced_backup_timeout_seconds" \
      31-quiesced-encrypted-backup.log 32-quiesced-backup-verification.log
    if [[ "$online_backup_skip_reason" == authentication-worker-active ]]; then
      record_release_backup_recovery_point \
        quiesced-worker-active "" "" "$online_backup_skip_reason" ""
    else
      record_release_backup_recovery_point \
        quiesced-online-ineligible "" "" "$online_backup_skip_reason" ""
    fi
  else
    final_backup_database_container_id="$(compose ps --quiet database)" \
      || fail "post-drain database container could not be resolved"
    read_release_database_recovery_boundary
    online_backup_final_lsn="$release_recovery_lsn"
    if [[ "$final_backup_database_container_id" == "$online_backup_database_container_id" \
      && "$release_recovery_system_identifier" == "$online_backup_system_identifier" \
      && "$release_recovery_timeline_id" == "$online_backup_timeline_id" \
      && "$release_recovery_database" == "$online_backup_database" ]]; then
      online_backup_identity_stable="true"
    else
      online_backup_identity_stable="false"
    fi
    write_release_database_recovery_sample \
      29-online-backup-final.json after-write-surface-drain "$online_backup_final_lsn" \
      "$release_recovery_system_identifier" "$release_recovery_timeline_id" \
      "$release_recovery_database" "$final_backup_database_container_id" \
      "$release_recovery_unlogged_relations" \
      "$release_recovery_prepared_transactions" \
      "$release_recovery_sequences" "$release_recovery_foreign_tables" \
      "$release_recovery_active_client_transactions"
  fi
  if [[ -n "$online_backup_start_lsn" \
    && "$online_backup_identity_stable" == true \
    && "$online_backup_start_lsn" == "$online_backup_final_lsn" ]] \
    && release_recovery_boundary_supports_online_reuse; then
    jq '.' "$evidence_directory/22-online-backup-evidence.json" \
      >"$evidence_directory/33-backup-evidence.json" \
      || fail "online backup evidence could not be selected as the recovery point"
    chmod 0600 -- "$evidence_directory/33-backup-evidence.json" \
      || fail "selected online backup evidence permissions could not be set"
    record_release_backup_recovery_point \
      online-no-wal-advance "$online_backup_start_lsn" \
      "$online_backup_final_lsn" "" "$online_backup_identity_stable"
  elif [[ -n "$online_backup_start_lsn" ]]; then
    # A committed or aborted write advanced WAL after the dump's conservative
    # boundary. Never migrate from that stale snapshot. One short quiesced
    # fallback is allowed; timeout/failure restores the exact old release.
    sleep 1
    run_verified_backup_workflow "$release_quiesced_backup_timeout_seconds" \
      31-quiesced-encrypted-backup.log 32-quiesced-backup-verification.log
    if [[ "$online_backup_identity_stable" != true ]]; then
      online_backup_fallback_reason="database-identity-changed"
    elif ! release_recovery_boundary_supports_online_reuse; then
      online_backup_fallback_reason="online-reuse-became-ineligible"
    else
      online_backup_fallback_reason="wal-advanced"
    fi
    record_release_backup_recovery_point \
      quiesced-fallback "$online_backup_start_lsn" "$online_backup_final_lsn" \
      "$online_backup_fallback_reason" "$online_backup_identity_stable"
  fi
else
  backup_source_revision="$revision"
  initial_backup_boundary_at="$(checked_utc_timestamp)" \
    || fail "initial backup-boundary timestamp could not be generated"
  jq -n \
    --arg at "$initial_backup_boundary_at" \
    --arg revision "$revision" \
    '{schemaVersion: 1, product: "business-finlynq", recordedAt: $at,
      revision: $revision, preMigrationBackup: "not-applicable",
      reason: "fresh-empty-database", previousApplication: null}' \
    >"$evidence_directory/27-initial-pre-migration-backup-boundary.json"
  chmod 0600 -- "$evidence_directory/27-initial-pre-migration-backup-boundary.json"
fi

stage="activate-reviewed-database-image"
# From this point onward recovery must follow the reviewed forward-repair or
# application-rollback path; the exact pre-migration database backup is sealed.
if [[ "$mode" == release && "$first_router_forward_repair_resume" != true ]]; then
  mark_first_router_database_mutation_started \
    || fail "release recovery journal could not commit the forward-repair boundary"
fi
database_mutation_started="true"
start_reviewed_database() {
  local -a recreate_arguments=()
  [[ "$mode" == "initial" ]] && recreate_arguments+=(--force-recreate)
  compose_timed 10m up --detach --wait --no-build "${recreate_arguments[@]}" database
}
run_logged 34-database-start.log start_reviewed_database
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
detached_mutator_services=("${pretraffic_services[@]}")
detached_mutator_containment_armed="true"
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
detached_mutator_containment_armed="false"
detached_mutator_services=()

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
detached_mutator_services=(bootstrap_demo)
detached_mutator_containment_armed="true"
run_logged 55-bootstrap-up.log compose_timed 30m up --detach --no-build bootstrap_demo
capture_compose_container_id "demo bootstrap container" ps --all --quiet bootstrap_demo
bootstrap_container="$captured_compose_container_id"
run_logged 56-bootstrap-wait.log wait_for_captured_containers \
  "demo bootstrap" 56-bootstrap-services.log 56-bootstrap-container.json \
  bootstrap_demo "$bootstrap_container" "${image_ids[migrator]}" -- \
  logs --no-color --timestamps bootstrap_demo
detached_mutator_containment_armed="false"
detached_mutator_services=()
[[ -n "$bootstrap_container" && "$(docker inspect --format '{{.State.ExitCode}}' "$bootstrap_container")" == "0" ]] \
  || fail "additive demo bootstrap failed"
[[ "$(docker inspect --format '{{.Image}}' "$bootstrap_container")" == "${image_ids[migrator]}" ]] \
  || fail "additive demo bootstrap used an unexpected image"
pretraffic_evidence="$(jq -c --arg imageId "${image_ids[migrator]}" \
  '. + [{service: "bootstrap_demo", exitCode: 0, imageId: $imageId}]' <<<"$pretraffic_evidence")"

stage="post-bootstrap-accounting-verification"
run_logged 57-post-bootstrap-accounting-reset.log compose --profile operations rm --force --stop verify_accounting_evidence
detached_mutator_services=(verify_accounting_evidence)
detached_mutator_containment_armed="true"
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
detached_mutator_containment_armed="false"
detached_mutator_services=()
[[ -n "$post_bootstrap_verifier" \
  && "$(docker inspect --format '{{.State.ExitCode}}' "$post_bootstrap_verifier")" == "0" ]] \
  || fail "post-bootstrap accounting evidence verification failed"
[[ "$(docker inspect --format '{{.Image}}' "$post_bootstrap_verifier")" == "${image_ids[operations]}" ]] \
  || fail "post-bootstrap accounting verifier used an unexpected image"
pretraffic_evidence="$(jq -c --arg imageId "${image_ids[operations]}" \
  '. + [{service: "verify_accounting_evidence_post_bootstrap", exitCode: 0, imageId: $imageId}]' <<<"$pretraffic_evidence")"
pretraffic_completed_at="$(checked_utc_timestamp)" \
  || fail "pre-traffic verification timestamp could not be generated"
jq -n --arg at "$pretraffic_completed_at" --argjson services "$pretraffic_evidence" \
  '{schemaVersion: 1, completedAt: $at, trafficBlocked: true, postBootstrapAccountingEvidenceVerified: true, services: $services, databaseRollback: "forward-repair-only"}' \
  >"$evidence_directory/53-pretraffic-verification.json"
chmod 0600 -- "$evidence_directory/53-pretraffic-verification.json"

if [[ "$mode" == "initial" ]]; then
  stage="initial-post-migration-local-backup"
  run_logged 59-initial-provision-backup-role.log \
    compose --profile operations run --rm --no-deps provision_backup
  run_verified_backup_workflow "$release_backup_timeout_seconds" \
    59-initial-encrypted-backup.log 59-initial-backup-verification.log
  initial_backup_recorded_at="$(checked_utc_timestamp)" \
    || fail "initial backup-deferral timestamp could not be generated"
  jq -n \
    --arg at "$initial_backup_recorded_at" \
    --arg revision "$revision" \
    '{schemaVersion: 1, product: "business-finlynq", recordedAt: $at,
      revision: $revision, localEncryptedBackup: "verified", offsiteDelivery: "deferred",
      offsiteRequired: false}' \
    >"$evidence_directory/59-initial-backup-deferral.json"
  chmod 0600 -- "$evidence_directory/59-initial-backup-deferral.json"
fi

stage="candidate-readiness-with-writes-disabled"
run_quiesced_app() (
  compose_with_overrides \
    DEMO_LOGIN_ENABLED=false DEMO_WRITES_ENABLED=false \
    ACCOUNT_LOGIN_ENABLED=false AUTH_OIDC_ENABLED=false AUTH_OIDC_SIGNUP_ENABLED=false ACCOUNT_SIGNUP_ENABLED=false \
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
for disabled_check in accountAuthentication accountSignup oidcAuthentication emailWorker bankFeeds; do
  jq -e --arg check "$disabled_check" '.checks[$check] == "disabled"' "$evidence_directory/61-quiesced-readiness.json" >/dev/null \
    || fail "quiesced candidate unexpectedly enabled $disabled_check"
done
quiesced_container="$(compose ps --quiet app)"
[[ -n "$quiesced_container" ]] || fail "quiesced candidate app container is missing"
quiesced_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$quiesced_container")"
for disabled_gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED AUTH_OIDC_ENABLED AUTH_OIDC_SIGNUP_ENABLED \
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
candidate_container="$(compose ps --quiet app)"
[[ -n "$candidate_container" ]] || fail "candidate app container is missing"
[[ "$(docker inspect --format '{{.Image}}' "$candidate_container")" == "${image_ids[app]}" ]] || fail "running app image ID differs from the built candidate"
[[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_container")" == "$revision" ]] \
  || fail "running app OCI revision differs from the release"
verify_unique_network_alias_owner \
  "$router_frontend_network_name" release-app "$candidate_container" \
  "candidate private application"
wait_for_internal_readiness "$evidence_directory/64-internal-readiness.json" || fail "candidate did not satisfy detailed readiness"
chmod 0600 -- "$evidence_directory/64-internal-readiness.json"

candidate_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$candidate_container")"
[[ "$(awk -F= '$1 == "BUSINESS_WRITES_ENABLED" {print $2; exit}' <<<"$candidate_environment")" == "false" ]] \
  || fail "real business writes were enabled before candidate acceptance"
[[ "$(awk -F= '$1 == "BANK_FEEDS_ENABLED" {print $2; exit}' <<<"$candidate_environment")" == "false" ]] \
  || fail "live bank feeds were enabled before candidate acceptance"

stage="private-candidate-preview-readiness"
public_headers="$evidence_directory/65-public-readiness.headers"
public_body="$evidence_directory/65-public-readiness.json"
public_status=""
for _ in {1..30}; do
  if public_status="$(curl --silent --show-error --max-time 15 \
    --header "Authorization: Bearer $release_acceptance_token" \
    --dump-header "$public_headers" --output "$public_body" --write-out '%{http_code}' \
    "$public_base_url/api/health")" \
    && [[ "$public_status" == "200" ]]; then
    break
  fi
  sleep 2
done
[[ "$public_status" == "200" ]] \
  || fail "private candidate preview did not become ready (last HTTP ${public_status:-unavailable})"
jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$public_body" >/dev/null \
  || fail "private candidate preview exposed details or was unavailable"
grep -Eiq '^cache-control:.*no-store' "$public_headers" || fail "private candidate preview is missing no-store"
chmod 0600 -- "$public_headers" "$public_body"
verify_release_router_maintenance

expected_auth="disabled"; [[ "$release_ACCOUNT_LOGIN_ENABLED" == "true" ]] && expected_auth="ready"
expected_oidc="disabled"; [[ "$release_AUTH_OIDC_ENABLED" == "true" ]] && expected_oidc="ready"
expected_oidc_signup="disabled"; [[ "$release_AUTH_OIDC_SIGNUP_ENABLED" == "true" ]] && expected_oidc_signup="ready"
expected_signup="disabled"; [[ "$release_ACCOUNT_SIGNUP_ENABLED" == "true" ]] && expected_signup="ready"
expected_worker="disabled"; [[ "$release_ACCOUNT_LOGIN_ENABLED" == "true" ]] && expected_worker="ready"
expected_bank="disabled"
jq -e \
  --arg revision "$revision" --arg auth "$expected_auth" --arg signup "$expected_signup" --arg worker "$expected_worker" --arg bank "$expected_bank" \
  --arg oidc "$expected_oidc" --arg oidcSignup "$expected_oidc_signup" \
  '.status == "ready" and .revision == $revision and .checks.database == "ready" and .checks.organizationKey == "ready" and .checks.identityKey == "ready" and .checks.accountAuthentication == $auth and .checks.oidcAuthentication == $oidc and .checks.oidcSignup == $oidcSignup and .checks.accountSignup == $signup and .checks.emailWorker == $worker and .checks.bankFeeds == $bank' \
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
  compose_with_overrides \
    "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$release_acceptance_token" -- \
    --profile acceptance up --detach --no-deps --no-build --force-recreate release_acceptance
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
final_container="$(compose ps --quiet app)"
[[ -n "$final_container" ]] || fail "final candidate app container is missing"
[[ "$(docker inspect --format '{{.Image}}' "$final_container")" == "${image_ids[app]}" ]] \
  || fail "final app image ID differs from the immutable accepted candidate"
[[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$final_container")" == "$revision" ]] \
  || fail "final app OCI revision differs from the accepted release"
verify_unique_network_alias_owner \
  "$router_frontend_network_name" release-app "$final_container" \
  "final private application"
wait_for_internal_readiness "$evidence_directory/73-final-readiness.json" || fail "final reviewed gate posture did not become ready"
chmod 0600 -- "$evidence_directory/73-final-readiness.json"
final_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$final_container")"
[[ "$(awk -F= '$1 == "BUSINESS_WRITES_ENABLED" {print $2; exit}' <<<"$final_environment")" == "$release_BUSINESS_WRITES_ENABLED" ]] \
  || fail "final business write gate differs from the reviewed environment"
[[ "$(awk -F= '$1 == "BANK_FEEDS_ENABLED" {print $2; exit}' <<<"$final_environment")" == "$release_BANK_FEEDS_ENABLED" ]] \
  || fail "final bank-feed gate differs from the reviewed environment"
final_expected_bank="disabled"; [[ "$release_BANK_FEEDS_ENABLED" == "true" ]] && final_expected_bank="ready"
jq -e --arg revision "$revision" --arg bank "$final_expected_bank" \
  '.status == "ready" and .revision == $revision and .checks.bankFeeds == $bank' \
  "$evidence_directory/73-final-readiness.json" >/dev/null || fail "final readiness does not reflect the reviewed bank-feed gate"
verify_release_router_runtime 74-release-router-runtime.json

# The candidate, its final write-gate posture, and browser workflow have all
# passed while ordinary users remained behind deterministic maintenance. Make
# the accepted app visible with an in-process Caddy reload; the listener and
# existing connections are never replaced.
verify_release_router_maintenance
verify_unique_network_alias_owner \
  "$router_frontend_network_name" release-app "$final_container" \
  "accepted private application"
if [[ "$mode" == release ]]; then
  stage="prepare-active-finalization"
  write_active_finalization_marker \
    || fail "active-finalization recovery marker could not be committed"
  active_finalization_marker_committed="true"
fi
stage="activate-accepted-application"
run_logged 75-release-router-active.log activate_release_router_live

stage="final-public-readiness"
final_public_headers="$evidence_directory/76-final-public-readiness.headers"
final_public_body="$evidence_directory/76-final-public-readiness.json"
final_public_status=""
for _ in {1..30}; do
  if final_public_status="$(curl --silent --show-error --max-time 15 \
    --header "X-Request-Id: release-final-readiness-$run_id" \
    --dump-header "$final_public_headers" --output "$final_public_body" \
    --write-out '%{http_code}' "$public_base_url/api/health")" \
    && [[ "$final_public_status" == "200" ]]; then
    break
  fi
  sleep 2
done
[[ "$final_public_status" == "200" ]] \
  || fail "accepted application did not become publicly ready"
jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
  "$final_public_body" >/dev/null \
  || fail "final public readiness exposed details or was unavailable"
grep -Eiq '^cache-control:.*no-store' "$final_public_headers" \
  || fail "final public readiness is missing no-store"
chmod 0600 -- "$final_public_headers" "$final_public_body"

if [[ "$mode" != rehearsal && "$edge_mode" == external ]]; then
  stage="external-edge-contract"
  run_logged 77-external-edge-contract.log \
    bash "$candidate_source_root/deploy/edge/verify-external-edge.sh" \
      --scope production --warmup-host production \
      --allow-production-router-maintenance \
      --expected-production-revision "$revision"
  write_checkpoint 77-external-edge-contract.json external-edge-accepted
fi

stage="canonical-environment-stability"
[[ "$(validate_secret_environment_file "$canonical_environment_file" "canonical Compose environment")" \
  == "$canonical_environment_file" ]] \
  || fail "canonical Compose environment resolved unexpectedly"
current_compose_environment_sha256="$(checked_file_sha256 "$canonical_environment_file")" \
  || fail "canonical Compose environment could not be hashed at final acceptance"
[[ "$current_compose_environment_sha256" == "$compose_environment_sha256" ]] \
  || fail "canonical Compose environment changed during release"

if [[ "$mode" == "release" ]]; then
  stage="resume-schedulers"
  verify_live_checkout_matches_candidate
  [[ "$(validate_secret_environment_file "$canonical_operations_environment_file" "canonical operations environment")" \
    == "$canonical_operations_environment_file" ]] \
    || fail "canonical operations environment resolved unexpectedly"
  current_operations_environment_sha256="$(checked_file_sha256 \
    "$canonical_operations_environment_file")" \
    || fail "canonical operations environment could not be hashed before scheduler resume"
  [[ "$current_operations_environment_sha256" == "$operations_environment_sha256" ]] \
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
  run_logged 82-production-monitor.log run_installed_monitor transitional-maintenance
  verify_live_checkout_matches_candidate
  write_checkpoint 83-production-monitor.json installed-scheduled-monitor-passed
  stage="record-scheduler-boundary-version"
  record_scheduler_boundary_version
elif [[ "$mode" == "initial" ]]; then
  stage="initial-scheduler-contract"
  verify_live_checkout_matches_candidate
  [[ "$(validate_secret_environment_file "$canonical_operations_environment_file" "canonical operations environment")" \
    == "$canonical_operations_environment_file" ]] \
    || fail "canonical operations environment resolved unexpectedly"
  current_operations_environment_sha256="$(checked_file_sha256 \
    "$canonical_operations_environment_file")" \
    || fail "canonical operations environment could not be hashed during initial acceptance"
  [[ "$current_operations_environment_sha256" == "$operations_environment_sha256" ]] \
    || fail "canonical operations environment changed during initial production"
  run_logged 78-scheduler-state-contract.log prepare_scheduler_state_directory
  run_logged 79-backup-schedule-contract.log install_and_verify_systemd_schedule
  initial_schedule_installed="true"
  run_logged 80-initial-schedulers-disabled.log disable_and_verify_initial_schedule
  initial_schedulers_verified="true"
  verify_live_checkout_matches_candidate
  stage="initial-accounting-evidence-seed"
  run_logged 81-accounting-evidence-seed.log run_installed_accounting_evidence
  verify_live_checkout_matches_candidate
  stage="initial-production-monitor-acceptance"
  run_logged 82-production-monitor.log run_installed_monitor transitional-maintenance
  verify_live_checkout_matches_candidate
  run_logged 83-initial-schedulers-still-disabled.log disable_and_verify_initial_schedule
  write_checkpoint 84-production-monitor.json contained-initial-monitor-passed
  stage="record-initial-scheduler-boundary-version"
  record_scheduler_boundary_version
  initial_deferral_recorded_at="$(checked_utc_timestamp)" \
    || fail "initial-deferral timestamp could not be generated"
  jq -n \
    --arg recordedAt "$initial_deferral_recorded_at" \
    --arg revision "$revision" \
    '{schemaVersion: 1, product: "business-finlynq", recordedAt: $recordedAt,
      revision: $revision, scheduler: "systemd", timersInstalled: true,
      timersEnabled: false, timersActive: false, scheduledExecution: "deferred",
      offsiteBackup: "deferred", localEncryptedBackup: "verified",
      activationRequiresReviewedRelease: true}' \
    >"$evidence_directory/85-contained-initial-deferrals.json"
  chmod 0600 -- "$evidence_directory/85-contained-initial-deferrals.json"
  stage="initial-runtime-pruning"
  # Compose `up` intentionally retains the completed migration/bootstrap
  # containers for evidence collection. Once their IDs, images, exit codes,
  # and logs are sealed above, remove only that exact disposable container
  # set. Volumes and networks are never touched. This gives wrapper
  # finalization a small, exact live-runtime set to attest.
  initial_disposable_services=(
    provision_auth_worker_role
    migrate
    reconcile_runtime_grants
    reconcile_auth_worker_grants
    reconcile_backup_grants
    verify_database_contract
    verify_accounting_evidence
    bootstrap_demo
  )
  run_logged 86-initial-runtime-pruning.log \
    compose --profile operations rm --force --stop "${initial_disposable_services[@]}"
  read_docker_output "contained initial runtime after disposable pruning" ps --all \
    --format '{{.Label "com.docker.compose.service"}}' \
    --filter 'label=com.docker.compose.project=business-finlynq'
  [[ "$(sort <<<"$docker_query_output")" == $'app\ndatabase\nevidence_scanner\nrelease_router' ]] \
    || fail "contained initial runtime retains an unexpected Compose service"
  write_checkpoint 87-initial-runtime-pruned.json disposable-initial-containers-removed
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
# Seal and sync every prerequisite before publishing the terminal marker. If
# the host stops between the marker rename and the final inventory refresh, the
# installer can prove that the old inventory is exact except for that one
# terminal file and reconcile it under an explicit finalize acknowledgement.
refresh_checksums \
  || fail "pre-terminal release evidence could not be checksummed"
sync_evidence_inventory \
  || fail "pre-terminal release evidence could not be durably synchronized"
release_completed_at="$(checked_utc_timestamp)" \
  || fail "terminal acceptance timestamp could not be generated"
browser_log_sha256="$(checked_file_sha256 \
  "$evidence_directory/70-browser-acceptance.log")" \
  || fail "browser-acceptance log checksum could not be read"
contained_initial=false
if [[ "$mode" == initial ]]; then
  contained_initial=true
fi
terminal_evidence_temporary="$evidence_directory/.90-release-complete.json.partial"
[[ ! -e "$terminal_evidence_temporary" && ! -L "$terminal_evidence_temporary" \
  && ! -e "$evidence_directory/90-release-complete.json" \
  && ! -L "$evidence_directory/90-release-complete.json" ]] \
  || fail "terminal release evidence path already exists"
jq -n \
  --arg completedAt "$release_completed_at" \
  --arg mode "$mode" \
  --arg revision "$revision" \
  --arg runId "$run_id" \
  --arg candidateImageId "${image_ids[app]}" \
  --arg releaseRouterImageId "${image_ids[router]}" \
  --arg releaseRouterConfigSha256 "$router_config_sha256" \
  --arg previousImageId "$previous_app_id" \
  --arg containedInitial "$contained_initial" \
  --arg browserLogSha256 "$browser_log_sha256" \
  '{schemaVersion: 1, product: "business-finlynq", status: "accepted", completedAt: $completedAt, mode: $mode, revision: $revision, runId: $runId, candidateAppImageId: $candidateImageId, releaseRouterImageId: $releaseRouterImageId, releaseRouterConfigSha256: $releaseRouterConfigSha256, maintenanceConfirmedBeforeSchemaMigration: true, previousAppImageId: (if $previousImageId == "" then null else $previousImageId end), preTrafficDatabaseContractVerified: true, postBootstrapAccountingEvidenceVerified: true, browserAcceptancePassed: true, browserLogSha256: $browserLogSha256, databaseRollback: "forward-repair-only", containedInitial: ($containedInitial == "true"), localEncryptedBackupVerified: ($containedInitial == "true"), offsiteBackupDeferred: ($containedInitial == "true"), schedulerActivationDeferred: ($containedInitial == "true")}' \
  >"$terminal_evidence_temporary" \
  || fail "terminal release evidence could not be staged"
chmod 0600 -- "$terminal_evidence_temporary" \
  || fail "terminal release evidence staging permissions could not be set"
sync -f -- "$terminal_evidence_temporary" \
  || fail "terminal release evidence staging file could not be synchronized"
mv -- "$terminal_evidence_temporary" "$evidence_directory/90-release-complete.json" \
  || fail "terminal release evidence could not be published atomically"
sync -f -- "$evidence_directory" \
  || fail "terminal release evidence directory entry could not be synchronized"
refresh_checksums \
  || fail "accepted release evidence could not be checksummed"
sync_evidence_inventory \
  || fail "accepted release evidence could not be durably synchronized"
if [[ "$mode" == release ]]; then
  authorize_active_finalization_marker \
    || fail "active-finalization authorization could not be committed"
fi
terminal_evidence_committed="true"
if [[ "$mode" != rehearsal ]]; then
  commit_release_router_active
fi
if [[ "$mode" == release ]]; then
  clear_active_finalization_marker \
    || fail "active-finalization recovery marker could not be retired"
  if [[ "$first_router_recovery_journal_committed" == true ]]; then
    clear_first_router_recovery_journal \
      || fail "release recovery journal could not be retired after active acceptance"
  fi
fi
release_completed="true"
printf 'Business Finlynq %s accepted for %s. Evidence: %s\n' "$mode" "$revision" "$evidence_directory"
