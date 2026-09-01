#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "$script_dir/../.." && pwd -P)"

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

for command_name in awk basename bash chmod chown curl date dirname docker env find flock git id install jq mkdir mktemp mv readlink rm sha256sum sleep sort stat sync tar touch xargs; do
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
for evidence_file in SHA256SUMS 12-rollback-artifact.json; do
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
[[ "$previous_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "evidence has no previous immutable app image"
[[ "$candidate_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "evidence has no immutable candidate app image"
[[ "$previous_revision" =~ ^[a-f0-9]{40}$ && "$candidate_revision" =~ ^[a-f0-9]{40}$ ]] || fail "evidence revisions are invalid"
[[ "$evidence_revision" == "$candidate_revision" ]] \
  || fail "release status and rollback artifact identify different candidate revisions"
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
fi
[[ "$(docker image inspect --format '{{.Id}}' "$previous_image_id")" == "$previous_image_id" ]] \
  || fail "the retained previous image is unavailable"
[[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$previous_image_id")" == "$previous_revision" ]] \
  || fail "the retained previous image revision does not match evidence"

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
  env -i "PATH=$PATH" docker compose --project-name business-finlynq \
    --project-directory "$candidate_source_root" --env-file "$environment_file" \
    -f "$candidate_source_root/docker-compose.yml" "$@"
}
rendered_current_compose="$(base_compose config --format json)"
deployed_revision="$(jq -r '.services.app.environment.BUSINESS_FINLYNQ_IMAGE_REVISION // empty' <<<"$rendered_current_compose")"
[[ "$deployed_revision" == "$candidate_revision" ]] \
  || fail "canonical Compose environment does not identify the candidate release"
[[ "$(jq -r '.services.app.image // empty' <<<"$rendered_current_compose")" == "business-finlynq-app:$candidate_revision" ]] \
  || fail "canonical Compose configuration does not bind the candidate app image"
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
  && "$current_app_revision" == "$previous_revision" ]]; then
  # A release failure after quiescing writes but before candidate creation
  # legitimately leaves the retained previous container stopped. It is still
  # the only evidence-authorized source state and can be safely recreated from
  # the same pinned previous ID with every gate forced off.
  observed_application_artifact="previous"
else
  fail "deployed app container matches neither the evidence candidate nor retained previous artifact"
fi
observed_application_state="$observed_application_artifact:$current_app_runtime_status"

rollback_compose() {
  env -i "PATH=$PATH" \
    "BUSINESS_FINLYNQ_ROLLBACK_APP_IMAGE=$previous_image_id" \
    "BUSINESS_FINLYNQ_IMAGE_REVISION=$previous_revision" \
    DEMO_LOGIN_ENABLED=false DEMO_WRITES_ENABLED=false \
    ACCOUNT_LOGIN_ENABLED=false ACCOUNT_SIGNUP_ENABLED=false \
    AUTH_EMAIL_DELIVERY_ENABLED=false SIGNUP_TURNSTILE_ENABLED=false \
    BUSINESS_WRITES_ENABLED=false BANK_FEEDS_ENABLED=false \
    docker compose --project-name business-finlynq --project-directory "$candidate_source_root" \
    --env-file "$environment_file" \
    -f "$candidate_source_root/docker-compose.yml" \
    -f "$candidate_source_root/deploy/release/docker-compose.application-rollback.yml" "$@"
}

contain_failed_rollback() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )) && [[ "$rollback_containment_armed" == "true" ]]; then
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

bash "$candidate_source_root/deploy/release/pause-schedulers.sh" "$scheduler_mode" --allow-already-paused
rollback_compose --profile auth-email stop --timeout 60 auth_email_worker app
if ! running_auth_worker="$(rollback_compose --profile auth-email \
  ps --status running --quiet auth_email_worker)"; then
  fail "could not verify authentication-worker containment during rollback"
fi
[[ -z "$running_auth_worker" ]] \
  || fail "authentication worker remains active during rollback"

rollback_containment_armed="true"
rollback_compose up --detach --no-deps --no-build --force-recreate app

for _ in {1..60}; do
  if body="$(curl --fail --silent --show-error --max-time 5 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3100/api/health 2>/dev/null)" \
    && jq -e --arg revision "$previous_revision" \
      '.status == "ready" and .revision == $revision
        and .checks.accountAuthentication == "disabled"
        and .checks.accountSignup == "disabled"
        and .checks.emailWorker == "disabled"
        and .checks.bankFeeds == "disabled"' <<<"$body" >/dev/null; then
    rollback_container="$(rollback_compose ps --quiet app)"
    [[ -n "$rollback_container" ]] || fail "rollback application container is missing"
    [[ "$(docker inspect --format '{{.Image}}' "$rollback_container")" == "$previous_image_id" ]] \
      || fail "rollback container is not using the retained image"
    rollback_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$rollback_container")"
    for disabled_gate in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED \
      ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED SIGNUP_TURNSTILE_ENABLED \
      BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED; do
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
      '{schemaVersion: 1, product: "business-finlynq", result: "read-only-rollback-accepted", completedAt: $completedAt, scheduler: $scheduler, schedulersPaused: true, sourceEvidenceDirectory: $sourceEvidence, sourceEvidenceSha256: $sourceEvidenceSha256, candidateRevision: $candidateRevision, candidateTreeId: $candidateTreeId, candidateTreeManifestSha256: $candidateTreeManifestSha256, observedApplicationState: $observedApplicationState, observedApplicationArtifact: $observedApplicationArtifact, observedApplicationRuntimeStatus: $observedApplicationRuntimeStatus, observedApplicationImageId: $observedApplicationImageId, observedApplicationRevision: $observedApplicationRevision, rollbackRevision: $rollbackRevision, rollbackImageId: $rollbackImageId, allLoginDeliveryWriteAndFeedGatesDisabled: true}' \
      >"$rollback_evidence_temporary"
    chmod 0600 -- "$rollback_evidence_temporary"
    sync -f -- "$rollback_evidence_temporary"
    mv -- "$rollback_evidence_temporary" "$rollback_evidence_file"
    rollback_evidence_temporary=""
    sync -f -- "$(dirname -- "$rollback_evidence_file")"
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
