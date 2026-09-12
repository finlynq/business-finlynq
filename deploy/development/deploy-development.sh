#!/usr/bin/env bash
set -Eeuo pipefail
set +x

umask 077

readonly repository="/home/deploy/business-finlynq-stage"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly installed_deployer="/usr/local/sbin/business-finlynq-deploy-development"
readonly compose_environment="/etc/business-finlynq-development/compose.env"
readonly project="business-finlynq-development"
readonly state_directory="/var/lib/business-finlynq-development"
readonly deployment_lock="$state_directory/deployment.lock"
readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly legacy_failure_latch="$state_directory/deployment-failed"
readonly quarantine_file="$state_directory/quarantined-candidate"
readonly hard_failure_latch="$state_directory/deployment-hard-failed"
readonly accepted_revision_file="$state_directory/accepted-revision"
readonly release_router_reference="business-finlynq-release-router:v2"
readonly release_router_revision="release-router-v2"
readonly release_router_contract="v2"
readonly release_router_build_project="business-finlynq-release-router-build-v2"
readonly release_router_source_date_epoch="1788998400"
readonly release_router_state_volume="business_finlynq_development_private-release-router-state-v2"
readonly build_cache_limit="8GB"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
release_acceptance_token=""
persistent_release_router_id=""
development_router_live_uncommitted="false"
initial_development_bootstrap="false"

fail() {
  printf 'Business Finlynq development deployment refused: %s\n' "$*" >&2
  exit 1
}

validate_revision() {
  [[ "$1" =~ ^[a-f0-9]{40}$ && ! "$1" =~ ^0+$ ]] \
    || fail "revision must be a non-zero full 40-character Git SHA"
}

[[ "$(id -u)" == 0 ]] || fail "run this command as root"
for command_name in awk bash chmod chown curl date docker env flock git grep id install jq openssl sha256sum \
  mktemp mv readlink rm rmdir runuser sed sleep sort stat sync uniq; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"

docker() {
  env -i PATH="$clean_path" docker "$@"
}

if [[ "${1:-}" == "--clear-failure" ]]; then
  [[ "$#" == 2 ]] || fail "--clear-failure requires the failed candidate revision"
  validate_revision "$2"
  [[ "${DEVELOPMENT_DEPLOYMENT_FAILURE_ACK:-}" == "clear:$2" ]] \
    || fail "DEVELOPMENT_DEPLOYMENT_FAILURE_ACK must acknowledge the exact failed revision"
  cleared=false
  for failure_state in "$legacy_failure_latch" "$hard_failure_latch" "$quarantine_file"; do
    if [[ -f "$failure_state" && ! -L "$failure_state" ]] \
      && grep -Fxq "candidateRevision=$2" "$failure_state"; then
      rm -- "$failure_state"
      cleared=true
    fi
  done
  [[ "$cleared" == true ]] || fail "no protected failure state identifies the acknowledged revision"
  sync -f -- "$state_directory"
  printf 'Development deployment failure state cleared for %s.\n' "$2"
  exit 0
fi
[[ "$#" == 0 ]] || fail "this command accepts no deployment arguments"

[[ -d "$repository/.git" && ! -L "$repository" ]] \
  || fail "the canonical development checkout is unavailable"
[[ -f "$compose_environment" && ! -L "$compose_environment" \
  && "$(stat -c '%U:%G:%a' -- "$compose_environment")" == root:deploy:600 ]] \
  || fail "the protected development Compose environment is unavailable or unsafe"
[[ -d "$state_directory" && ! -L "$state_directory" ]] \
  || fail "the development state directory is unavailable"
[[ ! -L "$deployment_lock" && ! -L "$host_deployment_lock" ]] \
  || fail "a deployment lock is symbolic"
exec 9>"$deployment_lock"
chmod 0600 "$deployment_lock"
flock --exclusive --nonblock 9 || fail "another development deployment check is active"
deploy_gid="$(id -g deploy 2>/dev/null)" \
  || fail "host deployment coordination requires the deploy account"
[[ -d "${host_deployment_lock%/*}" && ! -L "${host_deployment_lock%/*}" \
  && "$(readlink -f -- "${host_deployment_lock%/*}")" == "${host_deployment_lock%/*}" \
  && "$(stat -c '%u:%g:%a' -- "${host_deployment_lock%/*}")" == "0:$deploy_gid:775" ]] \
  || fail "shared deployment state directory must be root:deploy mode 0775"
if [[ ! -e "$host_deployment_lock" ]]; then
  install -o root -g "$deploy_gid" -m 0660 -- /dev/null "$host_deployment_lock"
fi
[[ -f "$host_deployment_lock" && ! -L "$host_deployment_lock" \
  && "$(readlink -f -- "$host_deployment_lock")" == "$host_deployment_lock" ]] \
  || fail "the host deployment lock is unavailable or unsafe"
chown root:"$deploy_gid" "$host_deployment_lock"
chmod 0660 "$host_deployment_lock"
[[ "$(stat -c '%u:%g:%a:%h' -- "$host_deployment_lock")" == "0:$deploy_gid:660:1" ]] \
  || fail "the host deployment lock must be root:deploy mode 0660"
exec 8<>"$host_deployment_lock"
[[ "$(readlink -f -- /proc/$$/fd/8)" == "$host_deployment_lock" \
  && "$(stat -Lc '%u:%g:%a:%h' -- /proc/$$/fd/8)" == "0:$deploy_gid:660:1" ]] \
  || fail "the opened host deployment lock differs from its protected path"
flock --exclusive --nonblock 8 || fail "another production or development deployment is active"

git_as_deploy() {
  runuser -u deploy -- /usr/bin/env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH="$clean_path" LC_ALL=C LANG=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git --no-optional-locks -c safe.directory="$repository" -c core.hooksPath=/dev/null \
      -C "$repository" "$@"
}

refresh_installed_deployer_if_needed() {
  local revision="$1" relative_path="deploy/development/deploy-development.sh"
  local expected_oid observed_oid candidate_digest installed_digest
  local candidate_source="" staged_target=""
  validate_revision "$revision"

  [[ -f "$installed_deployer" && ! -L "$installed_deployer"
    && "$(readlink -f -- "$installed_deployer")" == "$installed_deployer"
    && "$(stat -c '%U:%G:%a:%h' -- "$installed_deployer")" == root:root:550:1 ]] \
    || fail "the installed development deployer is unavailable or unsafe"
  [[ -d "${installed_deployer%/*}" && ! -L "${installed_deployer%/*}"
    && "$(readlink -f -- "${installed_deployer%/*}")" == "${installed_deployer%/*}"
    && "$(stat -c '%U:%G:%a' -- "${installed_deployer%/*}")" == root:root:755 ]] \
    || fail "the installed development deployer directory is unavailable or unsafe"

  cleanup_deployer_refresh_staging() {
    [[ -z "$candidate_source" ]] || rm -f -- "$candidate_source"
    [[ -z "$staged_target" ]] || rm -f -- "$staged_target"
  }
  trap cleanup_deployer_refresh_staging EXIT INT TERM

  candidate_source="$(mktemp "$state_directory/.candidate-development-deployer.${revision}.XXXXXX")" \
    || fail "candidate development deployer staging could not be created"
  expected_oid="$(git_as_deploy rev-parse "$revision:$relative_path")" \
    || fail "candidate development deployer Git blob could not be resolved"
  git_as_deploy show "$revision:$relative_path" >"$candidate_source" \
    || fail "candidate development deployer source could not be staged"
  observed_oid="$(git_as_deploy hash-object --stdin <"$candidate_source")" \
    || fail "candidate development deployer staging could not be hashed"
  [[ "$expected_oid" =~ ^[a-f0-9]{40}$ && "$observed_oid" == "$expected_oid"
    && -s "$candidate_source" ]] \
    || fail "candidate development deployer staging differs from its Git blob"
  chown root:root -- "$candidate_source" \
    || fail "candidate development deployer staging ownership could not be set"
  chmod 0500 "$candidate_source" \
    || fail "candidate development deployer staging mode could not be set"

  candidate_digest="$(sha256sum -- "$candidate_source" | awk '{ print $1 }')" \
    || fail "candidate development deployer digest could not be read"
  installed_digest="$(sha256sum -- "$installed_deployer" | awk '{ print $1 }')" \
    || fail "installed development deployer digest could not be read"
  if [[ "$candidate_digest" == "$installed_digest" ]]; then
    cleanup_deployer_refresh_staging
    trap - EXIT INT TERM
    return 0
  fi

  staged_target="$(mktemp "${installed_deployer%/*}/.business-finlynq-deploy-development.XXXXXX")" \
    || fail "installed development deployer staging could not be created"
  install -o root -g root -m 0550 -- "$candidate_source" "$staged_target" \
    || fail "candidate development deployer could not be installed"
  [[ -f "$staged_target" && ! -L "$staged_target"
    && "$(stat -c '%U:%G:%a:%h' -- "$staged_target")" == root:root:550:1
    && "$(sha256sum -- "$staged_target" | awk '{ print $1 }')" == "$candidate_digest" ]] \
    || fail "installed candidate development deployer differs from its reviewed source"
  mv -T -- "$staged_target" "$installed_deployer" \
    || fail "candidate development deployer could not be activated atomically"
  staged_target=""
  sync -f -- "$installed_deployer" "${installed_deployer%/*}"
  cleanup_deployer_refresh_staging
  trap - EXIT INT TERM

  printf 'Activated the CI-approved development deployer from candidate %s; restarting preflight.\n' \
    "$revision"
  exec 9>&-
  exec 8>&-
  exec env -i PATH="$clean_path" "$installed_deployer"
}

compose() {
  local edge_mode edge_mode_count
  local -a controlled_environment=()
  edge_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE could not be read"
  edge_mode_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE definitions could not be counted"
  [[ "$edge_mode_count" == 0 || "$edge_mode_count" == 1 ]] \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE must be defined at most once"
  edge_mode="${edge_mode:-external}"
  [[ "$edge_mode" == external ]] \
    || fail "shared-edge contract v1 requires BUSINESS_FINLYNQ_EDGE_MODE=external"
  if [[ -n "$release_acceptance_token" ]]; then
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
      || fail "development release-acceptance token is invalid"
    controlled_environment+=(
      "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$release_acceptance_token"
    )
  fi
  env -i PATH="$clean_path" "${controlled_environment[@]}" docker compose \
    --project-name "$project" \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    -f "$repository/docker-compose.yml" "$@"
}

compose_release_router_build() {
  local edge_mode edge_mode_count
  edge_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" || return 1
  edge_mode_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
    "$compose_environment")" || return 1
  [[ "$edge_mode_count" == 0 || "$edge_mode_count" == 1 ]] || return 1
  edge_mode="${edge_mode:-external}"
  [[ "$edge_mode" == external ]] || return 1
  env -i PATH="$clean_path" docker compose \
    --project-name "$release_router_build_project" \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    -f "$repository/docker-compose.yml" build --provenance=false --sbom=false \
    --build-arg "SOURCE_DATE_EPOCH=$release_router_source_date_epoch" release_router
}

read_environment_value() {
  local key="$1" value count
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' "$compose_environment")" \
    || fail "development environment value could not be read: $key"
  count="$(grep -c "^${key}=" "$compose_environment")" \
    || fail "development environment does not define $key"
  [[ "$count" == 1 ]] \
    || fail "development environment must define $key exactly once"
  printf '%s' "$value"
}

revision_release_topology() {
  local revision="$1" compose_source
  validate_revision "$revision"
  compose_source="$(git_as_deploy show "$revision:docker-compose.yml")" \
    || fail "the Compose definition for revision $revision could not be read"
  if grep -Eq '^[[:space:]]{2}release_router:[[:space:]]*$' <<<"$compose_source"; then
    printf 'router'
  else
    printf 'legacy'
  fi
}

revision_uses_oidc_runtime_contract() {
  local revision="$1" compose_source
  validate_revision "$revision"
  compose_source="$(git_as_deploy show "$revision:docker-compose.yml")" || return 2
  grep -Eq '^[[:space:]]+AUTH_OIDC_ENABLED:' <<<"$compose_source"
}

revision_uses_oidc_signup_runtime_contract() {
  local revision="$1" compose_source
  validate_revision "$revision"
  compose_source="$(git_as_deploy show "$revision:docker-compose.yml")" || return 2
  grep -Eq '^[[:space:]]+AUTH_OIDC_SIGNUP_ENABLED:' <<<"$compose_source"
}

verify_external_edge_if_selected() {
  local verifier_revision="$1" verification_boundary="${2:-normal}"
  local selected_mode selected_count verifier_boundary_flag
  validate_revision "$verifier_revision"
  case "$verification_boundary" in
    normal) verifier_boundary_flag="--allow-development-router-maintenance" ;;
    live-uncommitted) verifier_boundary_flag="--expect-development-live-uncommitted" ;;
    *) fail "external-edge verification boundary is invalid" ;;
  esac
  selected_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE definitions could not be counted"
  [[ "$selected_count" == 0 || "$selected_count" == 1 ]] \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE must be defined at most once"
  selected_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE could not be read"
  selected_mode="${selected_mode:-external}"
  [[ "$selected_mode" == external ]] \
    || fail "shared-edge contract v1 requires BUSINESS_FINLYNQ_EDGE_MODE=external"

  # The installed verifier can describe an older ingress topology. Stage only
  # the read-only verifier from the immutable, CI-signalled candidate object.
  # Shared-edge route files remain exclusively owned by the central repository.
  (
    local staging_root verifier_path relative_path target_path
    local expected_oid observed_oid
    staging_root="$(mktemp -d \
      "$state_directory/.candidate-edge-verifier.${verifier_revision}.XXXXXX")" \
      || fail "candidate external-edge verifier staging could not be created"
    verifier_path="$staging_root/deploy/edge/verify-external-edge.sh"
    cleanup_candidate_verifier_staging() {
      rm -f -- "$verifier_path"
      rmdir -- "$staging_root/deploy/edge" "$staging_root/deploy" "$staging_root" \
        2>/dev/null || true
    }
    trap cleanup_candidate_verifier_staging EXIT
    install -d -o root -g root -m 0700 -- "$staging_root/deploy/edge" \
      || fail "candidate external-edge verifier staging hierarchy could not be prepared"
    for relative_path in deploy/edge/verify-external-edge.sh; do
      case "$relative_path" in
        deploy/edge/verify-external-edge.sh) target_path="$verifier_path" ;;
        *) fail "unexpected candidate external-edge verifier source" ;;
      esac
      expected_oid="$(git_as_deploy rev-parse \
        "$verifier_revision:$relative_path")" \
        || fail "candidate external-edge verifier Git blob could not be resolved: $relative_path"
      git_as_deploy show "$verifier_revision:$relative_path" >"$target_path" \
        || fail "candidate external-edge verifier source could not be staged: $relative_path"
      observed_oid="$(git_as_deploy hash-object --stdin <"$target_path")" \
        || fail "candidate external-edge verifier staging could not be hashed: $relative_path"
      [[ "$expected_oid" =~ ^[a-f0-9]{40}$ && "$observed_oid" == "$expected_oid" \
        && -s "$target_path" ]] \
        || fail "candidate external-edge verifier staging differs from its Git blob: $relative_path"
    done
    chown root:root -- "$verifier_path" \
      || fail "candidate external-edge verifier staging ownership could not be set"
    chmod 0500 "$verifier_path" \
      || fail "candidate external-edge verifier staging mode could not be set"
    bash "$verifier_path" --scope development --warmup-host development \
      "$verifier_boundary_flag"
  )
}

state_file_is_safe() {
  local target="$1"
  [[ -f "$target" && ! -L "$target" \
    && "$(stat -c '%U:%G:%a' -- "$target")" == root:root:600 ]]
}

read_state_value() {
  local target="$1" key="$2" value count
  state_file_is_safe "$target" || fail "protected deployment state is unavailable or unsafe: $target"
  count="$(grep -c "^${key}=" "$target")" \
    || fail "protected deployment state does not define $key: $target"
  [[ "$count" == 1 ]] \
    || fail "protected deployment state must define $key exactly once: $target"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' "$target")" \
    || fail "protected deployment state value could not be read: $key"
  [[ -n "$value" ]] || fail "protected deployment state contains an empty $key: $target"
  printf '%s' "$value"
}

write_accepted_revision() {
  local revision="$1" temporary accepted_at
  validate_revision "$revision"
  accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    || fail "the accepted-revision timestamp could not be generated"
  [[ "$accepted_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "the accepted-revision timestamp is invalid"
  temporary="$(mktemp "${accepted_revision_file}.XXXXXX")" \
    || fail "the accepted-revision staging file could not be created"
  printf 'revision=%s\nacceptedAt=%s\n' \
    "$revision" "$accepted_at" >"$temporary" \
    || fail "the accepted-revision state could not be written"
  chmod 0600 "$temporary" \
    || fail "the accepted-revision staging mode could not be set"
  chown root:root "$temporary" \
    || fail "the accepted-revision staging owner could not be set"
  sync -f -- "$temporary" \
    || fail "the accepted-revision staging file could not be synchronized"
  mv -f -- "$temporary" "$accepted_revision_file" \
    || fail "the accepted-revision state could not be published"
  sync -f -- "$state_directory" \
    || fail "the accepted-revision state directory could not be synchronized"
}

restore_accepted_revision_pointer() {
  local revision="$1"
  if [[ -n "$revision" ]]; then
    validate_revision "$revision"
    write_accepted_revision "$revision"
    return 0
  fi
  if [[ -e "$accepted_revision_file" || -L "$accepted_revision_file" ]]; then
    state_file_is_safe "$accepted_revision_file" || return 1
    rm -- "$accepted_revision_file" || return 1
    sync -f -- "$state_directory" || return 1
  fi
}

commit_release_router_acceptance() {
  local revision="$1" prior_accepted_revision="$2"
  validate_revision "$revision"
  [[ -z "$prior_accepted_revision" ]] || validate_revision "$prior_accepted_revision"

  # The accepted pointer is the authorization record for durable active mode.
  # Keep the prior pointer in memory until the state-volume commit succeeds so
  # an ordinary write/reload failure cannot strand an uncommitted candidate as
  # the sole recovery target.
  write_accepted_revision "$revision"
  if persist_release_router_mode active; then
    return 0
  fi
  contain_development_router_on_failure \
    || fail "active-routing commit failed and the stable router could not be contained in maintenance"
  restore_accepted_revision_pointer "$prior_accepted_revision" \
    || fail "the prior accepted-revision pointer could not be restored after an active-routing commit failure"
  return 1
}

write_failure_state() {
  local target="$1" kind="$2" source="$3" candidate="$4" stage="$5" recovered="$6" \
    cleanup_complete="$7" temporary failed_at
  validate_revision "$source"
  validate_revision "$candidate"
  [[ "$kind" == quarantine || "$kind" == hard ]] \
    || fail "invalid development failure-state kind"
  [[ "$cleanup_complete" == true || "$cleanup_complete" == false ]] \
    || fail "invalid development cleanup state"
  failed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    || fail "the failure-state timestamp could not be generated"
  [[ "$failed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "the failure-state timestamp is invalid"
  temporary="$(mktemp "${target}.XXXXXX")" \
    || fail "the failure-state staging file could not be created"
  printf 'kind=%s\nsourceRevision=%s\ncandidateRevision=%s\nstage=%s\nfailedAt=%s\nrecoveredRevision=%s\ncleanupComplete=%s\n' \
    "$kind" "$source" "$candidate" "$stage" "$failed_at" \
    "$recovered" "$cleanup_complete" >"$temporary" \
    || fail "the failure state could not be written"
  chmod 0600 "$temporary" \
    || fail "the failure-state staging mode could not be set"
  chown root:root "$temporary" \
    || fail "the failure-state staging owner could not be set"
  sync -f -- "$temporary" \
    || fail "the failure-state staging file could not be synchronized"
  mv -f -- "$temporary" "$target" \
    || fail "the failure state could not be published"
  sync -f -- "$state_directory" \
    || fail "the failure-state directory could not be synchronized"
}

replace_environment_revision() {
  local old_revision="$1" new_revision="$2" current_revision temporary duplicate_keys
  validate_revision "$old_revision"
  validate_revision "$new_revision"
  duplicate_keys="$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$compose_environment" \
    | sort | uniq -d)" \
    || return 1
  [[ -z "$duplicate_keys" ]] \
    || return 1
  current_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)" || return 1
  if [[ "$current_revision" == "$new_revision" ]]; then
    return 0
  fi
  [[ "$current_revision" == "$old_revision" ]] || return 1
  temporary="$(mktemp "${compose_environment}.deployment.XXXXXX")" || return 1
  if ! awk -v old="$old_revision" -v new="$new_revision" '
    $0 == "BUSINESS_FINLYNQ_IMAGE_REVISION=" old {
      print "BUSINESS_FINLYNQ_IMAGE_REVISION=" new
      count++
      next
    }
    { print }
    END { if (count != 1) exit 42 }
  ' "$compose_environment" >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chown root:deploy "$temporary" || return 1
  chmod 0600 "$temporary" || return 1
  sync -f -- "$temporary" || return 1
  mv -f -- "$temporary" "$compose_environment" || return 1
  sync -f -- "$compose_environment" || return 1
}

revision_project_container_ids() {
  local revision="$1" container container_revision container_output
  validate_revision "$revision"
  container_output="$(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project")" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    container_revision="$(docker inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null)" \
      || return 1
    [[ "$container_revision" == "$revision" ]] && printf '%s\n' "$container"
  done <<<"$container_output"
  return 0
}

revision_is_used_outside_project() {
  local revision="$1" container container_project container_revision container_output
  validate_revision "$revision"
  container_output="$(docker ps --all --no-trunc --quiet)" || return 2
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    container_revision="$(docker inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null)" \
      || return 2
    [[ "$container_revision" == "$revision" ]] || continue
    container_project="$(docker inspect --format \
      '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null)" \
      || return 2
    [[ "$container_project" == "$project" ]] || return 0
  done <<<"$container_output"
  return 1
}

remove_revision_artifacts() {
  local revision="$1" reference image_revision container_output image_ids outside_status
  local -a container_ids image_references
  validate_revision "$revision"
  container_output="$(revision_project_container_ids "$revision")" || return 1
  container_ids=()
  if [[ -n "$container_output" ]]; then
    mapfile -t container_ids <<<"$container_output" || return 1
  fi
  if (( ${#container_ids[@]} > 0 )); then
    docker rm --force -- "${container_ids[@]}" >/dev/null || return 1
  fi

  image_references=(
    "business-finlynq-acceptance:$revision"
    "business-finlynq-auth-worker:$revision"
    "business-finlynq-app:$revision"
    "business-finlynq-migrator:$revision"
    "business-finlynq-operations:$revision"
    "business-finlynq-database:$revision"
  )
  if revision_is_used_outside_project "$revision"; then
    printf 'Development cleanup retained revision %s images used by another Compose project.\n' \
      "$revision"
  else
    outside_status=$?
    [[ "$outside_status" == 1 ]] || return 1
    for reference in "${image_references[@]}"; do
      image_ids="$(docker image ls --quiet --no-trunc "$reference")" || return 1
      [[ -n "$image_ids" ]] || continue
      [[ "$image_ids" != *$'\n'* ]] || return 1
      image_revision="$(docker image inspect --format \
        '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference")" \
        || return 1
      [[ "$image_revision" == "$revision" ]] || return 1
      docker image rm -- "$reference" >/dev/null || return 1
    done
    docker image prune --force \
      --filter "label=org.opencontainers.image.revision=$revision" >/dev/null || return 1
  fi
  container_output="$(revision_project_container_ids "$revision")" || return 1
  container_ids=()
  if [[ -n "$container_output" ]]; then
    mapfile -t container_ids <<<"$container_output" || return 1
  fi
  (( ${#container_ids[@]} == 0 ))
}

bound_build_cache() {
  docker builder prune --force --max-used-space "$build_cache_limit" >/dev/null
}

wait_for_public_readiness() {
  local deadline hostname public_health
  local -a readiness_headers=()
  hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" \
    || fail "BUSINESS_FINLYNQ_HOSTNAME could not be read"
  [[ "$hostname" == stage.business.finlynq.com ]] \
    || fail "public acceptance requires the exact development hostname"
  if [[ -n "$release_acceptance_token" ]]; then
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
      || fail "development release-acceptance token is invalid"
    readiness_headers=(
      --header "Authorization: Bearer $release_acceptance_token"
    )
  fi
  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if public_health="$(curl --disable --noproxy '*' --connect-timeout 2 --max-time 5 --fail --silent \
      "${readiness_headers[@]}" \
      "https://$hostname/api/health" 2>/dev/null)" \
      && jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
        <<<"$public_health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  fail "public development route did not become ready before browser acceptance"
}

wait_for_release_router_maintenance() {
  local headers body live status attempt result=1
  headers="$(mktemp "$state_directory/.release-router-maintenance.headers.XXXXXX")" || return 1
  body="$(mktemp "$state_directory/.release-router-maintenance.body.XXXXXX")" || {
    rm -f -- "$headers"
    return 1
  }
  for attempt in {1..15}; do
    if live="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
      --header 'X-Request-Id: development-maintenance' \
      http://127.0.0.1:3200/api/live 2>/dev/null)" \
      && jq -e 'type == "object" and keys == ["status"] and .status == "live"' \
        <<<"$live" >/dev/null; then
      status=""
      if status="$(curl --noproxy '*' --silent --show-error --max-time 5 \
        --header 'X-Request-Id: development-maintenance' \
        --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
        http://127.0.0.1:3200/api/health 2>/dev/null)" \
        && [[ "$status" == 503 ]] \
        && jq -e 'type == "object" and keys == ["status"] and .status == "unavailable"' \
          "$body" >/dev/null \
        && grep -Eiq '^cache-control:.*no-store' "$headers" \
        && grep -Eiq '^retry-after:[[:space:]]*5[[:space:]]*$' "$headers"; then
        result=0
        break
      fi
    fi
    sleep 2
  done
  rm -f -- "$headers" "$body"
  return "$result"
}

ensure_release_router_image() {
  local allow_build="$1" image_id image_contract image_revision image_build_project
  local expected_config_sha256 observed_config_output observed_config_sha256
  [[ "$allow_build" == true || "$allow_build" == false ]] || return 1
  if ! image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference" 2>/dev/null)"; then
    [[ "$allow_build" == true ]] || return 1
    compose_release_router_build || return 1
    image_id="$(docker image inspect --format '{{.Id}}' \
      "$release_router_reference" 2>/dev/null)" || return 1
  fi
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  image_revision="$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$release_router_reference")" || return 1
  image_contract="$(docker image inspect --format \
    '{{ index .Config.Labels "com.business-finlynq.release-router.contract" }}' \
    "$release_router_reference")" || return 1
  image_build_project="$(docker image inspect --format \
    '{{ index .Config.Labels "com.docker.compose.project" }}' \
    "$release_router_reference")" || return 1
  [[ "$image_revision" == "$release_router_revision" \
    && "$image_contract" == "$release_router_contract" \
    && "$image_build_project" == "$release_router_build_project" ]] || return 1
  expected_config_sha256="$(
    for relative_path in Caddyfile Caddyfile.maintenance entrypoint.sh; do
      git_as_deploy show \
        "$candidate_revision:deploy/release/router/$relative_path" \
        | sha256sum | awk '{ print $1 }'
    done | sha256sum | awk '{ print $1 }'
  )" || return 1
  [[ "$expected_config_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  observed_config_output="$(docker run --rm --network none --read-only \
    --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 32 --memory 64m --cpus 0.25 --entrypoint /bin/sh \
    "$image_id" -ec \
    'sha256sum /etc/caddy/Caddyfile /etc/caddy/Caddyfile.maintenance /usr/local/bin/release-router-entrypoint | awk '\''{print $1}'\'' | sha256sum')" \
    || return 1
  read -r observed_config_sha256 _ <<<"$observed_config_output" || return 1
  [[ "$observed_config_sha256" == "$expected_config_sha256" ]]
}

running_release_router_container() {
  local router_output
  local -a router_containers=()
  router_output="$(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -n "$router_output" ]]; then
    mapfile -t router_containers <<<"$router_output" || return 1
  fi
  [[ "${#router_containers[@]}" == 1 ]] || return 1
  printf '%s' "${router_containers[0]}"
}

release_router_container_is_attested() {
  local router_container="$1" tagged_image_id router_inspection
  [[ "$router_container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  tagged_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" || return 1
  router_inspection="$(docker inspect "$router_container")" || return 1
  jq -e --arg imageId "$tagged_image_id" --arg image "$release_router_reference" \
    --arg revision "$release_router_revision" --arg contract "$release_router_contract" \
    --arg stateVolume "$release_router_state_volume" '
    length == 1 and .[0].Image == $imageId and .[0].Config.Image == $image and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq-development" and
    .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
    .[0].Config.User == "10001:10001" and
    .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
    (.[0].HostConfig.SecurityOpt | sort) == ["no-new-privileges:true"] and
    ((.[0].Mounts // []) | length) == 1 and
    .[0].Mounts[0].Type == "volume" and .[0].Mounts[0].Name == $stateVolume and
    .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
    .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
    .[0].Config.Cmd == ["serve"]
  ' <<<"$router_inspection" >/dev/null
}

persist_release_router_mode_offline() {
  local router_container="$1" mode="$2" image_id
  [[ "$mode" == maintenance ]] || return 1
  release_router_container_is_attested "$router_container" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$router_container")" == false ]] \
    || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$router_container")" || return 1
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
    --volumes-from "$router_container" --entrypoint sh "$image_id" -ec '
      set -eu
      mode="$1"
      [[ "$mode" == maintenance ]]
      [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
      temporary="/state/.mode.$$"
      trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
      printf "%s\n" "$mode" >"$temporary"
      chmod 0600 "$temporary"
      mv -f "$temporary" /state/mode
      sync /state/mode 2>/dev/null || sync
      sync -f /state 2>/dev/null || sync
      trap - EXIT INT TERM
    ' sh "$mode" >/dev/null
}

persist_release_router_named_volume_mode() {
  local mode="$1" volume_inspection
  [[ "$mode" == maintenance ]] || return 1
  ensure_release_router_image false || return 1
  volume_inspection="$(docker volume inspect "$release_router_state_volume")" || return 1
  jq -e --arg name "$release_router_state_volume" '
    length == 1 and .[0].Name == $name and .[0].Driver == "local" and
    .[0].Scope == "local" and
    .[0].Labels["com.docker.compose.project"] == "business-finlynq-development" and
    .[0].Labels["com.docker.compose.volume"] == "business_finlynq_release_router_state"
  ' <<<"$volume_inspection" >/dev/null || return 1
  if docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
    --mount "type=volume,src=$release_router_state_volume,dst=/state" \
    --entrypoint sh "$release_router_reference" -ec '
      set -eu
      mode="$1"
      [[ "$mode" == maintenance ]]
      [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
      temporary="/state/.mode.$$"
      trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
      printf "%s\n" "$mode" >"$temporary"
      chmod 0600 "$temporary"
      mv -f "$temporary" /state/mode
      sync /state/mode 2>/dev/null || sync
      sync -f /state 2>/dev/null || sync
      trap - EXIT INT TERM
    ' sh "$mode" >/dev/null 2>&1; then
    return 0
  fi

  # Compose may have created the named volume before creating its first router
  # container. Initialize only that exact, label-attested, pristine Docker
  # volume; any unexpected content or metadata remains a hard stop.
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN \
    --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
    --mount "type=volume,src=$release_router_state_volume,dst=/state" \
    --entrypoint sh "$release_router_reference" -ec '
      set -eu
      mode="$1"
      [[ "$mode" == maintenance ]]
      [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 0:0:755 ]]
      [[ -z "$(find /state -mindepth 1 -maxdepth 1 -print -quit)" ]]
      temporary="/state/.mode.$$"
      trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
      printf "%s\n" "$mode" >"$temporary"
      chmod 0600 "$temporary"
      mv -f "$temporary" /state/mode
      chown 10001:10001 /state/mode /state
      sync /state/mode 2>/dev/null || sync
      sync -f /state 2>/dev/null || sync
      trap - EXIT INT TERM
    ' sh "$mode" >/dev/null
}

assert_fresh_development_resources() {
  local volume_names network_names resource edge_mode edge_inspection router_volume_inspection
  local -a protected_data_volumes=(
    business_finlynq_development_pgdata
    business_finlynq_development_pgdata_clamav
  )
  local -a protected_internal_networks=(
    business_finlynq_development_private
    business_finlynq_development_private_evidence
    business_finlynq_development_egress
    business_finlynq_development_egress_scanner
    business_finlynq_development_private-frontend
    business_finlynq_development_private-router-control
    business_finlynq_development_restore_drill
  )

  volume_names="$(docker volume ls --format '{{.Name}}')" \
    || fail "development Docker volumes could not be inspected"
  for resource in "${protected_data_volumes[@]}"; do
    ! grep -Fxq "$resource" <<<"$volume_names" \
      || fail "retained development data volume prevents a fresh installation: $resource"
  done
  if grep -Fxq "$release_router_state_volume" <<<"$volume_names"; then
    router_volume_inspection="$(docker volume inspect "$release_router_state_volume")" \
      || fail "the retained development release-router state volume could not be inspected"
    jq -e --arg name "$release_router_state_volume" --arg project "$project" '
      length == 1 and .[0].Name == $name and .[0].Driver == "local" and
      .[0].Scope == "local" and
      .[0].Labels["com.docker.compose.project"] == $project and
      .[0].Labels["com.docker.compose.volume"] == "business_finlynq_release_router_state"
    ' <<<"$router_volume_inspection" >/dev/null \
      || fail "the retained development release-router state volume is not canonical"
  fi

  network_names="$(docker network ls --format '{{.Name}}')" \
    || fail "development Docker networks could not be inspected"
  for resource in "${protected_internal_networks[@]}"; do
    ! grep -Fxq "$resource" <<<"$network_names" \
      || fail "retained development internal network prevents a fresh installation: $resource"
  done
  grep -Fxq business_finlynq_development_edge <<<"$network_names" \
    || fail "the installer-attested development edge network is unavailable"
  edge_mode="$(read_environment_value BUSINESS_FINLYNQ_EDGE_MODE)" \
    || fail "the development edge mode could not be read for fresh installation"
  [[ "$edge_mode" == external ]] \
    || fail "shared-edge contract v1 requires BUSINESS_FINLYNQ_EDGE_MODE=external"
  edge_inspection="$(docker network inspect business_finlynq_development_edge)" \
    || fail "the development edge network could not be inspected"
  jq -e '
    length == 1 and .[0].Name == "business_finlynq_development_edge" and
    .[0].Driver == "bridge" and .[0].Scope == "local" and
    .[0].Attachable == false and .[0].Ingress == false and
    (.[0].Options == null or .[0].Options == {}) and
    .[0].Internal == true
  ' <<<"$edge_inspection" >/dev/null \
    || fail "the central development ingress network no longer matches contract v1"
}

release_router_runtime_is_accepted() {
  local router_container router_image_id tagged_image_id router_inspection runtime_uid router_mode
  router_container="$(running_release_router_container)" || return 1
  tagged_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" || return 1
  router_inspection="$(docker inspect "$router_container")" || return 1
  jq -e --arg imageId "$tagged_image_id" --arg image "$release_router_reference" \
    --arg revision "$release_router_revision" --arg contract "$release_router_contract" \
    --arg stateVolume "$release_router_state_volume" '
    length == 1 and .[0].Image == $imageId and .[0].Config.Image == $image and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq-development" and
    .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
    .[0].Config.User == "10001:10001" and
    .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
    (.[0].HostConfig.SecurityOpt | sort) == ["no-new-privileges:true"] and
    .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
    ((.[0].Mounts // []) | length) == 1 and
    .[0].Mounts[0].Type == "volume" and .[0].Mounts[0].Name == $stateVolume and
    .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
    ((.[0].HostConfig.Tmpfs // {}) | keys | sort) == ["/config", "/data", "/tmp"] and
    (.[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":"3200"}]) and
    ([.[0].NetworkSettings.Networks | keys[]] | sort) ==
      ["business_finlynq_development_edge", "business_finlynq_development_private-frontend",
        "business_finlynq_development_private-router-control"] and
    ([.[0].NetworkSettings.Networks.business_finlynq_development_edge.Aliases[]] |
      index("development-app")) != null and
    .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
    .[0].Config.Cmd == ["serve"]
  ' <<<"$router_inspection" >/dev/null || return 1
  router_image_id="$(docker inspect --format '{{.Image}}' "$router_container")" || return 1
  [[ "$router_image_id" == "$tagged_image_id" ]] || return 1
  runtime_uid="$(docker exec "$router_container" id -u)" || return 1
  [[ "$runtime_uid" == 10001 ]] || return 1
  router_mode="$(docker exec "$router_container" sh -ec '
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  ')" || return 1
  [[ "$router_mode" == active || "$router_mode" == maintenance ]]
}

persist_release_router_mode() {
  local mode="$1" router_container
  [[ "$mode" == maintenance || "$mode" == active ]] || return 1
  router_container="$(running_release_router_container)" || return 1
  docker exec "$router_container" sh -ec '
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
  ' sh "$mode" >/dev/null || return 1
}

reload_release_router_live() {
  local mode="$1" router_container
  [[ "$mode" == maintenance || "$mode" == active ]] || return 1
  router_container="$(running_release_router_container)" || return 1
  if [[ "$mode" == maintenance ]]; then
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    docker exec --env \
      "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$release_acceptance_token" \
      "$router_container" caddy reload \
      --config /etc/caddy/Caddyfile.maintenance --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock >/dev/null || return 1
  else
    docker exec "$router_container" caddy reload \
      --config /etc/caddy/Caddyfile --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock >/dev/null || return 1
  fi
}

reload_release_router() {
  local mode="$1"
  # Maintenance is committed before the live reload so a crash remains
  # fail-closed. Candidate activation uses reload_release_router_live directly
  # and commits durable active only after every acceptance record is sealed.
  persist_release_router_mode "$mode" || return 1
  reload_release_router_live "$mode"
}

run_candidate_database_chain() {
  local revision="$1" service container_id inspection bootstrap_state=""
  local -a mutation_services=(
    provision_auth_worker_role
    migrate
    reconcile_runtime_grants
    reconcile_auth_worker_grants
    reconcile_backup_grants
    verify_database_contract
    bootstrap_demo
  )
  validate_revision "$revision"

  # Remove only prior one-shot containers so Compose must execute the exact
  # candidate's complete ordered schema/grant/bootstrap chain on every attempt.
  compose rm --force --stop "${mutation_services[@]}" >/dev/null || return 1
  compose up --detach --no-build bootstrap_demo || return 1
  for _ in {1..900}; do
    container_id="$(compose ps --all --quiet bootstrap_demo)" || return 1
    if [[ "$container_id" =~ ^[a-f0-9]{12,64}$ && "$container_id" != *$'\n'* ]]; then
      bootstrap_state="$(docker inspect --format '{{.State.Status}}' "$container_id")" \
        || return 1
      [[ "$bootstrap_state" == exited ]] && break
      [[ "$bootstrap_state" == created || "$bootstrap_state" == running ]] || return 1
    fi
    sleep 2
  done
  [[ "$bootstrap_state" == exited ]] || return 1

  for service in "${mutation_services[@]}"; do
    container_id="$(compose ps --all --quiet "$service")" || return 1
    [[ "$container_id" =~ ^[a-f0-9]{12,64}$ && "$container_id" != *$'\n'* ]] \
      || return 1
    inspection="$(docker inspect "$container_id")" || return 1
    jq -e --arg revision "$revision" --arg service "$service" '
      length == 1 and
      .[0].Config.Labels["com.docker.compose.service"] == $service and
      .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
      .[0].State.Status == "exited" and .[0].State.ExitCode == 0 and
      .[0].State.OOMKilled == false and .[0].State.Error == ""
    ' <<<"$inspection" >/dev/null || return 1
  done
}

repository_root="$(git_as_deploy rev-parse --show-toplevel)" \
  || fail "the canonical development repository root could not be read"
[[ "$repository_root" == "$repository" ]] \
  || fail "the canonical development repository root changed"
repository_branch="$(git_as_deploy symbolic-ref --short HEAD)" \
  || fail "the development checkout branch could not be read"
[[ "$repository_branch" == stage ]] \
  || fail "the staging checkout is not on stage"
repository_origin="$(git_as_deploy remote get-url origin)" \
  || fail "the development origin could not be read"
[[ "$repository_origin" == "$expected_origin" ]] \
  || fail "the development origin is not the reviewed repository"
repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" \
  || fail "the development checkout status could not be read"
[[ -z "$repository_status" ]] \
  || fail "the development checkout is not clean"

git_as_deploy fetch --prune --force --no-tags origin \
  '+refs/heads/stage:refs/remotes/origin/stage' \
  '+refs/tags/deploy-stage-*:refs/tags/deploy-stage-*'

source_revision="$(git_as_deploy rev-parse HEAD)" \
  || fail "the deployed development revision could not be read"
candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/stage)" \
  || fail "the fetched development revision could not be read"
validate_revision "$source_revision"
validate_revision "$candidate_revision"
git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision" \
  || fail "origin/stage is not a fast-forward descendant of the deployed revision"

signal_tag="deploy-stage-$candidate_revision"
signal_revision="$(git_as_deploy rev-parse "refs/tags/$signal_tag^{commit}" 2>/dev/null)" \
  || fail "the immutable development deployment signal is unavailable"
[[ "$signal_revision" == "$candidate_revision" ]] \
  || fail "the successful quality gate has not published the immutable development deployment signal"
refresh_installed_deployer_if_needed "$candidate_revision"

verify_compose_boundary() {
  local revision="$1" topology rendered resource expected app_port app_origin app_alias
  local app_frontend_alias router_image found_resource_output
  local -a found_resources expected_resources=(
    "business_finlynq_development_pgdata"
    "business_finlynq_development_private"
    "business_finlynq_development_egress"
    "business_finlynq_development_edge"
  )
  validate_revision "$revision"
  topology="$(revision_release_topology "$revision")" \
    || fail "development release topology could not be classified"
  rendered="$(compose config --format json)" \
    || fail "development Compose configuration could not be rendered"
  app_origin="$(jq -er '.services.app.environment.APP_ORIGIN' <<<"$rendered")" \
    || fail "development APP_ORIGIN could not be read from Compose"
  [[ "$app_origin" == https://stage.business.finlynq.com ]] \
    || fail "development APP_ORIGIN must use the exact HTTPS development hostname"
  if [[ "$topology" == router ]]; then
    expected_resources+=(
      "business_finlynq_development_private-frontend"
      "business_finlynq_development_private-router-control"
      "business_finlynq_development_private-release-router-state-v2"
    )
    router_image="$(jq -er '.services.release_router.image' <<<"$rendered")" \
      || fail "development release-router image could not be read from Compose"
    app_port="$(jq -er '.services.release_router.ports[0].published' <<<"$rendered")" \
      || fail "development release-router port could not be read from Compose"
    app_alias="$(jq -er '.services.release_router.networks.business_finlynq_edge.aliases[0]' \
      <<<"$rendered")" \
      || fail "development release-router edge alias could not be read from Compose"
    app_frontend_alias="$(jq -er \
      '.services.app.networks.business_finlynq_frontend.aliases[0]' <<<"$rendered")" \
      || fail "development application frontend alias could not be read from Compose"
    [[ "$router_image" == "$release_router_reference" ]] \
      || fail "development release router must use the stable reviewed image"
    jq -e '
      ([.services.release_router.networks | keys[]] | sort) ==
        ["business_finlynq_edge", "business_finlynq_frontend",
          "business_finlynq_router_control"] and
      .networks.business_finlynq_router_control.name ==
        "business_finlynq_development_private-router-control" and
      ((.networks.business_finlynq_router_control.internal // false) == false) and
      .networks.business_finlynq_router_control.driver == "bridge" and
      .networks.business_finlynq_router_control.driver_opts == {
        "com.docker.network.bridge.enable_icc": "false",
        "com.docker.network.bridge.enable_ip_masquerade": "false"
      }
    ' <<<"$rendered" >/dev/null \
      || fail "development release-router control network is invalid"
    [[ "$app_port" == 3200 ]] \
      || fail "development release router must bind loopback port 3200"
    [[ "$app_alias" == development-app ]] \
      || fail "development release router must expose only its dedicated edge alias"
    [[ "$app_frontend_alias" == release-app \
      && "$(jq -r '.services.app.ports | length' <<<"$rendered")" == 0 \
      && "$(jq -r '.services.app.networks | has("business_finlynq_edge")' \
        <<<"$rendered")" == false ]] \
      || fail "development application is not isolated behind the release router"
  else
    app_port="$(jq -er '.services.app.ports[0].published' <<<"$rendered")" \
      || fail "legacy development app port could not be read from Compose"
    app_alias="$(jq -er '.services.app.networks.business_finlynq_edge.aliases[0]' \
      <<<"$rendered")" \
      || fail "legacy development edge alias could not be read from Compose"
    [[ "$app_port" == 3200 ]] || fail "legacy development app must bind loopback port 3200"
    [[ "$app_alias" == development-app ]] \
      || fail "legacy development app must expose only its dedicated edge alias"
    [[ "$(jq -r '.services | has("release_router")' <<<"$rendered")" == false ]] \
      || fail "legacy development Compose unexpectedly defines a release router"
  fi
  found_resource_output="$(jq -er '.volumes[].name, .networks[].name' <<<"$rendered" \
    | sort -u)" \
    || fail "development Compose resource inventory could not be rendered"
  [[ -n "$found_resource_output" ]] \
    || fail "development Compose resource inventory is empty"
  mapfile -t found_resources <<<"$found_resource_output" \
    || fail "development Compose resource inventory could not be parsed"
  for expected in "${expected_resources[@]}"; do
    printf '%s\n' "${found_resources[@]}" | grep -Fxq "$expected" \
      || fail "development resource is not isolated: $expected"
  done
  for resource in "${found_resources[@]}"; do
    [[ "$resource" == business_finlynq_development_* ]] \
      || fail "development Compose references a non-development resource: $resource"
  done
}

document_provider_configuration_matches() {
  local container="$1" rendered="$2" provider setting expected_record actual_record source target \
    mounts expected_digest actual_digest provider_record oidc_contract_expected="${3:-true}"
  local -a oidc_secret_settings=()
  [[ "$oidc_contract_expected" == true || "$oidc_contract_expected" == false ]] || return 1
  if [[ "$oidc_contract_expected" == true ]]; then
    oidc_secret_settings=(AUTH_OIDC_CLIENT_SECRET_FILE AUTH_OIDC_IDENTITY_MAP_FILE)
  fi
  mounts="$(docker inspect --format '{{json .Mounts}}' "$container")" || return 1
  for provider in GOOGLE MICROSOFT; do
    for setting in "DOCUMENT_${provider}_CLIENT_ID" "DOCUMENT_${provider}_CLIENT_SECRET_FILE"; do
      expected_record="$(jq -ce --arg setting "$setting" '
        .services.app.environment as $environment |
        if ($environment | has($setting)) then
          {present: true, value: ($environment[$setting] | tostring)}
        else
          {present: false, value: ""}
        end
      ' <<<"$rendered")" || return 1
      actual_record="$(docker inspect --format '{{json .Config.Env}}' "$container" \
        | jq -ce --arg prefix "$setting=" '
          [.[] | select(startswith($prefix)) | ltrimstr($prefix)] as $values |
          if ($values | length) == 1 then
            {present: true, value: $values[0]}
          elif ($values | length) == 0 then
            {present: false, value: ""}
          else
            error("duplicate container environment setting")
          end
        ')" || return 1
      [[ "$actual_record" == "$expected_record" ]] || return 1
    done
    provider_record="$(jq -ce \
      --arg id "DOCUMENT_${provider}_CLIENT_ID" \
      --arg secret "DOCUMENT_${provider}_CLIENT_SECRET_FILE" '
        .services.app.environment as $environment |
        {
          idPresent: ($environment | has($id)),
          secretPresent: ($environment | has($secret)),
          target: (if ($environment | has($secret)) then ($environment[$secret] | tostring) else "" end)
        }
      ' <<<"$rendered")" || return 1
    # Recovery to a revision predating cloud storage has no provider mounts.
    if jq -e '.idPresent == false and .secretPresent == false and .target == ""' \
      <<<"$provider_record" >/dev/null; then
      continue
    fi
    jq -e '.idPresent == true and .secretPresent == true' <<<"$provider_record" >/dev/null \
      || return 1
    target="$(jq -er '.target' <<<"$provider_record")" || return 1
    [[ -n "$target" ]] || return 1
    # Compose versions render secret targets as either a filename or the
    # full /run/secrets path. Accept those two exact forms, not any basename.
    source="$(jq -er --arg target "$target" '
      . as $config |
      [.services.app.secrets[] |
        select((.target // .source) == $target or
          (.target // .source) == ($target | split("/") | last)) |
        $config.secrets[.source].file] |
      if length == 1 then .[0] else error("secret mount source is not unique") end
    ' <<<"$rendered")" || return 1
    [[ -f "$source" && ! -L "$source" ]] || return 1
    jq -e --arg source "$source" --arg target "$target" \
      '[.[] | select(.Source == $source and .Destination == $target and .RW == false)] | length == 1' \
      <<<"$mounts" >/dev/null || return 1
    # Detect secret rotation, including atomic replacement of a bind-mounted
    # file at the same path. Values and digests never enter deployment logs.
    expected_digest="$(sha256sum -- "$source")" || return 1
    expected_digest="${expected_digest%% *}"
    actual_digest="$(docker exec "$container" node -e \
      'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' \
      "$target" 2>/dev/null)" || return 1
    [[ "$actual_digest" == "$expected_digest" ]] || return 1
  done

  # OIDC uses the same immutable, read-only secret boundary as document
  # providers. Verify both mounted files even while the feature gate is off so
  # an atomic host-side rotation cannot leave the running app on a stale inode.
  for setting in "${oidc_secret_settings[@]}"; do
    expected_record="$(jq -ce --arg setting "$setting" '
      .services.app.environment as $environment |
      if ($environment | has($setting)) then
        {present: true, value: ($environment[$setting] | tostring)}
      else
        {present: false, value: ""}
      end
    ' <<<"$rendered")" || return 1
    actual_record="$(docker inspect --format '{{json .Config.Env}}' "$container" \
      | jq -ce --arg prefix "$setting=" '
        [.[] | select(startswith($prefix)) | ltrimstr($prefix)] as $values |
        if ($values | length) == 1 then
          {present: true, value: $values[0]}
        elif ($values | length) == 0 then
          {present: false, value: ""}
        else
          error("duplicate container environment setting")
        end
      ')" || return 1
    [[ "$actual_record" == "$expected_record" ]] || return 1
    jq -e '.present == true and .value != ""' <<<"$expected_record" >/dev/null \
      || continue
    target="$(jq -er '.value' <<<"$expected_record")" || return 1
    source="$(jq -er --arg target "$target" '
      . as $config |
      [.services.app.secrets[] |
        select((.target // .source) == $target or
          (.target // .source) == ($target | split("/") | last)) |
        $config.secrets[.source].file] |
      if length == 1 then .[0] else error("secret mount source is not unique") end
    ' <<<"$rendered")" || return 1
    [[ -f "$source" && ! -L "$source" ]] || return 1
    jq -e --arg source "$source" --arg target "$target" \
      '[.[] | select(.Source == $source and .Destination == $target and .RW == false)] | length == 1' \
      <<<"$mounts" >/dev/null || return 1
    expected_digest="$(sha256sum -- "$source")" || return 1
    expected_digest="${expected_digest%% *}"
    actual_digest="$(docker exec "$container" node -e \
      'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' \
      "$target" 2>/dev/null)" || return 1
    [[ "$actual_digest" == "$expected_digest" ]] || return 1
  done
}

network_alias_has_exact_owner() {
  local network="$1" alias="$2" expected_container="$3"
  local expected_full_id network_query container networks owner_count=0
  expected_full_id="$(docker inspect --format '{{.Id}}' "$expected_container")" \
    || return 1
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] || return 1
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}')" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container")" \
      || return 1
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
      [[ "$container" == "$expected_full_id" ]] || return 1
    fi
  done <<<"$network_query"
  [[ "$owner_count" == 1 ]]
}

network_alias_has_no_owner() {
  local network="$1" alias="$2"
  local network_query container networks
  docker network inspect "$network" >/dev/null 2>&1 || return 1
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}')" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container")" \
      || return 1
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      return 1
    fi
  done <<<"$network_query"
  return 0
}

exact_development_app_container() {
  local revision="$1" container_output container image_reference inspection
  local -a app_containers=()
  validate_revision "$revision"
  container_output="$(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=app)" || return 1
  if [[ -n "$container_output" ]]; then
    mapfile -t app_containers <<<"$container_output" || return 1
  fi
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  container="${app_containers[0]}"
  [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
  image_reference="business-finlynq-app:$revision"
  inspection="$(docker inspect "$container")" || return 1
  jq -e --arg container "$container" --arg project "$project" \
    --arg revision "$revision" --arg image "$image_reference" '
    length == 1 and .[0].Id == $container and
    (.[0].Image | test("^sha256:[a-f0-9]{64}$")) and
    .[0].Config.Image == $image and
    .[0].Config.Labels["com.docker.compose.project"] == $project and
    .[0].Config.Labels["com.docker.compose.service"] == "app" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    (.[0].State.Running | type) == "boolean"
  ' <<<"$inspection" >/dev/null || return 1
  printf '%s\n' "$container"
}

exact_legacy_development_app_container() {
  local revision="$1"
  validate_revision "$revision"
  [[ "$(revision_release_topology "$revision")" == legacy ]] || return 1
  exact_development_app_container "$revision"
}

quarantine_legacy_development_app_alias() {
  local revision="$1" expected_container="$2" container running networks
  validate_revision "$revision"
  [[ "$expected_container" =~ ^[a-f0-9]{64}$ ]] || return 1
  container="$(exact_legacy_development_app_container "$revision")" || return 1
  [[ "$container" == "$expected_container" ]] || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$container")" || return 1
  [[ "$running" == false ]] || return 1
  network_alias_has_exact_owner \
    business_finlynq_development_edge development-app "$container" || return 1
  docker network disconnect --force business_finlynq_development_edge \
    "$container" || return 1
  networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
    "$container")" || return 1
  jq -e 'has("business_finlynq_development_edge") | not' \
    <<<"$networks" >/dev/null || return 1
  network_alias_has_no_owner \
    business_finlynq_development_edge development-app
}

restore_legacy_development_app_alias() {
  local revision="$1" failed_revision="$2" container running networks container_output \
    candidate_container
  local -a app_containers=()
  validate_revision "$revision"
  validate_revision "$failed_revision"
  [[ "$(revision_release_topology "$revision")" == legacy ]] || return 1
  [[ "$(revision_release_topology "$failed_revision")" == router ]] || return 1
  if ! container="$(exact_legacy_development_app_container "$revision")"; then
    # Once live apply has replaced the stopped legacy container, there is no
    # legacy endpoint to reconnect. Accept only absence or the one exact failed
    # candidate app, prove the public alias has no owner, and let the verified
    # legacy Compose definition recreate its app below.
    container_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=app)" || return 1
    if [[ -n "$container_output" ]]; then
      mapfile -t app_containers <<<"$container_output" || return 1
    fi
    (( ${#app_containers[@]} <= 1 )) || return 1
    if (( ${#app_containers[@]} == 1 )); then
      candidate_container="${app_containers[0]}"
      [[ "$(exact_development_app_container "$failed_revision")" \
        == "$candidate_container" ]] || return 1
      network_alias_has_no_owner \
        business_finlynq_development_edge development-app || return 1
      docker rm --force -- "$candidate_container" >/dev/null || return 1
      container_output="$(docker ps --all --no-trunc --quiet \
        --filter label=com.docker.compose.project="$project" \
        --filter label=com.docker.compose.service=app)" || return 1
      [[ -z "$container_output" ]] || return 1
    fi
    network_alias_has_no_owner \
      business_finlynq_development_edge development-app || return 1
    return 0
  fi
  networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
    "$container")" || return 1
  if jq -e '
    has("business_finlynq_development_edge") and
    any(.business_finlynq_development_edge.Aliases[]?; . == "development-app")
  ' <<<"$networks" >/dev/null; then
    network_alias_has_exact_owner \
      business_finlynq_development_edge development-app "$container"
    return
  fi
  jq -e 'has("business_finlynq_development_edge") | not' \
    <<<"$networks" >/dev/null || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$container")" || return 1
  [[ "$running" == false ]] || return 1
  network_alias_has_no_owner \
    business_finlynq_development_edge development-app || return 1
  docker network connect --alias development-app \
    business_finlynq_development_edge "$container" || return 1
  network_alias_has_exact_owner \
    business_finlynq_development_edge development-app "$container"
}

release_is_accepted() {
  local expected_revision="$1" topology app_container app_environment actual expected detailed_health \
    public_health rendered hostname require_public setting app_container_output app_revision router_container_output \
    app_network_contract oidc_contract_expected oidc_contract_status public_policy="${2:-full}"
  local -a app_containers router_containers public_health_headers=() required_environment_settings=(
    DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED
    ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED AUTH_EMAIL_PROVIDER AUTH_EMAIL_FROM
    AUTH_EMAIL_REPLY_TO SIGNUP_TURNSTILE_ENABLED SIGNUP_TURNSTILE_SITE_KEY
    BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED YAHOO_FX_ENABLED DOCUMENT_INBOX_MAX_DEPTH
    DOCUMENT_INBOX_MAX_PROVIDER_CALLS
  )
  validate_revision "$expected_revision"
  [[ "$public_policy" == full || "$public_policy" == private ]] || return 1
  oidc_contract_expected=false
  if revision_uses_oidc_runtime_contract "$expected_revision"; then
    oidc_contract_expected=true
    required_environment_settings+=(
      AUTH_OIDC_ENABLED AUTH_OIDC_ISSUER AUTH_OIDC_AUTHORIZATION_ENDPOINT
      AUTH_OIDC_TOKEN_ENDPOINT AUTH_OIDC_JWKS_URI AUTH_OIDC_CLIENT_ID
      AUTH_OIDC_ALLOWED_TENANTS AUTH_OIDC_MAXIMUM_TOKEN_LIFETIME_SECONDS
      AUTH_OIDC_TOKEN_TIMEOUT_MILLISECONDS AUTH_OIDC_JWKS_TIMEOUT_MILLISECONDS
    )
  else
    oidc_contract_status="$?"
    [[ "$oidc_contract_status" == 1 ]] || return 1
  fi
  if revision_uses_oidc_signup_runtime_contract "$expected_revision"; then
    required_environment_settings+=(AUTH_OIDC_SIGNUP_ENABLED)
  else
    oidc_contract_status="$?"
    [[ "$oidc_contract_status" == 1 ]] || return 1
  fi
  app_container_output="$(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=app)" || return 1
  app_containers=()
  if [[ -n "$app_container_output" ]]; then
    mapfile -t app_containers <<<"$app_container_output" || return 1
  fi
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  app_revision="$(docker inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$app_container")" \
    || return 1
  [[ "$app_revision" == "$expected_revision" ]] || return 1
  topology="$(revision_release_topology "$expected_revision")" || return 1
  app_network_contract="$(docker inspect --format \
    '{"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}' \
    "$app_container")" || return 1
  router_container_output="$(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=release_router)" || return 1
  router_containers=()
  if [[ -n "$router_container_output" ]]; then
    mapfile -t router_containers <<<"$router_container_output" || return 1
  fi
  rendered="$(compose config --format json)" || return 1
  if [[ "$topology" == router ]]; then
    ensure_release_router_image false || return 1
    jq -e '
      ((.ports // {}) | length) == 0 and
      (.networks | has("business_finlynq_development_edge") | not) and
      (.networks | has("business_finlynq_development_private-frontend")) and
      ([.networks["business_finlynq_development_private-frontend"].Aliases[]] |
        index("release-app")) != null
    ' <<<"$app_network_contract" >/dev/null || return 1
    [[ "${#router_containers[@]}" == 1 ]] || return 1
    release_router_runtime_is_accepted || return 1
    network_alias_has_exact_owner \
      business_finlynq_development_edge development-app \
      "${router_containers[0]}" || return 1
    network_alias_has_exact_owner \
      business_finlynq_development_private-frontend release-app \
      "$app_container" || return 1
  else
    [[ "${#router_containers[@]}" == 0 ]] || return 1
    jq -e '
      (.ports["3000/tcp"] == [{"HostIp":"127.0.0.1", "HostPort":"3200"}]) and
      (.networks | has("business_finlynq_development_edge")) and
      ([.networks.business_finlynq_development_edge.Aliases[]] |
        index("development-app")) != null and
      (.networks | has("business_finlynq_development_private-frontend") | not)
    ' <<<"$app_network_contract" >/dev/null || return 1
    network_alias_has_exact_owner \
      business_finlynq_development_edge development-app \
      "$app_container" || return 1
  fi
  document_provider_configuration_matches \
    "$app_container" "$rendered" "$oidc_contract_expected" || return 1
  app_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_container")" || return 1
  for setting in "${required_environment_settings[@]}"; do
    expected="$(jq -er --arg setting "$setting" '
      .services.app.environment as $environment |
      if ($environment | has($setting)) then ($environment[$setting] | tostring)
      else error("missing Compose environment setting") end
    ' <<<"$rendered")" || return 1
    actual="$(awk -F= -v setting="$setting" \
      '$1 == setting { count++; sub(/^[^=]*=/, ""); value = $0 }
       END { if (count != 1) exit 42; printf "%s", value }' <<<"$app_environment")" \
      || return 1
    [[ "$actual" == "$expected" ]] || return 1
  done
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3200/api/health)" \
    || return 1
  jq -e --arg revision "$expected_revision" \
    '.status == "ready" and .revision == $revision' <<<"$detailed_health" >/dev/null \
    || return 1
  require_public="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" || return 1
  [[ "$require_public" == true || "$require_public" == false ]] || return 1
  if [[ "$require_public" == true && "$public_policy" == full ]]; then
    hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" || return 1
    [[ "$hostname" == stage.business.finlynq.com ]] || return 1
    if [[ -n "$release_acceptance_token" ]]; then
      [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] || return 1
      public_health_headers=(
        --header "Authorization: Bearer $release_acceptance_token"
      )
    fi
    public_health="$(curl --disable --noproxy '*' --fail --silent --show-error --max-time 30 \
      "${public_health_headers[@]}" \
      "https://$hostname/api/health")" || return 1
    jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
      <<<"$public_health" >/dev/null || return 1
  fi
}

ensure_revision_runtime_images() {
  local revision="$1" topology reference image_revision needs_build=false account_login_enabled
  local -a services references
  validate_revision "$revision"
  topology="$(revision_release_topology "$revision")" || return 1
  services=(database app)
  references=("business-finlynq-database:$revision" "business-finlynq-app:$revision")
  if [[ "$topology" == router ]]; then
    ensure_release_router_image false || return 1
  fi
  account_login_enabled="$(read_environment_value ACCOUNT_LOGIN_ENABLED)" || return 1
  [[ "$account_login_enabled" == true || "$account_login_enabled" == false ]] || return 1
  if [[ "$account_login_enabled" == true ]]; then
    services+=(auth_email_worker)
    references+=("business-finlynq-auth-worker:$revision")
  fi

  for reference in "${references[@]}"; do
    if ! image_revision="$(docker image inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference" 2>/dev/null)"; then
      image_revision=""
    fi
    [[ "$image_revision" == "$revision" ]] || needs_build=true
  done
  if [[ "$needs_build" == true ]]; then
    compose build "${services[@]}" || return 1
  fi
  for reference in "${references[@]}"; do
    image_revision="$(docker image inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference" 2>/dev/null)" \
      || return 1
    [[ "$image_revision" == "$revision" ]] || return 1
  done
}

start_revision_runtime() {
  local revision="$1" topology account_login_enabled
  validate_revision "$revision"
  topology="$(revision_release_topology "$revision")" || return 1
  if [[ "$topology" == router ]]; then
    release_router_runtime_is_accepted || return 1
  fi
  compose up --detach --wait --no-deps --no-build database || return 1
  compose up --detach --wait --no-deps --no-build app || return 1
  account_login_enabled="$(read_environment_value ACCOUNT_LOGIN_ENABLED)" || return 1
  [[ "$account_login_enabled" == true || "$account_login_enabled" == false ]] || return 1
  if [[ "$account_login_enabled" == true ]]; then
    compose --profile auth-email up --detach --wait --no-deps --no-build auth_email_worker \
      || return 1
  else
    compose --profile auth-email rm --force --stop auth_email_worker >/dev/null 2>&1 || true
  fi
}

remove_failed_router_for_legacy_recovery() {
  local failed_revision="$1" recovery_revision="$2" router_output
  local -a router_containers=()
  validate_revision "$failed_revision"
  validate_revision "$recovery_revision"
  [[ "$(revision_release_topology "$failed_revision")" == router ]] || return 1
  [[ "$(revision_release_topology "$recovery_revision")" == legacy ]] || return 1
  router_output="$(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -n "$router_output" ]]; then
    mapfile -t router_containers <<<"$router_output" || return 1
  fi
  (( ${#router_containers[@]} <= 1 )) || return 1
  if (( ${#router_containers[@]} == 1 )); then
    release_router_container_is_attested "${router_containers[0]}" || return 1
    docker rm --force -- "${router_containers[0]}" >/dev/null || return 1
  fi
}

restore_accepted_revision() {
  local failed_revision="$1" recovery_revision="$2" current_head current_environment_revision \
    repository_status recovery_topology router_output router_container="" router_running \
    recovery_router_maintenance=false
  local -a existing_routers=()
  validate_revision "$failed_revision"
  validate_revision "$recovery_revision"
  [[ "$failed_revision" != "$recovery_revision" ]] || return 1
  git_as_deploy merge-base --is-ancestor "$recovery_revision" "$failed_revision" || return 1
  recovery_topology="$(revision_release_topology "$recovery_revision")" || return 1

  router_output="$(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -n "$router_output" ]]; then
    mapfile -t existing_routers <<<"$router_output" || return 1
  fi
  (( ${#existing_routers[@]} <= 1 )) || return 1
  if (( ${#existing_routers[@]} == 1 )); then
    router_container="${existing_routers[0]}"
    release_router_container_is_attested "$router_container" || return 1
    router_running="$(docker inspect --format '{{.State.Running}}' "$router_container")" \
      || return 1
    if [[ "$router_running" == true ]]; then
      if [[ -z "$release_acceptance_token" ]]; then
        release_acceptance_token="$(openssl rand -hex 32)" || return 1
      fi
      [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] || return 1
      if release_router_runtime_is_accepted \
        && reload_release_router maintenance \
        && wait_for_release_router_maintenance; then
        recovery_router_maintenance=true
      else
        # A broken admin socket must not make recovery circular. Stop only the
        # exact attested stable router, then set its restart mode offline.
        docker stop --time 30 "$router_container" >/dev/null || return 1
        persist_release_router_mode_offline "$router_container" maintenance || return 1
      fi
    else
      persist_release_router_mode_offline "$router_container" maintenance || return 1
    fi
  fi

  current_head="$(git_as_deploy rev-parse HEAD)" || return 1
  if [[ "$current_head" == "$failed_revision" ]]; then
    git_as_deploy reset --hard "$recovery_revision" >/dev/null || return 1
  elif [[ "$current_head" != "$recovery_revision" ]]; then
    return 1
  fi
  repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" || return 1
  [[ -z "$repository_status" ]] || return 1

  current_environment_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)" \
    || return 1
  if [[ "$current_environment_revision" == "$failed_revision" ]]; then
    replace_environment_revision "$failed_revision" "$recovery_revision" || return 1
  elif [[ "$current_environment_revision" != "$recovery_revision" ]]; then
    return 1
  fi

  ( verify_compose_boundary "$recovery_revision" ) || return 1
  ensure_revision_runtime_images "$recovery_revision" || return 1
  # A legacy app owns the same host port and external alias that the router
  # owns after bootstrap. Keep a failed candidate router serving maintenance
  # until the legacy checkout and images are ready, then remove only that exact
  # failed-revision router immediately before starting the accepted app.
  if [[ "$recovery_topology" == legacy ]]; then
    remove_failed_router_for_legacy_recovery "$failed_revision" "$recovery_revision" \
      || return 1
    # First-router bootstrap quarantines the stopped legacy endpoint so Docker
    # cannot retain a second public alias owner. Restore only the exact accepted
    # legacy app after the failed router is gone and before that app can start.
    restore_legacy_development_app_alias "$recovery_revision" "$failed_revision" || return 1
    release_acceptance_token=""
  else
    router_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=release_router)" || return 1
    if [[ -z "$router_output" ]]; then
      if docker volume inspect "$release_router_state_volume" >/dev/null 2>&1; then
        persist_release_router_named_volume_mode maintenance || return 1
      fi
      compose up --detach --wait --no-deps --no-build release_router || return 1
    else
      [[ "$router_output" =~ ^[a-f0-9]{12,64}$ && "$router_output" != *$'\n'* ]] \
        || return 1
      release_router_container_is_attested "$router_output" || return 1
      if [[ "$(docker inspect --format '{{.State.Running}}' "$router_output")" != true ]]; then
        persist_release_router_mode_offline "$router_output" maintenance || return 1
        docker start "$router_output" >/dev/null || return 1
      fi
    fi
    for _ in {1..30}; do
      release_router_runtime_is_accepted && break
      sleep 1
    done
    release_router_runtime_is_accepted || return 1
    if [[ -z "$release_acceptance_token" ]]; then
      release_acceptance_token="$(openssl rand -hex 32)" || return 1
    fi
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] || return 1
    reload_release_router maintenance || return 1
    wait_for_release_router_maintenance || return 1
    recovery_router_maintenance=true
  fi
  start_revision_runtime "$recovery_revision" || return 1
  if [[ "$recovery_topology" == router ]]; then
    [[ "$recovery_router_maintenance" == true ]] || return 1
    # The stable router is intentionally serving maintenance until the
    # recovered app has passed its private checks. A full acceptance probe at
    # this point would necessarily receive the router's fail-closed 503 and
    # turn every otherwise-successful router recovery into a hard failure.
    ( release_is_accepted "$recovery_revision" private ) || return 1
    development_router_live_uncommitted="true"
    reload_release_router_live active || return 1
    release_acceptance_token=""
    ( release_is_accepted "$recovery_revision" ) || return 1
    persist_release_router_mode active || return 1
    development_router_live_uncommitted="false"
  else
    ( release_is_accepted "$recovery_revision" ) || return 1
  fi
}

contain_development_router_on_failure() {
  local router_output router_container router_running
  local -a routers=()
  router_output="$(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -n "$router_output" ]]; then
    mapfile -t routers <<<"$router_output" || return 1
  fi
  (( ${#routers[@]} <= 1 )) || return 1
  if (( ${#routers[@]} == 0 )); then
    if docker volume inspect "$release_router_state_volume" >/dev/null 2>&1; then
      persist_release_router_named_volume_mode maintenance || return 1
    fi
    return 0
  fi
  router_container="${routers[0]}"
  release_router_container_is_attested "$router_container" || return 1
  router_running="$(docker inspect --format '{{.State.Running}}' "$router_container")" \
    || return 1
  if [[ "$router_running" == true ]]; then
    [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
      || release_acceptance_token="$(openssl rand -hex 32)" || return 1
    if release_router_runtime_is_accepted \
      && reload_release_router maintenance \
      && wait_for_release_router_maintenance \
      && network_alias_has_exact_owner \
        business_finlynq_development_edge development-app "$router_container"; then
      return 0
    fi
    docker stop --time 30 "$router_container" >/dev/null || return 1
  fi
  persist_release_router_mode_offline "$router_container" maintenance \
    && network_alias_has_exact_owner \
      business_finlynq_development_edge development-app "$router_container"
}

run_public_acceptance() {
  local attempt
  for attempt in 1 2; do
    if ( wait_for_public_readiness ) \
      && compose --profile acceptance run --rm --no-deps release_acceptance; then
      return 0
    fi
    printf 'Development public acceptance attempt %s failed. Retrying once.\n' "$attempt" >&2
  done
  return 1
}

contain_uncommitted_development_router_on_exit() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "$status" != 0 && "$development_router_live_uncommitted" == true ]]; then
    set +e
    if ! contain_development_router_on_failure; then
      printf '%s\n' \
        'URGENT: an uncommitted live development route could not be returned to maintenance.' >&2
    fi
  fi
  exit "$status"
}
trap contain_uncommitted_development_router_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_compose_boundary "$source_revision"

if [[ -e "$hard_failure_latch" || -L "$hard_failure_latch" ]]; then
  hard_failure_kind="$(read_state_value "$hard_failure_latch" kind)" \
    || fail "the protected hard-failure kind could not be read"
  [[ "$hard_failure_kind" == hard ]] \
    || fail "the protected hard-failure state has an invalid kind"
  hard_candidate="$(read_state_value "$hard_failure_latch" candidateRevision)" \
    || fail "the hard-failure candidate revision could not be read"
  validate_revision "$hard_candidate"
  fail "development recovery could not be verified for $hard_candidate; inspect it and clear the exact hard failure explicitly"
fi

if [[ -e "$legacy_failure_latch" || -L "$legacy_failure_latch" ]]; then
  legacy_source="$(read_state_value "$legacy_failure_latch" sourceRevision)" \
    || fail "the legacy source revision could not be read"
  legacy_candidate="$(read_state_value "$legacy_failure_latch" candidateRevision)" \
    || fail "the legacy candidate revision could not be read"
  validate_revision "$legacy_source"
  validate_revision "$legacy_candidate"
  git_as_deploy merge-base --is-ancestor "$legacy_source" "$legacy_candidate" \
    || fail "the legacy recovery revision is not an ancestor of its failed candidate"

  legacy_recovered=false
  if [[ "$source_revision" == "$legacy_candidate" ]] \
    && restore_accepted_revision "$legacy_candidate" "$legacy_source"; then
    source_revision="$legacy_source"
    legacy_recovered=true
  elif [[ "$source_revision" == "$legacy_source" ]] \
    && release_is_accepted "$legacy_source"; then
    legacy_recovered=true
  fi

  if [[ "$legacy_recovered" == true ]]; then
    write_accepted_revision "$legacy_source"
    cleanup_complete=true
    remove_revision_artifacts "$legacy_candidate" || cleanup_complete=false
    bound_build_cache || cleanup_complete=false
    write_failure_state "$quarantine_file" quarantine "$legacy_source" "$legacy_candidate" \
      legacy-failure-latch "$legacy_source" "$cleanup_complete"
    rm -- "$legacy_failure_latch"
    sync -f -- "$state_directory"
    printf 'Restored legacy accepted revision %s and quarantined failed candidate %s (cleanupComplete=%s).\n' \
      "$legacy_source" "$legacy_candidate" "$cleanup_complete"
  else
    write_failure_state "$hard_failure_latch" hard "$legacy_source" "$legacy_candidate" \
      legacy-failure-latch "" false
    rm -- "$legacy_failure_latch"
    sync -f -- "$state_directory"
    fail "legacy accepted revision could not be restored and verified; hard recovery state recorded"
  fi
fi

accepted_revision=""
if [[ -e "$accepted_revision_file" || -L "$accepted_revision_file" ]]; then
  accepted_revision="$(read_state_value "$accepted_revision_file" revision)" \
    || fail "the accepted development revision could not be read"
  validate_revision "$accepted_revision"
  git_as_deploy merge-base --is-ancestor "$accepted_revision" "$candidate_revision" \
    || fail "the accepted development revision is not an ancestor of the candidate"
fi

if [[ -z "$accepted_revision" ]]; then
  if release_is_accepted "$source_revision"; then
    write_accepted_revision "$source_revision"
    accepted_revision="$source_revision"
  else
    existing_project_container_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project")" \
      || fail "the existing development project container inventory could not be read"
    existing_app_container_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=app)" \
      || fail "the existing development app container inventory could not be read"
    existing_router_container_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=release_router)" \
      || fail "the existing development release-router inventory could not be read"
    existing_project_containers=()
    existing_app_containers=()
    existing_router_containers=()
    if [[ -n "$existing_project_container_output" ]]; then
      mapfile -t existing_project_containers <<<"$existing_project_container_output" \
        || fail "the existing development project container inventory could not be parsed"
    fi
    if [[ -n "$existing_app_container_output" ]]; then
      mapfile -t existing_app_containers <<<"$existing_app_container_output" \
        || fail "the existing development app container inventory could not be parsed"
    fi
    if [[ -n "$existing_router_container_output" ]]; then
      mapfile -t existing_router_containers <<<"$existing_router_container_output" \
        || fail "the existing development release-router inventory could not be parsed"
    fi
    if [[ "$source_revision" != "$candidate_revision" \
      || ${#existing_project_containers[@]} != 0 \
      || ${#existing_app_containers[@]} != 0 \
      || ${#existing_router_containers[@]} != 0 ]]; then
      write_failure_state "$hard_failure_latch" hard "$source_revision" "$candidate_revision" \
        accepted-state-initialization "" false
      fail "no verified accepted revision is available for automatic recovery"
    fi
    assert_fresh_development_resources
    initial_development_bootstrap="true"
    printf 'No prior development runtime exists; installing initial revision %s.\n' \
      "$candidate_revision"
  fi
elif [[ "$source_revision" != "$accepted_revision" ]]; then
  if release_is_accepted "$source_revision" private; then
    interrupted_topology="$(revision_release_topology "$source_revision")" \
      || fail "interrupted development release topology could not be classified"
    interrupted_require_public="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
    [[ "$interrupted_require_public" == true || "$interrupted_require_public" == false ]] \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
    if [[ "$interrupted_topology" == router ]]; then
      development_router_live_uncommitted="true"
      reload_release_router_live active \
        || fail "interrupted development finalization could not restore active live routing"
      release_acceptance_token=""
      release_is_accepted "$source_revision" \
        || fail "interrupted development finalization did not pass active-routing acceptance"
      if [[ "$interrupted_require_public" == true ]]; then
        verify_external_edge_if_selected "$source_revision" live-uncommitted
      fi
      commit_release_router_acceptance "$source_revision" "$accepted_revision" \
        || fail "interrupted development finalization could not commit active routing"
      development_router_live_uncommitted="false"
    else
      write_accepted_revision "$source_revision"
    fi
    accepted_revision="$source_revision"
    printf 'Recorded already healthy revision %s after an interrupted finalization.\n' \
      "$source_revision"
  elif release_is_accepted "$accepted_revision" \
    && restore_accepted_revision "$source_revision" "$accepted_revision"; then
    source_revision="$accepted_revision"
    printf 'Restored accepted revision %s after an interrupted deployment.\n' \
      "$accepted_revision"
  else
    write_failure_state "$hard_failure_latch" hard "$accepted_revision" "$source_revision" \
      interrupted-recovery "" false
    fail "the interrupted deployment could not be restored to its accepted revision"
  fi
fi

# Recovery must establish a healthy accepted source first. A router-aware
# source can then be checked with the exact candidate verifier before mutation.
# During the one-time legacy-to-router bootstrap, that verifier intentionally
# waits until the candidate router exists; the accepted legacy runtime and its
# public route were already checked by release_is_accepted above.
if [[ "$source_revision" != "$candidate_revision" ]]; then
  require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
    || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
  [[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]] \
    || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
  if [[ "$require_public_acceptance" == true \
    && "$(revision_release_topology "$source_revision")" == router ]]; then
    verify_external_edge_if_selected "$candidate_revision"
  elif [[ "$require_public_acceptance" == true ]]; then
    printf 'Deferring candidate external-edge verification until the first release router is live.\n'
  fi
fi

if [[ -e "$quarantine_file" || -L "$quarantine_file" ]]; then
  quarantine_kind="$(read_state_value "$quarantine_file" kind)" \
    || fail "the protected quarantine kind could not be read"
  [[ "$quarantine_kind" == quarantine ]] \
    || fail "the protected quarantine state has an invalid kind"
  quarantined_source="$(read_state_value "$quarantine_file" sourceRevision)" \
    || fail "the quarantined source revision could not be read"
  quarantined_candidate="$(read_state_value "$quarantine_file" candidateRevision)" \
    || fail "the quarantined candidate revision could not be read"
  quarantined_stage="$(read_state_value "$quarantine_file" stage)" \
    || fail "the quarantined deployment stage could not be read"
  validate_revision "$quarantined_source"
  validate_revision "$quarantined_candidate"
  [[ "$quarantined_candidate" != "$accepted_revision" ]] \
    || fail "the accepted revision cannot also be quarantined"
  git_as_deploy merge-base --is-ancestor "$quarantined_candidate" "$candidate_revision" \
    || fail "the quarantined revision is not an ancestor of the current candidate"

  cleanup_complete=true
  remove_revision_artifacts "$quarantined_candidate" || cleanup_complete=false
  bound_build_cache || cleanup_complete=false
  write_failure_state "$quarantine_file" quarantine "$quarantined_source" \
    "$quarantined_candidate" "$quarantined_stage" "$accepted_revision" "$cleanup_complete"
  [[ "$cleanup_complete" == true ]] \
    || fail "quarantined revision cleanup is incomplete and will be retried automatically"

  if [[ "$quarantined_candidate" == "$candidate_revision" ]]; then
    printf 'Development candidate %s remains quarantined; cleanup is complete and a newer CI-approved revision is required.\n' \
      "$candidate_revision"
    exit 0
  fi
  rm -- "$quarantine_file"
  sync -f -- "$state_directory"
  printf 'Removed artifacts for quarantined revision %s before evaluating newer revision %s.\n' \
    "$quarantined_candidate" "$candidate_revision"
fi

if [[ "$source_revision" == "$candidate_revision" ]]; then
  same_revision_topology="$(revision_release_topology "$candidate_revision")" \
    || fail "same-revision development topology could not be classified"
  if release_is_accepted "$candidate_revision" private; then
    require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
    [[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]] \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
    if [[ "$same_revision_topology" == router ]]; then
      development_router_live_uncommitted="true"
      reload_release_router_live active \
        || fail "same-revision development finalization could not restore active live routing"
      release_acceptance_token=""
    fi
    if [[ "$require_public_acceptance" == true ]]; then
      run_public_acceptance || fail "same-revision development public acceptance failed twice"
      verify_external_edge_if_selected "$candidate_revision" live-uncommitted
    fi
    release_is_accepted "$candidate_revision" \
      || fail "same-revision development finalization did not pass active-routing acceptance"
    if [[ "$same_revision_topology" == router ]]; then
      commit_release_router_acceptance "$candidate_revision" "$accepted_revision" \
        || fail "same-revision development finalization could not commit active routing"
      development_router_live_uncommitted="false"
    else
      write_accepted_revision "$candidate_revision"
    fi
    printf 'Development already runs accepted dev revision %s.\n' "$candidate_revision"
    exit 0
  fi
  printf 'Development revision %s is checked out but not yet accepted; completing its installation.\n' \
    "$candidate_revision"
fi

mutated=false
deployment_stage=prepare
cleanup() {
  local status="$?" cleanup_complete
  trap - EXIT INT TERM
  set +e
  if [[ "$status" != 0 && "$mutated" == true ]]; then
    if [[ -n "$accepted_revision" && "$accepted_revision" != "$candidate_revision" ]] \
      && restore_accepted_revision "$candidate_revision" "$accepted_revision" \
      && write_accepted_revision "$accepted_revision"; then
      cleanup_complete=true
      remove_revision_artifacts "$candidate_revision" || cleanup_complete=false
      bound_build_cache || cleanup_complete=false
      write_failure_state "$quarantine_file" quarantine "$accepted_revision" \
        "$candidate_revision" "$deployment_stage" "$accepted_revision" "$cleanup_complete"
      rm -f -- "$legacy_failure_latch" "$hard_failure_latch"
      sync -f -- "$state_directory"
      printf 'Development candidate %s failed during %s; restored accepted revision %s and quarantined the candidate (cleanupComplete=%s).\n' \
        "$candidate_revision" "$deployment_stage" "$accepted_revision" "$cleanup_complete" >&2
      exit 0
    fi
    if ! contain_development_router_on_failure; then
      printf 'URGENT: development failure could not prove stable-router maintenance; inspect the stopped/ambiguous router before recovery.\n' >&2
    fi
    write_failure_state "$hard_failure_latch" hard "${accepted_revision:-$source_revision}" \
      "$candidate_revision" "$deployment_stage" "" false
    printf 'Development candidate %s failed during %s and recovery could not be verified; hard failure state recorded and candidate artifacts retained.\n' \
      "$candidate_revision" "$deployment_stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

source_topology="$(revision_release_topology "$source_revision")" \
  || fail "accepted source release topology could not be classified"
mutated=true
deployment_stage=checkout
git_as_deploy merge --ff-only "$candidate_revision"
checked_out_revision="$(git_as_deploy rev-parse HEAD)" \
  || fail "the post-merge development revision could not be read"
repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" \
  || fail "the post-merge development checkout status could not be read"
[[ "$checked_out_revision" == "$candidate_revision" && -z "$repository_status" ]] \
  || fail "the development checkout did not move cleanly to the candidate"
replace_environment_revision "$source_revision" "$candidate_revision" \
  || fail "could not atomically select the candidate image revision"

candidate_topology="$(revision_release_topology "$candidate_revision")" \
  || fail "candidate release topology could not be classified"
verify_compose_boundary "$candidate_revision"
deployment_stage=build
if [[ "$candidate_topology" == router ]]; then
  allow_router_build=false
  [[ "$source_topology" == legacy || "$initial_development_bootstrap" == true ]] \
    && allow_router_build=true
  ensure_release_router_image "$allow_router_build" \
    || fail "the stable release-router image is missing or differs from its canonical contract"
  compose build \
    database provision_auth_worker_role migrate reconcile_runtime_grants \
    reconcile_auth_worker_grants reconcile_backup_grants verify_database_contract \
    bootstrap_demo app auth_email_worker release_acceptance

  deployment_stage=enter-maintenance
  release_acceptance_token="$(openssl rand -hex 32)" \
    || fail "development release-acceptance token could not be generated"
  [[ "$release_acceptance_token" =~ ^[a-f0-9]{64}$ ]] \
    || fail "development release-acceptance token is invalid"
  if [[ "$source_topology" == legacy ]]; then
    # The legacy app owns port 3200 and the external alias. Stop it only after
    # every candidate image is ready, quarantine its exact stopped endpoint,
    # then create the stable router once.
    legacy_app_container="$(exact_legacy_development_app_container "$source_revision")" \
      || fail "the exact accepted legacy development app could not be identified"
    [[ "$(docker inspect --format '{{.State.Running}}' "$legacy_app_container")" == true ]] \
      || fail "the accepted legacy development app is not running before router bootstrap"
    network_alias_has_exact_owner \
      business_finlynq_development_edge development-app "$legacy_app_container" \
      || fail "the accepted legacy development alias does not have one exact owner"
    compose --profile auth-email stop --timeout 60 auth_email_worker app
    quarantine_legacy_development_app_alias "$source_revision" "$legacy_app_container" \
      || fail "the stopped legacy development alias could not be quarantined exactly"
    compose up --detach --wait --no-deps --no-build release_router
  elif [[ "$initial_development_bootstrap" == true ]]; then
    # A fresh router-aware installation has no accepted listener to preserve.
    # If an exact state volume remains without a container, force its durable
    # mode to maintenance before the first listener is allowed to start.
    if docker volume inspect "$release_router_state_volume" >/dev/null 2>&1; then
      persist_release_router_named_volume_mode maintenance \
        || fail "the fresh development release-router state could not be forced to maintenance"
    fi
    compose up --detach --wait --no-deps --no-build release_router
    persistent_release_router_id="$(running_release_router_container)" \
      || fail "the fresh development release router could not be identified"
    release_router_container_is_attested "$persistent_release_router_id" \
      || fail "the fresh development release router is not canonical"
  else
    # Ordinary releases keep the existing listener and image intact.
    release_router_runtime_is_accepted \
      || fail "the persistent development release router is not accepted"
    persistent_release_router_id="$(running_release_router_container)" \
      || fail "the persistent development release router could not be identified"
  fi
  reload_release_router maintenance \
    || fail "development release router could not enter maintenance atomically"
  wait_for_release_router_maintenance \
    || fail "development release router did not establish the reviewed maintenance contract"
  if [[ "$initial_development_bootstrap" == true ]]; then
    release_router_runtime_is_accepted \
      || fail "the fresh development release router is not accepted in maintenance"
    network_alias_has_exact_owner \
      business_finlynq_development_edge development-app "$persistent_release_router_id" \
      || fail "the fresh development public alias does not have one exact router owner"
    network_alias_has_no_owner \
      business_finlynq_development_private-frontend release-app \
      || fail "the fresh development private app alias unexpectedly has an owner"
  fi
  if [[ "$source_topology" == router && "$initial_development_bootstrap" != true ]]; then
    compose --profile auth-email stop --timeout 60 auth_email_worker app
  fi
else
  compose build \
    database provision_auth_worker_role migrate reconcile_runtime_grants \
    reconcile_auth_worker_grants reconcile_backup_grants verify_database_contract \
    bootstrap_demo app auth_email_worker release_acceptance
fi

deployment_stage=database-mutation-chain
run_candidate_database_chain "$candidate_revision" \
  || fail "development candidate database migration and grant chain failed"

deployment_stage=live-apply
compose up --detach --wait --no-deps --no-build evidence_scanner
compose up --detach --wait --no-deps --no-build app
if [[ "$source_topology" == router ]]; then
  [[ "$(running_release_router_container)" == "$persistent_release_router_id" ]] \
    || fail "ordinary development deployment replaced the persistent release router"
fi

# Compose detects client-ID and mount-path changes. A secret replaced at the
# same path can retain the old bind mount, so recreate only the app if needed.
document_app_container="$(compose ps --quiet app)" \
  || fail "the development app container could not be identified"
document_rendered="$(compose config --format json)" \
  || fail "the development Compose configuration could not be rendered after apply"
document_oidc_contract_expected=false
if revision_uses_oidc_runtime_contract "$candidate_revision"; then
  document_oidc_contract_expected=true
else
  document_oidc_contract_status="$?"
  [[ "$document_oidc_contract_status" == 1 ]] \
    || fail "the candidate OIDC runtime contract could not be classified"
fi
if ! document_provider_configuration_matches \
  "$document_app_container" "$document_rendered" "$document_oidc_contract_expected"; then
  compose up --detach --wait --no-deps --no-build --force-recreate app
fi

account_login_enabled="$(read_environment_value ACCOUNT_LOGIN_ENABLED)" \
  || fail "ACCOUNT_LOGIN_ENABLED could not be read"
[[ "$account_login_enabled" == true || "$account_login_enabled" == false ]] \
  || fail "ACCOUNT_LOGIN_ENABLED must be true or false"
if [[ "$account_login_enabled" == true ]]; then
  compose --profile auth-email up --detach --wait --no-deps --no-build auth_email_worker
else
  compose --profile auth-email rm --force --stop auth_email_worker >/dev/null 2>&1 || true
fi

require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
  || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
[[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]] \
  || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
if [[ "$require_public_acceptance" == true ]]; then
  deployment_stage=public-acceptance
  run_public_acceptance || fail "development public acceptance failed twice"
fi

deployment_stage=candidate-verification
release_is_accepted "$candidate_revision" \
  || fail "development candidate did not pass private acceptance"
if [[ "$candidate_topology" == router ]]; then
  deployment_stage=activate-routing
  development_router_live_uncommitted="true"
  reload_release_router_live active \
    || fail "development release router could not expose the verified candidate"
  release_acceptance_token=""
fi
if [[ "$require_public_acceptance" == true ]]; then
  deployment_stage=external-edge-verification
  verify_external_edge_if_selected "$candidate_revision" live-uncommitted
fi
deployment_stage=final-verification
release_is_accepted "$candidate_revision" \
  || fail "development deployment did not pass final acceptance"
if [[ "$candidate_topology" == router ]]; then
  deployment_stage=commit-active-routing
  commit_release_router_acceptance "$candidate_revision" "$accepted_revision" \
    || fail "development release router could not commit active routing durably"
  development_router_live_uncommitted="false"
else
  write_accepted_revision "$candidate_revision"
fi
accepted_revision="$candidate_revision"
rm -f -- "$legacy_failure_latch" "$hard_failure_latch" "$quarantine_file"
sync -f -- "$state_directory"
mutated=false
trap - EXIT INT TERM

if [[ "$source_revision" != "$candidate_revision" ]]; then
  remove_revision_artifacts "$source_revision" \
    || printf 'Warning: retired development revision %s could not be fully removed.\n' \
      "$source_revision" >&2
fi
bound_build_cache \
  || printf 'Warning: development build cache could not be bounded to %s.\n' \
    "$build_cache_limit" >&2
printf 'Development deployment accepted for dev revision %s.\n' "$candidate_revision"
