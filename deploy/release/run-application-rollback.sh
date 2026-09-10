#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
readonly release_router_reference="business-finlynq-release-router:v2"
readonly release_router_revision="release-router-v2"
readonly release_router_contract="v2"
readonly release_router_build_project="business-finlynq-release-router-build-v2"
readonly legacy_rollback_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_rollback_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
readonly legacy_rollback_adapter_sha256="c997b2312f156cb5f97919f9c07758b09b244b77a578c767a3b827465ec94cdb"
readonly host_deployment_state_directory="/var/lib/business-finlynq"
readonly host_deployment_lock="$host_deployment_state_directory/deployment-host.lock"
readonly production_configuration_directory="/etc/business-finlynq"
readonly legacy_rollback_adapter_root="$production_configuration_directory/rollback-adapters"
readonly legacy_rollback_adapter_directory="$legacy_rollback_adapter_root/$legacy_rollback_revision"
readonly legacy_rollback_adapter_path="$legacy_rollback_adapter_directory/legacy-inline-db-password-entrypoint.sh"

evidence_directory=""
environment_file=""
scheduler_mode=""
rollback_containment_armed="false"
rollback_evidence_temporary=""
canonical_environment_file=""
compose_environment_sha256=""
environment_snapshot_file=""
candidate_staging_root=""
candidate_source_root=""
candidate_tree_id=""
candidate_tree_manifest_sha256=""
edge_mode="compose"
rollback_maintenance_confirmed="false"
rollback_acceptance_token=""
rollback_router_container=""
rollback_scheduler_pause_attempted="false"
rollback_schedulers_paused="false"
legacy_rollback_adapter_required="false"
rollback_compatibility_ack="${ROLLBACK_COMPATIBILITY_ACK:-}"
legacy_rollback_compose_override=""
legacy_rollback_adapter_temporary=""
rollback_watchdog_pid=""
rollback_watchdog_parent_pid=""
rollback_watchdog_owner_uid=""
rollback_watchdog_token=""
rollback_watchdog_ready_file=""
rollback_watchdog_disarm_file=""

fail() {
  printf 'Business Finlynq application rollback failed: %s\n' "$1" >&2
  exit 1
}

git_command_output=""
read_git_output() {
  local description="$1"
  shift
  if ! git_command_output="$(git --no-optional-locks -c safe.directory="$repository_root" \
    -C "$repository_root" "$@" 2>/dev/null)"; then
    fail "could not inspect $description in the canonical Git checkout"
  fi
}

assert_clean_checkout() {
  local dirty_message="$1" checkout_status
  if ! checkout_status="$(git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
    status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    fail "$dirty_message because Git status could not be inspected"
  fi
  [[ -z "$checkout_status" ]] || fail "$dirty_message"
}

cleanup_rollback_transients() {
  local cleanup_status=0
  if [[ -n "$legacy_rollback_adapter_temporary" ]]; then
    if [[ ! -e "$legacy_rollback_adapter_temporary" \
      && ! -L "$legacy_rollback_adapter_temporary" ]]; then
      legacy_rollback_adapter_temporary=""
    elif [[ "$legacy_rollback_adapter_temporary" \
        == "$legacy_rollback_adapter_path.partial."* \
      && -f "$legacy_rollback_adapter_temporary" \
      && ! -L "$legacy_rollback_adapter_temporary" \
      && "$(readlink -f -- "$legacy_rollback_adapter_temporary")" \
        == "$legacy_rollback_adapter_temporary" \
      && "$(stat -c '%u:%g:%h' -- "$legacy_rollback_adapter_temporary")" == 0:0:1 ]]; then
      rm -f -- "$legacy_rollback_adapter_temporary" || cleanup_status=1
      legacy_rollback_adapter_temporary=""
    else
      printf '%s\n' \
        "URGENT: refused to remove an unexpected f8485 adapter temporary path: $legacy_rollback_adapter_temporary" >&2
      cleanup_status=1
    fi
  fi
  if [[ -n "$environment_snapshot_file" ]]; then
    rm -f -- "$environment_snapshot_file" || cleanup_status=1
    environment_snapshot_file=""
  fi
  if [[ -n "$candidate_staging_root" ]]; then
    if [[ "$candidate_staging_root" == /tmp/business-finlynq-rollback.* \
      && -d "$candidate_staging_root" && ! -L "$candidate_staging_root" \
      && "$(readlink -f -- "$candidate_staging_root")" == "$candidate_staging_root" ]]; then
      rm -rf -- "$candidate_staging_root" || cleanup_status=1
      candidate_staging_root=""
      candidate_source_root=""
    else
      printf '%s\n' "URGENT: refused to remove an unexpected rollback staging path: $candidate_staging_root" >&2
      cleanup_status=1
    fi
  fi
  return "$cleanup_status"
}

cleanup_early_rollback_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_rollback_transients || status=1
  exit "$status"
}

while (( $# > 0 )); do
  case "$1" in
    --evidence|--environment|--scheduler)
      (( $# >= 2 )) || fail "$1 requires a value"
      case "$1" in
        --evidence) evidence_directory="$2" ;;
        --environment) environment_file="$2" ;;
        --scheduler) scheduler_mode="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      printf '%s\n' 'Usage: run-application-rollback.sh --evidence <accepted-release-dir> --environment <compose.env> --scheduler <systemd|cron>'
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "${ROLLBACK_SCHEMA_COMPATIBLE_ACK:-}" == "application-only-forward-schema" ]] \
  || fail "set ROLLBACK_SCHEMA_COMPATIBLE_ACK=application-only-forward-schema after reviewing migration compatibility"
[[ "$scheduler_mode" == "systemd" || "$scheduler_mode" == "cron" ]] \
  || fail "--scheduler must be systemd or cron"
[[ -d "$evidence_directory" && ! -L "$evidence_directory" ]] || fail "evidence directory is missing or unsafe"
[[ -f "$environment_file" && ! -L "$environment_file" ]] || fail "Compose environment is missing or unsafe"

for command_name in awk basename bash chmod chown curl date dirname docker env find flock git grep id install jq mkdir mktemp mv openssl readlink rm sha256sum sleep sort stat sync tar timeout touch tr xargs; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"

# Keep both Compose interpolation and direct Docker daemon selection independent
# from ambient operator-shell DOCKER_*/COMPOSE_* variables.
docker() {
  env -i "PATH=$PATH" docker "$@"
}

evidence_directory="$(cd -- "$evidence_directory" && pwd -P)"
environment_file="$(readlink -f -- "$environment_file")"
[[ "$environment_file" == "/etc/business-finlynq/compose.env" ]] \
  || fail "production rollback must use the canonical Compose environment"
canonical_environment_file="$environment_file"
compose_environment_sha256="$(sha256sum "$canonical_environment_file" | awk '{print $1}')"
[[ "$compose_environment_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "Compose environment checksum is invalid"
edge_mode_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
  "$canonical_environment_file")"
[[ "$edge_mode_count" == 0 || "$edge_mode_count" == 1 ]] \
  || fail "Compose environment must define BUSINESS_FINLYNQ_EDGE_MODE at most once"
if [[ "$edge_mode_count" == 1 ]]; then
  edge_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$canonical_environment_file")"
fi
[[ "$edge_mode" == compose || "$edge_mode" == external ]] \
  || fail "BUSINESS_FINLYNQ_EDGE_MODE must be compose or external"
environment_mode="$(stat -c '%a' -- "$environment_file")"
environment_owner="$(stat -c '%u' -- "$environment_file")"
[[ "$environment_mode" =~ ^[0-7]{3,4}$ ]] || fail "Compose environment mode is invalid"
(( (8#$environment_mode & 8#077) == 0 )) \
  || fail "Compose environment must not be accessible by group or other users"
[[ "$environment_owner" == "0" || "$environment_owner" == "$(id -u)" ]] \
  || fail "Compose environment must be owned by root or the rollback operator"
if [[ "$scheduler_mode" == "cron" ]]; then
  [[ "$(id -un)" == "deploy" ]] \
    || fail "cron rollback must run as the exact deploy account"
  if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
    fail "cron rollback requires the deploy account"
  fi
  [[ "$(id -u)" == "$deploy_uid" ]] \
    || fail "cron rollback resolved a different deploy uid"
  [[ "$environment_owner" == "$deploy_uid" ]] \
    || fail "cron rollback Compose environment must be owned by the deploy account"
fi

if ! deploy_uid="$(id -u deploy 2>/dev/null)"; then
  fail "rollback coordination requires the deploy account"
fi
deploy_gid="$(id -g deploy 2>/dev/null)" \
  || fail "host deployment coordination requires the deploy account"
[[ -d "$host_deployment_state_directory" \
  && ! -L "$host_deployment_state_directory" \
  && "$(readlink -f -- "$host_deployment_state_directory")" \
    == "$host_deployment_state_directory" \
  && "$(stat -c '%u:%g:%a' -- "$host_deployment_state_directory")" \
    == "0:$deploy_gid:775" ]] \
  || fail "shared deployment state directory must be root:deploy mode 0775"
[[ ! -L "$host_deployment_lock" ]] \
  || fail "shared deployment-host lock is symbolic"
if [[ "$(id -u)" == 0 ]]; then
  if [[ ! -e "$host_deployment_lock" ]]; then
    install -o root -g "$deploy_gid" -m 0660 -- /dev/null "$host_deployment_lock"
  fi
  [[ -f "$host_deployment_lock" && ! -L "$host_deployment_lock" \
    && "$(readlink -f -- "$host_deployment_lock")" == "$host_deployment_lock" ]] \
    || fail "shared deployment-host lock is unavailable or unsafe"
  chown root:"$deploy_gid" "$host_deployment_lock"
  chmod 0660 -- "$host_deployment_lock"
fi
[[ -f "$host_deployment_lock" && ! -L "$host_deployment_lock" \
  && "$(readlink -f -- "$host_deployment_lock")" == "$host_deployment_lock" \
  && "$(stat -c '%u:%g:%a:%h' -- "$host_deployment_lock")" == "0:$deploy_gid:660:1" ]] \
  || fail "shared deployment-host lock is unavailable"
exec 8<>"$host_deployment_lock"
[[ "$(readlink -f -- /proc/$$/fd/8)" == "$host_deployment_lock" \
  && "$(stat -Lc '%u:%g:%a:%h' -- /proc/$$/fd/8)" == "0:$deploy_gid:660:1" ]] \
  || fail "the opened host deployment lock differs from its protected path"
flock --exclusive --nonblock 8 \
  || fail "another production or development deployment is active"

readonly coordination_lock_directory="/home/deploy/.local/state/business-finlynq/release-locks"
readonly coordination_lock_file="$coordination_lock_directory/production-release-rollback.lock"
[[ -d "$coordination_lock_directory" && ! -L "$coordination_lock_directory" ]] \
  || fail "release coordination lock directory is missing or unsafe"
[[ "$(readlink -f -- "$coordination_lock_directory")" == "$coordination_lock_directory" ]] \
  || fail "release coordination lock directory resolved unexpectedly"
[[ "$(stat -c '%u' -- "$coordination_lock_directory")" == "$deploy_uid" ]] \
  || fail "release coordination lock directory must be owned by deploy"
[[ "$(stat -c '%a' -- "$coordination_lock_directory")" == "700" ]] \
  || fail "release coordination lock directory must have mode 0700"
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
[[ "$(stat -c '%u' -- "$coordination_lock_file")" == "$deploy_uid" \
  && "$(stat -c '%a' -- "$coordination_lock_file")" == "600" ]] \
  || fail "release coordination lock must be deploy-owned with mode 0600"
exec 9>"$coordination_lock_file"
flock --exclusive --nonblock 9 \
  || fail "another production release or rollback already holds the coordination lock"

[[ "$repository_root" == "/home/deploy/business-finlynq" ]] \
  || fail "production rollback must run from the checkout used by the installed scheduler"
cd -- "$repository_root"
read_git_output "repository root" rev-parse --show-toplevel
[[ "$git_command_output" == "$repository_root" ]] \
  || fail "rollback is not running from the reviewed repository root"
assert_clean_checkout "rollback checkout is not clean"
for evidence_file in SHA256SUMS 11-images.json 12-rollback-artifact.json; do
  [[ -f "$evidence_directory/$evidence_file" && ! -L "$evidence_directory/$evidence_file" ]] \
    || fail "required release evidence is missing or unsafe: $evidence_file"
done

(
  cd -- "$evidence_directory"
  sha256sum --check --strict SHA256SUMS
) || fail "release evidence checksum verification failed"

rollback_record="$evidence_directory/12-rollback-artifact.json"
completion_record="$evidence_directory/90-release-complete.json"
failure_record="$evidence_directory/99-failure.json"
evidence_revision=""
if [[ -f "$completion_record" ]]; then
  [[ ! -L "$completion_record" ]] || fail "completed release evidence is unsafe"
  jq -e '.schemaVersion == 1 and .product == "business-finlynq" and .mode == "release"
    and .status == "accepted" and .databaseRollback == "forward-repair-only"' "$completion_record" >/dev/null \
    || fail "completed release evidence does not permit application-only rollback"
  evidence_revision="$(jq -r '.revision // empty' "$completion_record")"
elif [[ -f "$failure_record" ]]; then
  [[ ! -L "$failure_record" ]] || fail "failed release evidence is unsafe"
  jq -e '.schemaVersion == 1 and .product == "business-finlynq" and .mode == "release"
    and .status == "failed" and (.revision | test("^[a-f0-9]{40}$"))' "$failure_record" >/dev/null \
    || fail "failed release evidence is invalid"
  evidence_revision="$(jq -r '.revision // empty' "$failure_record")"
else
  fail "evidence contains neither an accepted release nor a recorded failed release"
fi
jq -e '.schemaVersion == 1 and .databaseRollback == "forward-repair-only"
  and .rollbackTool == "deploy/release/run-application-rollback.sh"' "$rollback_record" >/dev/null \
  || fail "rollback artifact contract is invalid"
previous_image_id="$(jq -r '.previous.imageId // empty' "$rollback_record")"
previous_revision="$(jq -r '.previous.revision // empty' "$rollback_record")"
candidate_image_id="$(jq -r '.candidate.imageId // empty' "$rollback_record")"
candidate_revision="$(jq -r '.candidate.revision // empty' "$rollback_record")"
release_router_image_id="$(jq -r '.images[] | select(.name == "router") | .imageId' \
  "$evidence_directory/11-images.json")"
[[ "$previous_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "evidence has no previous immutable app image"
[[ "$candidate_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "evidence has no immutable candidate app image"
[[ "$release_router_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "evidence has no immutable release-router image"
[[ "$previous_revision" =~ ^[a-f0-9]{40}$ && "$candidate_revision" =~ ^[a-f0-9]{40}$ ]] || fail "evidence revisions are invalid"
[[ "$evidence_revision" == "$candidate_revision" ]] \
  || fail "release status and rollback artifact identify different candidate revisions"
if [[ "$previous_revision" == "$legacy_rollback_revision" ]]; then
  [[ "$previous_image_id" == "$legacy_rollback_image_id" ]] \
    || fail "the f8485 rollback evidence does not identify its one reviewed image"
  [[ "$rollback_compatibility_ack" == f8485-one-release-only ]] \
    || fail "set ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only for the degraded f8485 adapter"
  legacy_rollback_adapter_required="true"
fi
read_git_output "candidate HEAD" rev-parse HEAD
[[ "$git_command_output" == "$candidate_revision" ]] \
  || fail "rollback checkout does not match the deployed candidate revision"
git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  cat-file -e "$candidate_revision^{commit}" 2>/dev/null \
  || fail "candidate revision is not a local Git commit"
if [[ -f "$completion_record" ]]; then
  [[ "$(jq -r '.previousAppImageId // empty' "$completion_record")" == "$previous_image_id" ]] \
    || fail "completed release and rollback artifact identify different previous images"
  [[ "$(jq -r '.candidateAppImageId // empty' "$completion_record")" == "$candidate_image_id" ]] \
    || fail "completed release and rollback artifact identify different candidate images"
  [[ "$(jq -r '.releaseRouterImageId // empty' "$completion_record")" == "$release_router_image_id" ]] \
    || fail "completed release and image inventory identify different release-router images"
fi
[[ "$(docker image inspect --format '{{.Id}}' "$previous_image_id")" == "$previous_image_id" ]] \
  || fail "the retained previous image is unavailable"
previous_image_revision_label="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$previous_image_id")" \
  || fail "the retained previous image revision label could not be inspected"
if [[ "$legacy_rollback_adapter_required" == true ]]; then
  [[ -z "$previous_image_revision_label" \
    || "$previous_image_revision_label" == '<no value>' ]] \
    || fail "the exact f8485 image unexpectedly carries a conflicting revision label"
else
  [[ "$previous_image_revision_label" == "$previous_revision" ]] \
    || fail "the retained previous image revision does not match evidence"
fi

candidate_staging_root="$(mktemp -d /tmp/business-finlynq-rollback.XXXXXX)"
trap cleanup_early_rollback_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 -- "$candidate_staging_root"
candidate_source_root="$candidate_staging_root/repository"
mkdir -m 0700 -- "$candidate_source_root"
candidate_git_tree_file="$candidate_staging_root/candidate-git-tree.txt"
if ! git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  ls-tree -r --full-tree "$candidate_revision" >"$candidate_git_tree_file"; then
  fail "candidate Git tree could not be inspected before rollback materialization"
fi
if awk '$1 == "160000" { found = 1 } END { exit found ? 0 : 1 }' "$candidate_git_tree_file"; then
  fail "candidate Git tree contains a submodule and cannot be materialized as an exact archive"
fi
git --no-optional-locks -c safe.directory="$repository_root" -C "$repository_root" \
  archive --format=tar "$candidate_revision" \
  | tar --extract --file=- --directory="$candidate_source_root" --no-same-owner --same-permissions
read_git_output "candidate Git tree" rev-parse "$candidate_revision^{tree}"
candidate_tree_id="$git_command_output"
candidate_tree_manifest_sha256="$(sha256sum "$candidate_git_tree_file" | awk '{print $1}')"
[[ "$candidate_tree_id" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ \
  && "$candidate_tree_manifest_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "candidate Git-tree identity is invalid"
environment_snapshot_file="$(mktemp)"
install -m 0600 -- "$canonical_environment_file" "$environment_snapshot_file"
[[ "$(sha256sum "$environment_snapshot_file" | awk '{print $1}')" == "$compose_environment_sha256" ]] \
  || fail "private rollback Compose environment snapshot differs from its validated source"
environment_file="$environment_snapshot_file"

base_compose() {
  local -a compose_files=(-f "$candidate_source_root/docker-compose.yml")
  if [[ "$edge_mode" == external ]]; then
    compose_files+=(-f "$candidate_source_root/deploy/edge/docker-compose.external.yml")
  fi
  env -i "PATH=$PATH" docker compose --project-name business-finlynq \
    --project-directory "$candidate_source_root" --env-file "$environment_file" \
    "${compose_files[@]}" "$@"
}
rendered_current_compose="$(base_compose config --format json)"
deployed_revision="$(jq -r '.services.app.environment.BUSINESS_FINLYNQ_IMAGE_REVISION // empty' <<<"$rendered_current_compose")"
[[ "$deployed_revision" == "$candidate_revision" ]] \
  || fail "canonical Compose environment does not identify the candidate release"
[[ "$(jq -r '.services.app.image // empty' <<<"$rendered_current_compose")" == "business-finlynq-app:$candidate_revision" ]] \
  || fail "canonical Compose configuration does not bind the candidate app image"
[[ "$(jq -r '.services.release_router.image // empty' <<<"$rendered_current_compose")" == "$release_router_reference" \
  && "$(jq -r '.services.release_router.networks.business_finlynq_edge.aliases[0] // empty' <<<"$rendered_current_compose")" == production-app \
  && "$(jq -r '.services.app.networks.business_finlynq_frontend.aliases[0] // empty' <<<"$rendered_current_compose")" == release-app \
  && "$(jq -r '.services.app.ports | length' <<<"$rendered_current_compose")" == 0 ]] \
  || fail "canonical Compose configuration does not preserve the release-router boundary"
rollback_public_base_url="$(jq -r '.services.app.environment.APP_ORIGIN // empty' <<<"$rendered_current_compose")"
[[ "$rollback_public_base_url" == https://business.finlynq.com ]] \
  || fail "rollback public origin differs from the reviewed production origin"
rollback_router_loopback_port="$(jq -r '
  .services.release_router.ports
  | if length == 1 and .[0].target == 3000 and .[0].host_ip == "127.0.0.1"
      and .[0].protocol == "tcp"
    then .[0].published else empty end
' <<<"$rendered_current_compose")"
[[ "$rollback_router_loopback_port" =~ ^[1-9][0-9]{1,4}$ \
  && "$rollback_router_loopback_port" -le 65535 ]] \
  || fail "rollback release-router loopback binding is invalid"
rollback_router_frontend_network="$(jq -r '.networks.business_finlynq_frontend.name // empty' \
  <<<"$rendered_current_compose")"
rollback_router_control_network="$(jq -r '.networks.business_finlynq_router_control.name // empty' \
  <<<"$rendered_current_compose")"
rollback_router_edge_network="$(jq -r '.networks.business_finlynq_edge.name // empty' \
  <<<"$rendered_current_compose")"
rollback_router_public_alias="$(jq -r \
  '.services.release_router.networks.business_finlynq_edge.aliases[0] // empty' \
  <<<"$rendered_current_compose")"
[[ "$rollback_router_frontend_network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$ \
  && "$rollback_router_control_network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$ \
  && "$rollback_router_edge_network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$ \
  && "$rollback_router_public_alias" == production-app ]] \
  || fail "rollback release-router network contract is invalid"
rollback_router_state_volume="$(jq -r '.volumes.business_finlynq_release_router_state.name // empty' \
  <<<"$rendered_current_compose")"
[[ "$rollback_router_state_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}$ ]] \
  || fail "rollback release-router state volume is invalid"
unset rendered_current_compose
if ! current_app_query="$(base_compose ps --all --quiet app)"; then
  fail "could not inspect the deployed candidate app container"
fi
current_app_containers=()
while IFS= read -r current_app_candidate; do
  [[ -n "$current_app_candidate" ]] && current_app_containers+=("$current_app_candidate")
done <<<"$current_app_query"
[[ "${#current_app_containers[@]}" -eq 1 && -n "${current_app_containers[0]}" ]] \
  || fail "exactly one deployed candidate app container must exist before rollback"
current_app_container="${current_app_containers[0]}"
current_app_image_id="$(docker inspect --format '{{.Image}}' "$current_app_container")"
current_app_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$current_app_container")"
current_app_runtime_status="$(docker inspect --format '{{.State.Status}}' "$current_app_container")"
case "$current_app_runtime_status" in
  created|running|paused|restarting|removing|exited|dead) ;;
  *) fail "deployed app container returned an unknown runtime state" ;;
esac
observed_application_artifact=""
if [[ "$current_app_image_id" == "$candidate_image_id" \
  && "$current_app_revision" == "$candidate_revision" ]]; then
  observed_application_artifact="candidate"
elif [[ "$current_app_image_id" == "$previous_image_id" \
  && ( "$current_app_revision" == "$previous_revision" \
    || ( "$legacy_rollback_adapter_required" == true \
      && "$previous_revision" == "$legacy_rollback_revision" \
      && "$previous_image_id" == "$legacy_rollback_image_id" \
      && "$current_app_image_id" == "$legacy_rollback_image_id" \
      && "$rollback_compatibility_ack" == f8485-one-release-only \
      && ( -z "$current_app_revision" \
        || "$current_app_revision" == '<no value>' ) ) ) ]]; then
  # A release failure after quiescing writes but before candidate creation
  # legitimately leaves the retained previous container stopped. It is still
  # the only evidence-authorized source state and can be safely recreated from
  # the same pinned previous ID with every gate forced off.
  observed_application_artifact="previous"
else
  fail "deployed app container matches neither the evidence candidate nor retained previous artifact"
fi
observed_application_state="$observed_application_artifact:$current_app_runtime_status"

release_router_static_contract_is_valid() {
  local router_inspection="$1"
  jq -e --arg imageId "$release_router_image_id" --arg image "$release_router_reference" \
    --arg revision "$release_router_revision" --arg contract "$release_router_contract" \
    --arg stateVolume "$rollback_router_state_volume" \
    --arg frontendNetwork "$rollback_router_frontend_network" \
    --arg controlNetwork "$rollback_router_control_network" \
    --arg edgeNetwork "$rollback_router_edge_network" \
    --arg publicAlias "$rollback_router_public_alias" \
    --arg port "$rollback_router_loopback_port" '
    length == 1 and .[0].Image == $imageId and
    (.[0].Config.Image == $image or .[0].Config.Image == $imageId) and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
    .[0].Config.User == "10001:10001" and
    .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
    .[0].Config.Cmd == ["serve"] and
    .[0].Config.Healthcheck.Test ==
      ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null",
        "http://127.0.0.1:3000/_business-finlynq/release-router/live"] and
    .[0].Config.Healthcheck.Interval == 10000000000 and
    .[0].Config.Healthcheck.Timeout == 3000000000 and
    .[0].Config.Healthcheck.Retries == 3 and
    .[0].Config.Healthcheck.StartPeriod == 5000000000 and
    .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
    .[0].HostConfig.Privileged == false and .[0].HostConfig.AutoRemove == false and
    .[0].HostConfig.RestartPolicy == {"Name":"unless-stopped", "MaximumRetryCount":0} and
    ((.[0].HostConfig.CapAdd // []) | length) == 0 and
    ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
    ((.[0].HostConfig.SecurityOpt // []) | sort) == ["no-new-privileges:true"] and
    .[0].HostConfig.PidsLimit == 64 and .[0].HostConfig.Memory == 100663296 and
    .[0].HostConfig.NanoCpus == 250000000 and
    (.[0].HostConfig.PortBindings | keys) == ["3000/tcp"] and
    .[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":$port}] and
    (.[0].HostConfig.Tmpfs | keys | sort) == ["/config", "/data", "/tmp"] and
    (.[0].HostConfig.Tmpfs["/tmp"] | split(",") |
      map(select(. != "rw")) | sort) ==
      ["gid=10001", "mode=0700", "nodev", "noexec", "nosuid", "size=16m", "uid=10001"] and
    (.[0].HostConfig.Tmpfs["/config"] | split(",") |
      map(select(. != "rw")) | sort) ==
      ["gid=10001", "mode=0700", "nodev", "noexec", "nosuid", "size=1m", "uid=10001"] and
    (.[0].HostConfig.Tmpfs["/data"] | split(",") |
      map(select(. != "rw")) | sort) ==
      ["gid=10001", "mode=0700", "nodev", "noexec", "nosuid", "size=1m", "uid=10001"] and
    ((.[0].Mounts // []) | length) == 1 and
    .[0].Mounts[0].Type == "volume" and .[0].Mounts[0].Name == $stateVolume and
    .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
    ((.[0].NetworkSettings.Networks // {}) | keys | sort) ==
      ([$controlNetwork, $edgeNetwork, $frontendNetwork] | sort) and
    any(.[0].NetworkSettings.Networks[$edgeNetwork].Aliases[]?; . == $publicAlias) and
    all(.[0].NetworkSettings.Networks[$frontendNetwork].Aliases[]?; . != $publicAlias)
  ' <<<"$router_inspection" >/dev/null
}

verify_candidate_release_router_static() {
  local router_container="$1" router_inspection="${2:-}"
  [[ "$router_container" =~ ^[a-f0-9]{12,64}$ ]] \
    || fail "release-router container identity is invalid"
  if [[ -z "$router_inspection" ]]; then
    router_inspection="$(docker inspect "$router_container")" \
      || fail "deployed release-router container could not be inspected"
  fi
  release_router_static_contract_is_valid "$router_inspection" \
    || fail "deployed release router differs from the accepted immutable hardened contract"
}

verify_unique_network_alias_owner() {
  local network="$1" alias="$2" expected_container="$3" description="$4"
  local expected_full_id network_query network_container network_attachments owner_count=0
  expected_full_id="$(docker inspect --format '{{.Id}}' "$expected_container")" \
    || fail "$description expected container identity could not be inspected"
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$description expected container identity is invalid"
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}')" \
    || fail "$description network endpoints could not be enumerated"
  while IFS= read -r network_container; do
    [[ -n "$network_container" ]] || continue
    [[ "$network_container" =~ ^[a-f0-9]{64}$ ]] \
      || fail "$description network returned an invalid endpoint ID"
    network_attachments="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$network_container")" \
      || fail "$description network endpoint could not be inspected"
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$network_attachments" >/dev/null; then
      (( owner_count += 1 ))
      [[ "$network_container" == "$expected_full_id" ]] \
        || fail "$description alias is owned by another network endpoint"
    fi
  done <<<"$network_query"
  [[ "$owner_count" == 1 ]] \
    || fail "$description alias must be owned exactly once on $network"
}

verify_candidate_release_router() {
  local expected_mode="${1:-active-or-maintenance}"
  local expected_app_container="${2:-$current_app_container}"
  local router_query router_container router_full_id router_inspection tagged_image_id process_body
  local router_mode runtime_uid network_query network_container network_attachments alias_owner_count=0
  [[ "$expected_mode" == active || "$expected_mode" == maintenance \
    || "$expected_mode" == active-or-maintenance ]] \
    || fail "release-router verification requested an invalid durable mode"
  router_query="$(base_compose ps --all --quiet release_router)" \
    || fail "could not inspect the deployed release-router container"
  [[ "$router_query" =~ ^[a-f0-9]{12,64}$ && "$router_query" != *$'\n'* ]] \
    || fail "exactly one deployed release-router container must exist before rollback"
  router_container="$router_query"
  router_inspection="$(docker inspect "$router_container")" \
    || fail "deployed release-router container could not be inspected"
  verify_candidate_release_router_static "$router_container" "$router_inspection"
  router_full_id="$(jq -r '.[0].Id // empty' <<<"$router_inspection")"
  [[ "$router_full_id" =~ ^[a-f0-9]{64}$ ]] \
    || fail "deployed release-router full container identity is invalid"
  jq -e 'length == 1 and .[0].State.Status == "running" and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy"' \
    <<<"$router_inspection" >/dev/null \
    || fail "deployed release router is not running and healthy"
  tagged_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" \
    || fail "accepted release-router tag is unavailable"
  [[ "$tagged_image_id" == "$release_router_image_id" ]] \
    || fail "accepted release-router tag no longer identifies its immutable image"
  runtime_uid="$(docker exec "$router_container" id -u)" \
    || fail "release-router runtime uid could not be inspected"
  [[ "$runtime_uid" == 10001 ]] \
    || fail "release router is not running as the reviewed non-root uid"
  router_mode="$(docker exec "$router_container" sh -ec '
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  ')" || fail "release-router durable mode could not be inspected"
  [[ "$router_mode" == "$expected_mode" \
    || ( "$expected_mode" == active-or-maintenance \
      && ( "$router_mode" == active || "$router_mode" == maintenance ) ) ]] \
    || fail "release-router durable mode is not committed to $expected_mode"
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$rollback_router_edge_network" \
    --format '{{.ID}}')" \
    || fail "could not inspect every production ingress endpoint for rollback alias ownership"
  while IFS= read -r network_container; do
    [[ -n "$network_container" ]] || continue
    [[ "$network_container" =~ ^[a-f0-9]{64}$ ]] \
      || fail "Docker returned an invalid production ingress endpoint ID during alias attestation"
    network_attachments="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$network_container")" \
      || fail "a production ingress endpoint attachment could not be inspected"
    if jq -e --arg edgeNetwork "$rollback_router_edge_network" \
      --arg publicAlias "$rollback_router_public_alias" '
        has($edgeNetwork) and
        any(.[$edgeNetwork].Aliases[]?; . == $publicAlias)
      ' <<<"$network_attachments" >/dev/null; then
      (( alias_owner_count += 1 ))
      [[ "$network_container" == "$router_full_id" ]] \
        || fail "production public backend alias is owned by another ingress endpoint"
    fi
  done <<<"$network_query"
  [[ "$alias_owner_count" == 1 ]] \
    || fail "production public backend alias must be owned exactly once during rollback"
  verify_unique_network_alias_owner \
    "$rollback_router_frontend_network" release-app "$expected_app_container" \
    "rollback private application"
  process_body="$(curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$rollback_router_loopback_port/_business-finlynq/release-router/live")" \
    || fail "release-router process liveness is unavailable"
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$process_body" >/dev/null \
    || fail "release-router process liveness response is invalid"
  rollback_router_container="$router_container"
}

rollback_router_state_volume_is_valid() {
  local volume_inspection
  volume_inspection="$(docker volume inspect "$rollback_router_state_volume" 2>/dev/null)" \
    || return 1
  jq -e --arg name "$rollback_router_state_volume" '
    length == 1 and .[0].Name == $name and .[0].Driver == "local" and .[0].Scope == "local"
  ' <<<"$volume_inspection" >/dev/null
}

persist_rollback_router_mode_offline() {
  local mode="$1" retained_container="${2:-}"
  local -a state_mount
  [[ "$mode" == active || "$mode" == maintenance ]] || return 1
  if [[ -n "$retained_container" ]]; then
    [[ "$retained_container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
    state_mount=(--volumes-from "$retained_container")
  else
    rollback_router_state_volume_is_valid || return 1
    state_mount=(--mount "type=volume,src=$rollback_router_state_volume,dst=/state")
  fi
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
    "${state_mount[@]}" --entrypoint sh "$release_router_image_id" -ec '
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
    ' sh "$mode" >/dev/null
}

ensure_candidate_release_router() {
  local router_query tagged_image_id router_image_inspection router_inspection router_health
  local recovered_into_maintenance="false"
  router_image_inspection="$(docker image inspect "$release_router_reference")" \
    || fail "accepted stable release-router image is unavailable"
  tagged_image_id="$(jq -r '.[0].Id // empty' <<<"$router_image_inspection")"
  [[ "$tagged_image_id" == "$release_router_image_id" ]] \
    || fail "stable release-router tag no longer identifies the evidence-authorized image"
  jq -e --arg imageId "$release_router_image_id" --arg revision "$release_router_revision" \
    --arg contract "$release_router_contract" --arg buildProject "$release_router_build_project" '
    length == 1 and .[0].Id == $imageId and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
    .[0].Config.Labels["com.docker.compose.project"] == $buildProject and
    .[0].Config.User == "10001:10001" and
    .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
    .[0].Config.Cmd == ["serve"]
  ' <<<"$router_image_inspection" >/dev/null \
    || fail "evidence-authorized stable release-router image contract differs"

  router_query="$(base_compose ps --all --quiet release_router)" \
    || fail "could not inspect the release-router container before rollback"
  [[ -z "$router_query" || ( "$router_query" =~ ^[a-f0-9]{12,64}$ && "$router_query" != *$'\n'* ) ]] \
    || fail "release-router container inventory is ambiguous"
  if [[ -n "$router_query" ]]; then
    router_inspection="$(docker inspect "$router_query")" \
      || fail "existing release-router container could not be inspected"
    rollback_router_container="$router_query"
    verify_candidate_release_router_static "$router_query" "$router_inspection"
    if [[ "$(jq -r '.[0].State.Running' <<<"$router_inspection")" != true ]]; then
      persist_rollback_router_mode_offline maintenance "$router_query" \
        || fail "stopped release router could not be committed to maintenance before restart"
      docker start "$router_query" >/dev/null \
        || fail "evidence-authorized release router could not be restarted"
      recovered_into_maintenance="true"
    fi
  else
    # A prior fail-closed containment may have removed the listener while
    # retaining its state volume. Commit that volume to maintenance before
    # Compose is allowed to create and start a replacement listener.
    persist_rollback_router_mode_offline maintenance \
      || fail "containerless release-router state could not be committed to maintenance"
    base_compose up --detach --wait --no-deps --no-build release_router \
      || fail "evidence-authorized stable release router could not be restored"
    recovered_into_maintenance="true"
  fi

  router_query="$(base_compose ps --all --quiet release_router)" \
    || fail "restored release-router container could not be resolved"
  [[ "$router_query" =~ ^[a-f0-9]{12,64}$ && "$router_query" != *$'\n'* ]] \
    || fail "restored release-router container inventory is ambiguous"
  router_health=""
  for _ in {1..30}; do
    router_health="$(docker inspect --format '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}{{else}}{{.State.Status}}{{end}}' \
      "$router_query" 2>/dev/null || true)"
    [[ "$router_health" == healthy ]] && break
    sleep 1
  done
  [[ "$router_health" == healthy ]] \
    || fail "stable release router did not become healthy before rollback"
  if [[ "$recovered_into_maintenance" == true ]]; then
    verify_candidate_release_router maintenance
    verify_rollback_maintenance \
      || fail "recovered stable release router did not remain in maintenance"
  else
    verify_candidate_release_router
  fi
}

rollback_compose() {
  local -a compose_files=(
    -f "$candidate_source_root/docker-compose.yml"
  )
  if [[ "$edge_mode" == external ]]; then
    compose_files+=(-f "$candidate_source_root/deploy/edge/docker-compose.external.yml")
  fi
  compose_files+=(-f "$candidate_source_root/deploy/release/docker-compose.application-rollback.yml")
  local -a compatibility_environment=()
  if [[ "$legacy_rollback_adapter_required" == true ]]; then
    compose_files+=(-f "$candidate_source_root/deploy/rollback/docker-compose.legacy-inline-password.yml")
    [[ -f "$legacy_rollback_compose_override" && ! -L "$legacy_rollback_compose_override" \
      && "$(readlink -f -- "$legacy_rollback_compose_override")" == "$legacy_rollback_compose_override" ]] \
      || fail "the protected f8485 durable-adapter Compose override is unavailable"
    compose_files+=(-f "$legacy_rollback_compose_override")
    compatibility_environment+=("ROLLBACK_COMPATIBILITY_ACK=$rollback_compatibility_ack")
  fi
  env -i "PATH=$PATH" "${compatibility_environment[@]}" \
    "BUSINESS_FINLYNQ_ROLLBACK_APP_IMAGE=$previous_image_id" \
    "BUSINESS_FINLYNQ_IMAGE_REVISION=$previous_revision" \
    DEMO_LOGIN_ENABLED=false DEMO_WRITES_ENABLED=false \
    ACCOUNT_LOGIN_ENABLED=false ACCOUNT_SIGNUP_ENABLED=false \
    AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false \
    BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false YAHOO_FX_ENABLED=false \
    docker compose --project-name business-finlynq --project-directory "$candidate_source_root" \
    --env-file "$environment_file" \
    "${compose_files[@]}" "$@"
}

contain_rollback_scheduled_containers() {
  local service_name query container_id running containment_status=0
  local -a scheduled_services=(
    provision_backup
    backup
    verify_latest_backup
    verify_accounting_evidence
    reconcile_demo_sandboxes
  )
  for service_name in "${scheduled_services[@]}"; do
    if ! query="$(docker ps --quiet --no-trunc \
      --filter 'label=com.docker.compose.project=business-finlynq' \
      --filter "label=com.docker.compose.service=$service_name")"; then
      containment_status=1
      continue
    fi
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] || continue
      if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
        containment_status=1
        continue
      fi
      docker stop --time 30 "$container_id" >/dev/null 2>&1 || true
      running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" \
        || running="removed"
      if [[ "$running" == true ]]; then
        docker kill "$container_id" >/dev/null 2>&1 || true
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" \
          || running="removed"
      fi
      [[ "$running" == false || "$running" == removed ]] \
        || containment_status=1
    done <<<"$query"
  done
  for service_name in "${scheduled_services[@]}"; do
    query="$(docker ps --quiet --no-trunc \
      --filter 'label=com.docker.compose.project=business-finlynq' \
      --filter "label=com.docker.compose.service=$service_name" 2>/dev/null)" \
      || {
        containment_status=1
        continue
      }
    [[ -z "$query" ]] || containment_status=1
  done
  return "$containment_status"
}

contain_failed_rollback() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )) && [[ "$rollback_containment_armed" == "true" ]]; then
    if [[ "$rollback_scheduler_pause_attempted" == "true" \
      && "$rollback_schedulers_paused" != "true" ]]; then
      contain_rollback_scheduled_containers || printf '%s\n' \
        "URGENT: failed rollback could not prove scheduled mutator containers quiescent." >&2
      if timeout --signal=TERM --kill-after=5s 2m \
        bash "$candidate_source_root/deploy/release/pause-schedulers.sh" \
          "$scheduler_mode" --allow-already-paused >/dev/null 2>&1; then
        rollback_schedulers_paused="true"
      else
        printf '%s\n' \
          "URGENT: failed rollback could not complete scheduler pause during containment." >&2
        contain_rollback_scheduled_containers || printf '%s\n' \
          "URGENT: scheduled mutator containers remain after rollback containment retry." >&2
      fi
    fi
    if ! force_rollback_router_maintenance; then
      if [[ "$rollback_router_container" =~ ^[a-f0-9]{12,64}$ ]]; then
        docker stop --time 30 "$rollback_router_container" >/dev/null 2>&1 || true
      fi
      printf '%s\n' \
        "URGENT: failed rollback could not prove router maintenance; the stable router was stopped fail-closed." >&2
    fi
    if ! rollback_compose --profile auth-email stop --timeout 30 auth_email_worker app >/dev/null 2>&1; then
      printf '%s\n' "URGENT: failed rollback acceptance could not stop the retained app and authentication worker" >&2
    fi
  fi
  if [[ -n "$rollback_evidence_temporary" ]]; then
    rm -f -- "$rollback_evidence_temporary" >/dev/null 2>&1 || true
  fi
  cleanup_rollback_transients || status=1
  exit "$status"
}
trap contain_failed_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

persist_rollback_router_mode_online() {
  local mode="$1"
  [[ "$mode" == active || "$mode" == maintenance ]] || return 1
  [[ "$rollback_router_container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  docker exec "$rollback_router_container" sh -ec '
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
  ' sh "$mode"
}

reload_rollback_router_configuration() {
  local selected_config="$1"
  [[ "$selected_config" == Caddyfile || "$selected_config" == Caddyfile.maintenance ]] \
    || fail "rollback requested an unknown release-router configuration"
  verify_candidate_release_router
  if [[ "$selected_config" == Caddyfile.maintenance ]]; then
    [[ "$rollback_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
      || fail "rollback maintenance token is unavailable"
    docker exec --env \
      "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$rollback_acceptance_token" \
      "$rollback_router_container" caddy reload \
      --config /etc/caddy/Caddyfile.maintenance --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock
  else
    docker exec "$rollback_router_container" caddy reload \
      --config /etc/caddy/Caddyfile --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock
  fi
}

verify_rollback_maintenance() {
  local headers="$candidate_staging_root/rollback-maintenance.headers"
  local body="$candidate_staging_root/rollback-maintenance.json"
  local route_headers="$candidate_staging_root/rollback-maintenance-route.headers"
  local route_body="$candidate_staging_root/rollback-maintenance-route.txt"
  local live status route_status attempt
  for attempt in {1..15}; do
    if live="$(curl --fail --silent --show-error --max-time 5 \
      "$rollback_public_base_url/api/live" 2>/dev/null)" \
      && jq -e 'type == "object" and keys == ["status"] and .status == "live"' \
        <<<"$live" >/dev/null; then
      status=""
      if status="$(curl --silent --show-error --max-time 10 \
        --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
        "$rollback_public_base_url/api/health" 2>/dev/null)" \
        && [[ "$status" == 503 ]] \
        && jq -e 'type == "object" and keys == ["status"] and .status == "unavailable"' \
          "$body" >/dev/null \
        && grep -Eiq '^cache-control:.*no-store' "$headers" \
        && grep -Eiq '^retry-after:[[:space:]]*5[[:space:]]*$' "$headers"; then
        route_status="$(curl --silent --show-error --max-time 10 \
          --dump-header "$route_headers" --output "$route_body" --write-out '%{http_code}' \
          "$rollback_public_base_url/" 2>/dev/null || true)"
        if [[ "$route_status" == 503 \
          && "$(tr -d '\r' <"$route_body")" == "Service temporarily unavailable." ]] \
          && grep -Eiq '^cache-control:.*no-store' "$route_headers" \
          && grep -Eiq '^retry-after:[[:space:]]*5[[:space:]]*$' "$route_headers"; then
          rollback_maintenance_confirmed="true"
          return 0
        fi
      fi
    fi
    sleep 2
  done
  return 1
}

enter_rollback_maintenance() {
  rollback_acceptance_token="$(openssl rand -hex 32)" \
    || fail "rollback maintenance token generation failed"
  [[ "$rollback_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
    || fail "rollback maintenance token is invalid"
  persist_rollback_router_mode_online maintenance \
    || fail "rollback release-router maintenance mode could not be committed"
  reload_rollback_router_configuration Caddyfile.maintenance
  verify_rollback_maintenance \
    || fail "release router did not establish graceful maintenance before application rollback"
}

rollback_public_alias_has_exact_owner() {
  local expected_full_id network_query network_container network_attachments owner_count=0
  [[ "$rollback_router_container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  expected_full_id="$(docker inspect --format '{{.Id}}' "$rollback_router_container" 2>/dev/null)" \
    || return 1
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$rollback_router_edge_network" --format '{{.ID}}' 2>/dev/null)" \
    || return 1
  while IFS= read -r network_container; do
    [[ -n "$network_container" ]] || continue
    [[ "$network_container" =~ ^[a-f0-9]{64}$ ]] || return 1
    network_attachments="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$network_container" 2>/dev/null)" \
      || return 1
    if jq -e --arg network "$rollback_router_edge_network" \
      --arg alias "$rollback_router_public_alias" '
        has($network) and any(.[$network].Aliases[]?; . == $alias)
      ' <<<"$network_attachments" >/dev/null 2>&1; then
      (( owner_count += 1 ))
      [[ "$network_container" == "$expected_full_id" ]] || return 1
    fi
  done <<<"$network_query"
  [[ "$owner_count" == 1 ]]
}

force_rollback_router_maintenance() {
  local token status running router_inspection
  if [[ ! "$rollback_router_container" =~ ^[a-f0-9]{12,64}$ ]]; then
    persist_rollback_router_mode_offline maintenance >/dev/null 2>&1 || return 1
    return 1
  fi
  router_inspection="$(docker inspect "$rollback_router_container" 2>/dev/null)" || return 1
  release_router_static_contract_is_valid "$router_inspection" || return 1
  running="$(jq -r '.[0].State.Running' <<<"$router_inspection")"
  if [[ "$running" != true ]]; then
    persist_rollback_router_mode_offline maintenance "$rollback_router_container" \
      >/dev/null 2>&1 || return 1
    rollback_public_alias_has_exact_owner || return 1
    return 0
  fi
  persist_rollback_router_mode_online maintenance >/dev/null 2>&1 || return 1
  token="$rollback_acceptance_token"
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || token="$(openssl rand -hex 32 2>/dev/null)" \
    || return 1
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || return 1
  docker exec --env "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$token" \
    "$rollback_router_container" caddy reload \
    --config /etc/caddy/Caddyfile.maintenance --adapter caddyfile \
    --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 || return 1
  status="$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' "$rollback_public_base_url/api/health" 2>/dev/null)" \
    || return 1
  [[ "$status" == 503 ]] || return 1
  rollback_public_alias_has_exact_owner
}

rollback_watchdog_marker_is_valid() {
  local marker="$1" expected="$2"
  [[ "$marker" == "$rollback_watchdog_ready_file" \
    || "$marker" == "$rollback_watchdog_disarm_file" ]] \
    || return 1
  [[ -f "$marker" && ! -L "$marker" \
    && "$(readlink -f -- "$marker")" == "$marker" \
    && "$(stat -c '%u:%a:%h' -- "$marker")" \
      == "$rollback_watchdog_owner_uid:600:1" \
    && "$(<"$marker")" == "$expected" ]]
}

write_protected_rollback_watchdog_marker() {
  local marker="$1" value="$2" temporary="$1.partial.$BASHPID"
  [[ "$marker" == "$rollback_watchdog_ready_file" \
    || "$marker" == "$rollback_watchdog_disarm_file" ]] \
    || return 1
  [[ ! -e "$marker" && ! -L "$marker" \
    && ! -e "$temporary" && ! -L "$temporary" ]] \
    || return 1
  printf '%s\n' "$value" >"$temporary" || return 1
  chmod 0600 -- "$temporary" || return 1
  [[ -f "$temporary" && ! -L "$temporary" \
    && "$(readlink -f -- "$temporary")" == "$temporary" \
    && "$(stat -c '%u:%a:%h' -- "$temporary")" \
      == "$rollback_watchdog_owner_uid:600:1" ]] \
    || return 1
  sync -f -- "$temporary" || return 1
  mv -- "$temporary" "$marker" || return 1
  sync -f -- "$candidate_staging_root" || return 1
  rollback_watchdog_marker_is_valid "$marker" "$value"
}

rollback_watchdog_lock_fds_are_valid() {
  local watchdog_pid="$1" coordination_fd_identity coordination_path_identity
  [[ "$watchdog_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  coordination_fd_identity="$(stat -Lc '%u:%g:%a:%h' \
    -- "/proc/$watchdog_pid/fd/9" 2>/dev/null)" || return 1
  coordination_path_identity="$(stat -c '%u:%g:%a:%h' \
    -- "$coordination_lock_file" 2>/dev/null)" || return 1
  [[ "$(readlink -f -- "/proc/$watchdog_pid/fd/8" 2>/dev/null)" \
      == "$host_deployment_lock" \
    && "$(stat -Lc '%u:%g:%a:%h' -- "/proc/$watchdog_pid/fd/8" 2>/dev/null)" \
      == "0:$deploy_gid:660:1" \
    && "$(readlink -f -- "/proc/$watchdog_pid/fd/9" 2>/dev/null)" \
      == "$coordination_lock_file" \
    && "$coordination_fd_identity" == "$coordination_path_identity" \
    && "$coordination_fd_identity" == "$deploy_uid:"*":600:1" ]]
}

stop_exact_scoped_rollback_service() {
  local service_name="$1" query container_id inspection running containment_status=0
  case "$service_name" in
    release_router|app|auth_email_worker) ;;
    *) return 1 ;;
  esac
  query="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq' \
    --filter "label=com.docker.compose.service=$service_name" 2>/dev/null)" \
    || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || {
      containment_status=1
      continue
    }
    inspection="$(docker inspect "$container_id" 2>/dev/null)" || {
      containment_status=1
      continue
    }
    jq -e --arg id "$container_id" --arg service "$service_name" '
      length == 1 and .[0].Id == $id and
      .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
      .[0].Config.Labels["com.docker.compose.service"] == $service
    ' <<<"$inspection" >/dev/null 2>&1 || {
      containment_status=1
      continue
    }
    running="$(jq -r '.[0].State.Running' <<<"$inspection")"
    if [[ "$running" == true ]]; then
      docker stop --time 30 "$container_id" >/dev/null 2>&1 || true
      running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" \
        || running="removed"
      if [[ "$running" == true ]]; then
        docker kill "$container_id" >/dev/null 2>&1 || true
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" \
          || running="removed"
      fi
      [[ "$running" == false || "$running" == removed ]] \
        || containment_status=1
    elif [[ "$running" != false ]]; then
      containment_status=1
    fi
  done <<<"$query"
  query="$(docker ps --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq' \
    --filter "label=com.docker.compose.service=$service_name" 2>/dev/null)" \
    || return 1
  [[ -z "$query" ]] || containment_status=1
  return "$containment_status"
}

contain_parentless_rollback() {
  local containment_status=0 service_name
  if ! force_rollback_router_maintenance \
    || ! rollback_public_alias_has_exact_owner; then
    for service_name in release_router app auth_email_worker; do
      stop_exact_scoped_rollback_service "$service_name" || containment_status=1
    done
    persist_rollback_router_mode_offline maintenance >/dev/null 2>&1 \
      || containment_status=1
    printf '%s\n' \
      "URGENT: parentless rollback could not prove exact router maintenance; scoped router and application services were stopped fail-closed." >&2
  fi

  contain_rollback_scheduled_containers || containment_status=1
  if [[ -f "$candidate_source_root/deploy/release/pause-schedulers.sh" \
    && ! -L "$candidate_source_root/deploy/release/pause-schedulers.sh" ]]; then
    timeout --signal=TERM --kill-after=5s 2m \
      bash "$candidate_source_root/deploy/release/pause-schedulers.sh" \
        "$scheduler_mode" --allow-already-paused >/dev/null 2>&1 \
      || containment_status=1
  else
    containment_status=1
  fi
  contain_rollback_scheduled_containers || containment_status=1
  return "$containment_status"
}

rollback_sigkill_watchdog_main() {
  local parent_pid="$rollback_watchdog_parent_pid"
  local watchdog_pid="$BASHPID" observed_parent_pid
  local ready_value="ready:$rollback_watchdog_token:$rollback_watchdog_parent_pid"
  local disarm_value="disarmed:$rollback_watchdog_token:$rollback_watchdog_parent_pid"
  trap - EXIT
  trap ':' HUP INT TERM
  set +Ee
  if ! rollback_watchdog_lock_fds_are_valid "$watchdog_pid"; then
    printf '%s\n' \
      "URGENT: rollback SIGKILL watchdog did not inherit both deployment locks." >&2
    contain_parentless_rollback || true
    return 1
  fi
  if ! write_protected_rollback_watchdog_marker \
    "$rollback_watchdog_ready_file" "$ready_value"; then
    printf '%s\n' \
      "URGENT: rollback SIGKILL watchdog could not publish its protected ready marker." >&2
    contain_parentless_rollback || true
    return 1
  fi
  while :; do
    rollback_watchdog_marker_is_valid "$rollback_watchdog_disarm_file" "$disarm_value" \
      && return 0
    observed_parent_pid="$(awk '$1 == "PPid:" { print $2 }' \
      "/proc/$watchdog_pid/status" 2>/dev/null)" || break
    [[ "$observed_parent_pid" == "$parent_pid" ]] || break
    kill -0 "$parent_pid" 2>/dev/null || break
    sleep 1
  done
  rollback_watchdog_marker_is_valid "$rollback_watchdog_disarm_file" "$disarm_value" \
    && return 0
  printf '%s\n' \
    "URGENT: rollback parent died while live routing was only in memory; watchdog is forcing fail-closed containment." >&2
  contain_parentless_rollback || {
    printf '%s\n' \
      "URGENT: rollback SIGKILL watchdog could not prove complete parentless containment." >&2
    return 1
  }
}

arm_rollback_sigkill_watchdog() {
  local ready_value attempt
  [[ -z "$rollback_watchdog_pid" ]] \
    || fail "rollback SIGKILL watchdog is already armed"
  [[ -d "$candidate_staging_root" && ! -L "$candidate_staging_root" \
    && "$(readlink -f -- "$candidate_staging_root")" == "$candidate_staging_root" \
    && "$(stat -c '%u:%a' -- "$candidate_staging_root")" == "$(id -u):700" ]] \
    || fail "rollback SIGKILL watchdog staging directory is unsafe"
  rollback_watchdog_parent_pid="$BASHPID"
  rollback_watchdog_owner_uid="$(id -u)"
  rollback_watchdog_token="$(openssl rand -hex 32)" \
    || fail "rollback SIGKILL watchdog token generation failed"
  [[ "$rollback_watchdog_parent_pid" =~ ^[1-9][0-9]*$ \
    && "$rollback_watchdog_token" =~ ^[a-f0-9]{64}$ ]] \
    || fail "rollback SIGKILL watchdog identity is invalid"
  rollback_watchdog_ready_file="$candidate_staging_root/rollback-watchdog.ready"
  rollback_watchdog_disarm_file="$candidate_staging_root/rollback-watchdog.disarmed"
  [[ ! -e "$rollback_watchdog_ready_file" && ! -L "$rollback_watchdog_ready_file" \
    && ! -e "$rollback_watchdog_disarm_file" && ! -L "$rollback_watchdog_disarm_file" ]] \
    || fail "rollback SIGKILL watchdog marker targets are unsafe"
  rollback_sigkill_watchdog_main &
  rollback_watchdog_pid="$!"
  [[ "$rollback_watchdog_pid" =~ ^[1-9][0-9]*$ ]] \
    || fail "rollback SIGKILL watchdog process identity is invalid"
  ready_value="ready:$rollback_watchdog_token:$rollback_watchdog_parent_pid"
  for attempt in {1..100}; do
    if rollback_watchdog_marker_is_valid "$rollback_watchdog_ready_file" "$ready_value"; then
      kill -0 "$rollback_watchdog_pid" 2>/dev/null \
        || fail "rollback SIGKILL watchdog exited after arming"
      return 0
    fi
    if ! kill -0 "$rollback_watchdog_pid" 2>/dev/null; then
      wait "$rollback_watchdog_pid" >/dev/null 2>&1 || true
      rollback_watchdog_pid=""
      fail "rollback SIGKILL watchdog exited before arming"
    fi
    sleep 0.1
  done
  fail "rollback SIGKILL watchdog did not arm before live routing"
}

disarm_rollback_sigkill_watchdog() {
  local disarm_value
  [[ "$rollback_watchdog_pid" =~ ^[1-9][0-9]*$ \
    && "$rollback_watchdog_parent_pid" == "$BASHPID" \
    && "$rollback_watchdog_token" =~ ^[a-f0-9]{64}$ ]] \
    || fail "rollback SIGKILL watchdog cannot be disarmed from this process"
  kill -0 "$rollback_watchdog_pid" 2>/dev/null \
    || fail "rollback SIGKILL watchdog exited before durable acceptance"
  disarm_value="disarmed:$rollback_watchdog_token:$rollback_watchdog_parent_pid"
  write_protected_rollback_watchdog_marker \
    "$rollback_watchdog_disarm_file" "$disarm_value" \
    || fail "rollback SIGKILL watchdog could not be disarmed safely"
  wait "$rollback_watchdog_pid" \
    || fail "rollback SIGKILL watchdog failed while being reaped"
  rollback_watchdog_pid=""
}

wait_for_rollback_router_drain() {
  local connection_count=""
  for _ in {1..60}; do
    connection_count="$(docker exec "$rollback_router_container" sh -ec '
      awk '\''$4 == "01" && $3 ~ /:0BB8$/ { count++ } END { print count + 0 }'\'' \
        /proc/net/tcp /proc/net/tcp6
    ')" || fail "rollback release-router upstream drain could not be inspected"
    [[ "$connection_count" =~ ^[0-9]+$ ]] \
      || fail "rollback release-router upstream drain returned an invalid count"
    [[ "$connection_count" == 0 ]] && return 0
    sleep 1
  done
  fail "in-flight application requests did not drain before rollback"
}

activate_rollback_router_live() {
  # Keep the crash restart choice on maintenance until public readiness and
  # the rollback acceptance record are both durably committed.
  reload_rollback_router_configuration Caddyfile
}

commit_rollback_router_active() {
  persist_rollback_router_mode_online active \
    || fail "accepted rollback could not commit the release router to active mode"
}

legacy_rollback_adapter_is_valid() {
  [[ -d "$production_configuration_directory" \
    && ! -L "$production_configuration_directory" \
    && "$(readlink -f -- "$production_configuration_directory")" \
      == "$production_configuration_directory" \
    && "$(stat -c '%u:%g:%a' -- "$production_configuration_directory")" \
      == "0:$deploy_gid:750" \
    && -d "$legacy_rollback_adapter_root" \
    && ! -L "$legacy_rollback_adapter_root" \
    && "$(readlink -f -- "$legacy_rollback_adapter_root")" \
      == "$legacy_rollback_adapter_root" \
    && "$(stat -c '%u:%g:%a' -- "$legacy_rollback_adapter_root")" == 0:0:755 \
    && -d "$legacy_rollback_adapter_directory" \
    && ! -L "$legacy_rollback_adapter_directory" \
    && "$(readlink -f -- "$legacy_rollback_adapter_directory")" \
      == "$legacy_rollback_adapter_directory" \
    && "$(stat -c '%u:%g:%a' -- "$legacy_rollback_adapter_directory")" == 0:0:755 \
    && -f "$legacy_rollback_adapter_path" \
    && ! -L "$legacy_rollback_adapter_path" \
    && "$(readlink -f -- "$legacy_rollback_adapter_path")" == "$legacy_rollback_adapter_path" \
    && "$(stat -c '%u:%g:%a:%h' -- "$legacy_rollback_adapter_path")" == 0:0:555:1 \
    && "$(sha256sum "$legacy_rollback_adapter_path" | awk '{print $1}')" \
      == "$legacy_rollback_adapter_sha256" ]]
}

prepare_durable_legacy_rollback_adapter() {
  local candidate_adapter="$candidate_source_root/deploy/rollback/legacy-inline-db-password-entrypoint.sh"
  local override_temporary
  [[ -f "$candidate_adapter" && ! -L "$candidate_adapter" \
    && "$(readlink -f -- "$candidate_adapter")" == "$candidate_adapter" \
    && "$(stat -c '%a' -- "$candidate_adapter")" == 755 \
    && "$(sha256sum "$candidate_adapter" | awk '{print $1}')" \
      == "$legacy_rollback_adapter_sha256" ]] \
    || fail "the candidate f8485 adapter does not match its reviewed exact content"

  if ! legacy_rollback_adapter_is_valid; then
    [[ "$(id -u)" == 0 ]] \
      || fail "the f8485 rollback requires root to install or repair its protected durable adapter"
    [[ -d "$production_configuration_directory" \
      && ! -L "$production_configuration_directory" \
      && "$(readlink -f -- "$production_configuration_directory")" \
        == "$production_configuration_directory" \
      && "$(stat -c '%u:%g:%a' -- "$production_configuration_directory")" \
        == "0:$deploy_gid:750" ]] \
      || fail "the protected production configuration directory is unavailable"
    if [[ -e "$legacy_rollback_adapter_root" || -L "$legacy_rollback_adapter_root" ]]; then
      [[ -d "$legacy_rollback_adapter_root" && ! -L "$legacy_rollback_adapter_root" \
        && "$(readlink -f -- "$legacy_rollback_adapter_root")" \
          == "$legacy_rollback_adapter_root" \
        && "$(stat -c '%u:%g:%a' -- "$legacy_rollback_adapter_root")" == 0:0:755 ]] \
        || fail "the f8485 durable adapter root is unsafe"
    else
      install -d -o root -g root -m 0755 -- "$legacy_rollback_adapter_root"
    fi
    if [[ -e "$legacy_rollback_adapter_directory" \
      || -L "$legacy_rollback_adapter_directory" ]]; then
      [[ -d "$legacy_rollback_adapter_directory" \
        && ! -L "$legacy_rollback_adapter_directory" \
        && "$(readlink -f -- "$legacy_rollback_adapter_directory")" \
          == "$legacy_rollback_adapter_directory" \
        && "$(stat -c '%u:%g:%a' -- "$legacy_rollback_adapter_directory")" == 0:0:755 ]] \
        || fail "the f8485 revision-scoped durable adapter directory is unsafe"
    else
      install -d -o root -g root -m 0755 -- "$legacy_rollback_adapter_directory"
    fi
    if [[ -e "$legacy_rollback_adapter_path" || -L "$legacy_rollback_adapter_path" ]]; then
      legacy_rollback_adapter_is_valid \
        || fail "the installed f8485 durable adapter differs from its protected contract"
    else
      legacy_rollback_adapter_temporary="$legacy_rollback_adapter_path.partial.$BASHPID"
      [[ ! -e "$legacy_rollback_adapter_temporary" \
        && ! -L "$legacy_rollback_adapter_temporary" ]] \
        || fail "the f8485 durable adapter temporary target already exists or is unsafe"
      install -o root -g root -m 0555 -- \
        "$candidate_adapter" "$legacy_rollback_adapter_temporary"
      [[ "$(stat -c '%u:%g:%a:%h' -- "$legacy_rollback_adapter_temporary")" == 0:0:555:1 \
        && "$(sha256sum "$legacy_rollback_adapter_temporary" | awk '{print $1}')" \
          == "$legacy_rollback_adapter_sha256" ]] \
        || fail "the staged f8485 durable adapter differs from its protected contract"
      sync -f -- "$legacy_rollback_adapter_temporary"
      mv -- "$legacy_rollback_adapter_temporary" "$legacy_rollback_adapter_path"
      legacy_rollback_adapter_temporary=""
      sync -f -- "$legacy_rollback_adapter_directory"
      legacy_rollback_adapter_is_valid \
        || fail "the f8485 durable adapter was not installed safely"
    fi
  fi

  legacy_rollback_compose_override="$candidate_staging_root/docker-compose.legacy-durable-adapter.json"
  override_temporary="$legacy_rollback_compose_override.partial.$BASHPID"
  [[ ! -e "$legacy_rollback_compose_override" && ! -L "$legacy_rollback_compose_override" \
    && ! -e "$override_temporary" && ! -L "$override_temporary" ]] \
    || fail "the f8485 durable-adapter Compose override target is unsafe"
  jq -n --arg source "$legacy_rollback_adapter_path" '{
    services: {app: {volumes: [{
      type: "bind",
      source: $source,
      target: "/usr/local/bin/business-finlynq-legacy-db-password",
      read_only: true
    }]}}
  }' >"$override_temporary"
  chmod 0600 -- "$override_temporary"
  sync -f -- "$override_temporary"
  mv -- "$override_temporary" "$legacy_rollback_compose_override"
  sync -f -- "$candidate_staging_root"
  [[ -f "$legacy_rollback_compose_override" && ! -L "$legacy_rollback_compose_override" \
    && "$(readlink -f -- "$legacy_rollback_compose_override")" \
      == "$legacy_rollback_compose_override" \
    && "$(stat -c '%u:%a:%h' -- "$legacy_rollback_compose_override")" \
      == "$(id -u):600:1" ]] \
    || fail "the f8485 durable-adapter Compose override was not staged safely"
}

verify_rollback_public_readiness() {
  local public_health="" status=""
  for _ in {1..30}; do
    status="$(curl --silent --show-error --max-time 15 --output "$candidate_staging_root/rollback-public-health.json" \
      --write-out '%{http_code}' "$rollback_public_base_url/api/health" 2>/dev/null || true)"
    if [[ "$status" == 200 ]]; then
      public_health="$(<"$candidate_staging_root/rollback-public-health.json")"
      if jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
        <<<"$public_health" >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  fail "rollback application did not become ready through the public release router"
}

if [[ "$legacy_rollback_adapter_required" == true ]]; then
  prepare_durable_legacy_rollback_adapter
fi
rendered_rollback_compose="$(rollback_compose config --format json)" \
  || fail "rollback Compose configuration could not be rendered"
jq -e --arg imageId "$previous_image_id" '
  .services.app.image == $imageId and
  .services.app.pull_policy == "never" and
  (.services.app.build == null)
' <<<"$rendered_rollback_compose" >/dev/null \
  || fail "rollback Compose configuration is not pinned to the retained image"
if [[ "$legacy_rollback_adapter_required" == true ]]; then
  legacy_adapter_source="$legacy_rollback_adapter_path"
  legacy_rollback_adapter_is_valid \
    || fail "the exact f8485 durable credential adapter is unavailable or unsafe"
  jq -e --arg imageId "$legacy_rollback_image_id" \
    --arg revision "$legacy_rollback_revision" \
    --arg source "$legacy_adapter_source" '
    . as $root |
    $root.services.app.image == $imageId and
    $root.services.app.entrypoint ==
      ["/bin/sh", "/usr/local/bin/business-finlynq-legacy-db-password"] and
    $root.services.app.command == ["node", "server.js"] and
    $root.services.app.environment.BUSINESS_FINLYNQ_IMAGE_REVISION == $revision and
    $root.services.app.environment.ROLLBACK_COMPATIBILITY_ACK == "f8485-one-release-only" and
    (["ACCOUNT_LOGIN_ENABLED", "ACCOUNT_SIGNUP_ENABLED",
      "SIGNUP_TURNSTILE_ENABLED", "AUTH_EMAIL_DELIVERY_ENABLED",
      "BUSINESS_WRITES_ENABLED", "BANK_FEEDS_ENABLED", "YAHOO_FX_ENABLED",
      "DEMO_LOGIN_ENABLED", "DEMO_WRITES_ENABLED"] |
      all(. as $gate; $root.services.app.environment[$gate] == "false")) and
    ([$root.services.app.volumes[] |
      select(.type == "bind" and .source == $source and
        .target == "/usr/local/bin/business-finlynq-legacy-db-password" and
        .read_only == true)] | length) == 1
  ' <<<"$rendered_rollback_compose" >/dev/null \
    || fail "the rendered f8485 rollback adapter differs from its reviewed contract"
fi
unset rendered_rollback_compose

rollback_containment_armed="true"
ensure_candidate_release_router
verify_candidate_release_router
rollback_scheduler_pause_attempted="true"
bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" --allow-already-paused
rollback_schedulers_paused="true"
enter_rollback_maintenance

rollback_compose --profile auth-email stop --timeout 60 auth_email_worker
if ! running_auth_worker="$(rollback_compose --profile auth-email \
  ps --status running --quiet auth_email_worker)"; then
  fail "could not verify authentication-worker containment during rollback"
fi
[[ -z "$running_auth_worker" ]] \
  || fail "authentication worker remains active during rollback"
wait_for_rollback_router_drain
rollback_compose stop --timeout 60 app
verify_rollback_maintenance \
  || fail "release router did not retain maintenance while the candidate app stopped"
rollback_compose up --detach --no-deps --no-build --force-recreate app
rollback_container="$(rollback_compose ps --quiet app)"
[[ -n "$rollback_container" ]] || fail "rollback application container is missing"
[[ "$(docker inspect --format '{{.Image}}' "$rollback_container")" == "$previous_image_id" ]] \
  || fail "rollback container is not using the retained image"
if [[ "$legacy_rollback_adapter_required" == true ]]; then
  rollback_container_inspection="$(docker inspect "$rollback_container")" \
    || fail "the f8485 rollback container could not be inspected"
  jq -e --arg source "$legacy_rollback_adapter_path" '
    length == 1 and
    ([.[0].Mounts[]? | select(
      .Type == "bind" and .Source == $source and
      .Destination == "/usr/local/bin/business-finlynq-legacy-db-password" and
      .RW == false
    )] | length) == 1
  ' <<<"$rollback_container_inspection" >/dev/null \
    || fail "the f8485 rollback container is not using the protected durable adapter"
  unset rollback_container_inspection
fi
verify_unique_network_alias_owner \
  "$rollback_router_frontend_network" release-app "$rollback_container" \
  "restored private application"

for _ in {1..60}; do
  rollback_readiness_valid="false"
  if body="$(curl --fail --silent --show-error --max-time 5 \
    --header 'X-Business-Finlynq-Internal-Health: 1' \
    http://127.0.0.1:3100/api/health 2>/dev/null)"; then
    if [[ "$legacy_rollback_adapter_required" == true ]]; then
      jq -e '.status == "ready"' <<<"$body" >/dev/null \
        && rollback_readiness_valid="true"
    else
      jq -e --arg revision "$previous_revision" \
        '.status == "ready" and .revision == $revision
          and .checks.accountAuthentication == "disabled"
          and .checks.accountSignup == "disabled"
          and .checks.emailWorker == "disabled"
          and .checks.bankFeeds == "disabled"' <<<"$body" >/dev/null \
        && rollback_readiness_valid="true"
    fi
  fi
  if [[ "$rollback_readiness_valid" == true ]]; then
    verify_candidate_release_router active-or-maintenance "$rollback_container"
    verify_rollback_maintenance \
      || fail "public traffic escaped maintenance before rollback acceptance completed"
    rollback_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$rollback_container")"
    for disabled_gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED \
      ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED SIGNUP_TURNSTILE_ENABLED \
      BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED YAHOO_FX_ENABLED; do
      gate_value="$(awk -F= -v key="$disabled_gate" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' <<<"$rollback_environment")"
      [[ "$gate_value" == "false" ]] || fail "rollback gate is not disabled: $disabled_gate"
    done
    [[ -f "$canonical_environment_file" && ! -L "$canonical_environment_file" \
      && "$(readlink -f -- "$canonical_environment_file")" == "$canonical_environment_file" \
      && "$(stat -c '%a' -- "$canonical_environment_file")" == "$environment_mode" \
      && "$(stat -c '%u' -- "$canonical_environment_file")" == "$environment_owner" \
      && "$(sha256sum "$canonical_environment_file" | awk '{print $1}')" == "$compose_environment_sha256" ]] \
      || fail "canonical Compose environment changed during rollback acceptance"
    read_git_output "rollback-acceptance HEAD" rev-parse HEAD
    [[ "$git_command_output" == "$candidate_revision" ]] \
      || fail "canonical candidate checkout changed during rollback acceptance"
    read_git_output "rollback-acceptance Git tree" rev-parse "$candidate_revision^{tree}"
    [[ "$git_command_output" == "$candidate_tree_id" ]] \
      || fail "canonical candidate checkout changed during rollback acceptance"
    assert_clean_checkout "canonical candidate checkout changed during rollback acceptance"
    verify_unique_network_alias_owner \
      "$rollback_router_frontend_network" release-app "$rollback_container" \
      "accepted rollback private application"
    if [[ "$legacy_rollback_adapter_required" == true ]]; then
      legacy_rollback_adapter_is_valid \
        || fail "the protected f8485 durable adapter changed during rollback acceptance"
    fi
    arm_rollback_sigkill_watchdog
    activate_rollback_router_live
    verify_rollback_public_readiness
    if [[ "$legacy_rollback_adapter_required" == true ]]; then
      ROLLBACK_APP_URL="http://127.0.0.1:$rollback_router_loopback_port" \
        bash "$candidate_source_root/deploy/rollback/verify-legacy-app.sh"
    fi
    verify_candidate_release_router maintenance "$rollback_container"
    if [[ "$edge_mode" == external ]]; then
      external_edge_rollback_arguments=(
        --scope production --warmup-host production
        --allow-production-router-maintenance
        --expected-production-revision "$previous_revision"
      )
      if [[ "$legacy_rollback_adapter_required" == true ]]; then
        external_edge_rollback_arguments+=(--allow-f8485-minimal-production-health)
      fi
      bash "$candidate_source_root/deploy/edge/verify-external-edge.sh" \
        "${external_edge_rollback_arguments[@]}"
    fi
    rollback_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    rollback_compact="${rollback_completed_at//-/}"
    rollback_compact="${rollback_compact//:/}"
    rollback_evidence_file="$(dirname -- "$evidence_directory")/rollback_${rollback_compact}_${candidate_revision:0:12}.json"
    [[ ! -e "$rollback_evidence_file" ]] || fail "rollback evidence target already exists"
    rollback_evidence_temporary="${rollback_evidence_file}.partial.$$"
    [[ ! -e "$rollback_evidence_temporary" && ! -L "$rollback_evidence_temporary" ]] \
      || fail "rollback evidence temporary target already exists or is unsafe"
    jq -n \
      --arg completedAt "$rollback_completed_at" \
      --arg scheduler "$scheduler_mode" \
      --arg sourceEvidence "$(basename -- "$evidence_directory")" \
      --arg sourceEvidenceSha256 "$(sha256sum "$evidence_directory/SHA256SUMS" | awk '{print $1}')" \
      --arg candidateRevision "$candidate_revision" \
      --arg candidateTreeId "$candidate_tree_id" \
      --arg candidateTreeManifestSha256 "$candidate_tree_manifest_sha256" \
      --arg observedApplicationState "$observed_application_state" \
      --arg observedApplicationArtifact "$observed_application_artifact" \
      --arg observedApplicationRuntimeStatus "$current_app_runtime_status" \
      --arg observedApplicationImageId "$current_app_image_id" \
      --arg observedApplicationRevision "$current_app_revision" \
      --arg rollbackRevision "$previous_revision" \
      --arg rollbackImageId "$previous_image_id" \
      --arg releaseRouterContainerId "$rollback_router_container" \
      --arg releaseRouterImageId "$release_router_image_id" \
      --arg maintenanceConfirmed "$rollback_maintenance_confirmed" \
      --arg legacyAdapterRequired "$legacy_rollback_adapter_required" \
      --arg legacyAdapterPath "$legacy_rollback_adapter_path" \
      --arg legacyAdapterSha256 "$legacy_rollback_adapter_sha256" \
      '{schemaVersion: 1, product: "business-finlynq", result: "read-only-rollback-accepted", completedAt: $completedAt, scheduler: $scheduler, schedulersPaused: true, sourceEvidenceDirectory: $sourceEvidence, sourceEvidenceSha256: $sourceEvidenceSha256, candidateRevision: $candidateRevision, candidateTreeId: $candidateTreeId, candidateTreeManifestSha256: $candidateTreeManifestSha256, observedApplicationState: $observedApplicationState, observedApplicationArtifact: $observedApplicationArtifact, observedApplicationRuntimeStatus: $observedApplicationRuntimeStatus, observedApplicationImageId: $observedApplicationImageId, observedApplicationRevision: $observedApplicationRevision, rollbackRevision: $rollbackRevision, rollbackImageId: $rollbackImageId, releaseRouterContainerId: $releaseRouterContainerId, releaseRouterImageId: $releaseRouterImageId, maintenanceConfirmedBeforeSwitch: ($maintenanceConfirmed == "true"), finalPublicReadinessAccepted: true, legacyCredentialAdapterUsed: ($legacyAdapterRequired == "true"), legacyCredentialAdapterPath: (if $legacyAdapterRequired == "true" then $legacyAdapterPath else null end), legacyCredentialAdapterSha256: (if $legacyAdapterRequired == "true" then $legacyAdapterSha256 else null end), allLoginDeliveryWriteAndFeedGatesDisabled: true}' \
      >"$rollback_evidence_temporary"
    chmod 0600 -- "$rollback_evidence_temporary"
    sync -f -- "$rollback_evidence_temporary"
    mv -- "$rollback_evidence_temporary" "$rollback_evidence_file"
    rollback_evidence_temporary=""
    sync -f -- "$(dirname -- "$rollback_evidence_file")"
    commit_rollback_router_active
    disarm_rollback_sigkill_watchdog
    rollback_containment_armed="false"
    cleanup_rollback_transients || fail "rollback private snapshots could not be removed"
    trap - EXIT INT TERM
    printf 'Application-only rollback is serving revision %s with every login/write gate disabled. Schedulers are verified paused. Evidence: %s\n' \
      "$previous_revision" "$rollback_evidence_file"
    exit 0
  fi
  sleep 2
done

rollback_compose stop --timeout 30 app >/dev/null 2>&1 || true
fail "the retained application did not become ready; keep it stopped and apply a reviewed forward repair"
