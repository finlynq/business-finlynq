#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly repository="/home/deploy/business-finlynq-development"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly compose_environment="/etc/business-finlynq-development/compose.env"
readonly project="business-finlynq-development"
readonly state_directory="/var/lib/business-finlynq-development"
readonly deployment_lock="$state_directory/deployment.lock"
readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly legacy_failure_latch="$state_directory/deployment-failed"
readonly quarantine_file="$state_directory/quarantined-candidate"
readonly hard_failure_latch="$state_directory/deployment-hard-failed"
readonly accepted_revision_file="$state_directory/accepted-revision"
readonly build_cache_limit="8GB"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'Business Finlynq development deployment refused: %s\n' "$*" >&2
  exit 1
}

validate_revision() {
  [[ "$1" =~ ^[a-f0-9]{40}$ && ! "$1" =~ ^0+$ ]] \
    || fail "revision must be a non-zero full 40-character Git SHA"
}

[[ "$(id -u)" == 0 ]] || fail "run this command as root"
for command_name in awk bash chmod chown curl date docker env flock git grep id install jq \
  mktemp mv readlink rm runuser sed sleep sort stat sync uniq; do
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
exec 8>"$host_deployment_lock"
chmod 0600 "$host_deployment_lock"
flock --exclusive --nonblock 8 || fail "another production or development deployment is active"

git_as_deploy() {
  runuser -u deploy -- /usr/bin/env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH="$clean_path" LC_ALL=C LANG=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git --no-optional-locks -c safe.directory="$repository" -c core.hooksPath=/dev/null \
      -C "$repository" "$@"
}

compose() {
  env -i PATH="$clean_path" docker compose \
    --project-name "$project" \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    -f "$repository/docker-compose.yml" "$@"
}

read_environment_value() {
  local key="$1" value
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' "$compose_environment")"
  [[ "$(grep -c "^${key}=" "$compose_environment")" == 1 ]] \
    || fail "development environment must define $key exactly once"
  printf '%s' "$value"
}

state_file_is_safe() {
  local target="$1"
  [[ -f "$target" && ! -L "$target" \
    && "$(stat -c '%U:%G:%a' -- "$target")" == root:root:600 ]]
}

read_state_value() {
  local target="$1" key="$2" value
  state_file_is_safe "$target" || fail "protected deployment state is unavailable or unsafe: $target"
  [[ "$(grep -c "^${key}=" "$target")" == 1 ]] \
    || fail "protected deployment state must define $key exactly once: $target"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' "$target")"
  [[ -n "$value" ]] || fail "protected deployment state contains an empty $key: $target"
  printf '%s' "$value"
}

write_accepted_revision() {
  local revision="$1" temporary
  validate_revision "$revision"
  temporary="$(mktemp "${accepted_revision_file}.XXXXXX")"
  printf 'revision=%s\nacceptedAt=%s\n' \
    "$revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$accepted_revision_file"
  sync -f -- "$state_directory"
}

write_failure_state() {
  local target="$1" kind="$2" source="$3" candidate="$4" stage="$5" recovered="$6" \
    cleanup_complete="$7" temporary
  validate_revision "$source"
  validate_revision "$candidate"
  [[ "$kind" == quarantine || "$kind" == hard ]] \
    || fail "invalid development failure-state kind"
  [[ "$cleanup_complete" == true || "$cleanup_complete" == false ]] \
    || fail "invalid development cleanup state"
  temporary="$(mktemp "${target}.XXXXXX")"
  printf 'kind=%s\nsourceRevision=%s\ncandidateRevision=%s\nstage=%s\nfailedAt=%s\nrecoveredRevision=%s\ncleanupComplete=%s\n' \
    "$kind" "$source" "$candidate" "$stage" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$recovered" "$cleanup_complete" >"$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$target"
  sync -f -- "$state_directory"
}

replace_environment_revision() {
  local old_revision="$1" new_revision="$2" current_revision temporary
  validate_revision "$old_revision"
  validate_revision "$new_revision"
  [[ -z "$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$compose_environment" | sort | uniq -d)" ]] \
    || return 1
  current_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)"
  if [[ "$current_revision" == "$new_revision" ]]; then
    return 0
  fi
  [[ "$current_revision" == "$old_revision" ]] || return 1
  temporary="$(mktemp "${compose_environment}.deployment.XXXXXX")"
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
  chown root:deploy "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$compose_environment"
  sync -f -- "$compose_environment"
}

revision_project_container_ids() {
  local revision="$1" container container_revision
  validate_revision "$revision"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    container_revision="$(docker inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null || true)"
    [[ "$container_revision" == "$revision" ]] && printf '%s\n' "$container"
  done < <(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project")
}

revision_is_used_outside_project() {
  local revision="$1" container container_project container_revision
  validate_revision "$revision"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    container_revision="$(docker inspect --format \
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container" 2>/dev/null || true)"
    [[ "$container_revision" == "$revision" ]] || continue
    container_project="$(docker inspect --format \
      '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null || true)"
    [[ "$container_project" == "$project" ]] || return 0
  done < <(docker ps --all --no-trunc --quiet)
  return 1
}

remove_revision_artifacts() {
  local revision="$1" reference image_revision
  local -a container_ids image_references
  validate_revision "$revision"
  mapfile -t container_ids < <(revision_project_container_ids "$revision")
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
    for reference in "${image_references[@]}"; do
      docker image inspect "$reference" >/dev/null 2>&1 || continue
      image_revision="$(docker image inspect --format \
        '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference")"
      [[ "$image_revision" == "$revision" ]] || return 1
      docker image rm -- "$reference" >/dev/null || return 1
    done
    docker image prune --force \
      --filter "label=org.opencontainers.image.revision=$revision" >/dev/null || return 1
  fi
  mapfile -t container_ids < <(revision_project_container_ids "$revision")
  (( ${#container_ids[@]} == 0 ))
}

bound_build_cache() {
  docker builder prune --force --max-used-space "$build_cache_limit" >/dev/null
}

wait_for_public_readiness() {
  local deadline hostname public_health
  hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)"
  [[ "$hostname" == dev.business.finlynq.com ]] \
    || fail "public acceptance requires the exact development hostname"
  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if public_health="$(curl --connect-timeout 2 --max-time 5 --fail --silent \
      "https://$hostname/api/health" 2>/dev/null)" \
      && jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
        <<<"$public_health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  fail "public development route did not become ready before browser acceptance"
}

[[ "$(git_as_deploy rev-parse --show-toplevel)" == "$repository" ]] \
  || fail "the canonical development repository root changed"
[[ "$(git_as_deploy symbolic-ref --short HEAD)" == dev ]] \
  || fail "the development checkout is not on dev"
[[ "$(git_as_deploy remote get-url origin)" == "$expected_origin" ]] \
  || fail "the development origin is not the reviewed repository"
[[ -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the development checkout is not clean"

git_as_deploy fetch --prune --force --no-tags origin \
  '+refs/heads/dev:refs/remotes/origin/dev' \
  '+refs/tags/deploy-development-*:refs/tags/deploy-development-*'

source_revision="$(git_as_deploy rev-parse HEAD)"
candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/dev)"
validate_revision "$source_revision"
validate_revision "$candidate_revision"
git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision" \
  || fail "origin/dev is not a fast-forward descendant of the deployed revision"

signal_tag="deploy-development-$candidate_revision"
signal_revision="$(git_as_deploy rev-parse "refs/tags/$signal_tag^{commit}" 2>/dev/null || true)"
[[ "$signal_revision" == "$candidate_revision" ]] \
  || fail "the successful quality gate has not published the immutable development deployment signal"

expected_resources=(
  "business_finlynq_development_pgdata"
  "business_finlynq_development_private"
  "business_finlynq_development_egress"
  "business_finlynq_development_edge"
)

verify_compose_boundary() {
  local rendered resource expected found app_port app_origin app_alias
  rendered="$(compose config --format json)" \
    || fail "development Compose configuration could not be rendered"
  app_port="$(jq -r '.services.app.ports[0].published' <<<"$rendered")"
  app_origin="$(jq -r '.services.app.environment.APP_ORIGIN' <<<"$rendered")"
  app_alias="$(jq -r '.services.app.networks.business_finlynq_edge.aliases[0]' <<<"$rendered")"
  [[ "$app_port" == 3200 ]] || fail "development app must bind loopback port 3200"
  [[ "$app_origin" == https://dev.business.finlynq.com ]] \
    || fail "development APP_ORIGIN must use the exact HTTPS development hostname"
  [[ "$app_alias" == development-app ]] \
    || fail "development app must expose only its dedicated edge alias"
  mapfile -t found_resources < <(jq -r '.volumes[].name, .networks[].name' <<<"$rendered" | sort -u)
  for expected in "${expected_resources[@]}"; do
    printf '%s\n' "${found_resources[@]}" | grep -Fxq "$expected" \
      || fail "development resource is not isolated: $expected"
  done
  for resource in "${found_resources[@]}"; do
    [[ "$resource" == business_finlynq_development_* ]] \
      || fail "development Compose references a non-development resource: $resource"
  done
}

release_is_accepted() {
  local expected_revision="$1" app_container app_environment actual expected detailed_health \
    public_health rendered hostname require_public setting
  local -a app_containers
  validate_revision "$expected_revision"
  mapfile -t app_containers < <(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=app)
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  [[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$app_container")" == "$expected_revision" ]] || return 1
  rendered="$(compose config --format json)" || return 1
  app_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_container")" || return 1
  for setting in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED \
    ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED AUTH_EMAIL_PROVIDER AUTH_EMAIL_FROM \
    AUTH_EMAIL_REPLY_TO SIGNUP_TURNSTILE_ENABLED SIGNUP_TURNSTILE_SITE_KEY \
    BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED; do
    expected="$(jq -r --arg setting "$setting" \
      '.services.app.environment[$setting] // ""' <<<"$rendered")"
    actual="$(awk -F= -v setting="$setting" \
      '$1 == setting { sub(/^[^=]*=/, ""); print; exit }' <<<"$app_environment")"
    [[ "$actual" == "$expected" ]] || return 1
  done
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3200/api/health)" \
    || return 1
  jq -e --arg revision "$expected_revision" \
    '.status == "ready" and .revision == $revision' <<<"$detailed_health" >/dev/null \
    || return 1
  require_public="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)"
  [[ "$require_public" == true || "$require_public" == false ]] || return 1
  if [[ "$require_public" == true ]]; then
    hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)"
    [[ "$hostname" == dev.business.finlynq.com ]] || return 1
    public_health="$(curl --fail --silent --show-error --max-time 30 \
      "https://$hostname/api/health")" || return 1
    jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
      <<<"$public_health" >/dev/null || return 1
  fi
}

start_revision_runtime() {
  compose up --detach --wait --no-deps --no-build database || return 1
  compose up --detach --wait --no-deps --no-build app || return 1
  if [[ "$(read_environment_value ACCOUNT_LOGIN_ENABLED)" == true ]]; then
    compose --profile auth-email up --detach --wait --no-deps --no-build auth_email_worker \
      || return 1
  else
    compose --profile auth-email rm --force --stop auth_email_worker >/dev/null 2>&1 || true
  fi
}

restore_accepted_revision() {
  local failed_revision="$1" recovery_revision="$2" current_head current_environment_revision
  validate_revision "$failed_revision"
  validate_revision "$recovery_revision"
  [[ "$failed_revision" != "$recovery_revision" ]] || return 1
  git_as_deploy merge-base --is-ancestor "$recovery_revision" "$failed_revision" || return 1

  current_head="$(git_as_deploy rev-parse HEAD)" || return 1
  if [[ "$current_head" == "$failed_revision" ]]; then
    git_as_deploy reset --hard "$recovery_revision" >/dev/null || return 1
  elif [[ "$current_head" != "$recovery_revision" ]]; then
    return 1
  fi
  [[ -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] || return 1

  current_environment_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)"
  if [[ "$current_environment_revision" == "$failed_revision" ]]; then
    replace_environment_revision "$failed_revision" "$recovery_revision" || return 1
  elif [[ "$current_environment_revision" != "$recovery_revision" ]]; then
    return 1
  fi

  ( verify_compose_boundary ) || return 1
  start_revision_runtime || return 1
  ( release_is_accepted "$recovery_revision" )
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

verify_compose_boundary

if [[ -e "$hard_failure_latch" || -L "$hard_failure_latch" ]]; then
  [[ "$(read_state_value "$hard_failure_latch" kind)" == hard ]] \
    || fail "the protected hard-failure state has an invalid kind"
  hard_candidate="$(read_state_value "$hard_failure_latch" candidateRevision)"
  validate_revision "$hard_candidate"
  fail "development recovery could not be verified for $hard_candidate; inspect it and clear the exact hard failure explicitly"
fi

if [[ -e "$legacy_failure_latch" || -L "$legacy_failure_latch" ]]; then
  legacy_source="$(read_state_value "$legacy_failure_latch" sourceRevision)"
  legacy_candidate="$(read_state_value "$legacy_failure_latch" candidateRevision)"
  validate_revision "$legacy_source"
  validate_revision "$legacy_candidate"
  if [[ "$legacy_candidate" == "$source_revision" ]] \
    && release_is_accepted "$source_revision"; then
    write_accepted_revision "$source_revision"
    rm -- "$legacy_failure_latch"
    sync -f -- "$state_directory"
    printf 'Migrated the legacy failure latch after verifying live revision %s.\n' \
      "$source_revision"
  else
    write_failure_state "$hard_failure_latch" hard "$legacy_source" "$legacy_candidate" \
      legacy-failure-latch "" false
    rm -- "$legacy_failure_latch"
    sync -f -- "$state_directory"
    fail "legacy failed deployment could not be verified as the live revision; hard recovery state recorded"
  fi
fi

accepted_revision=""
if [[ -e "$accepted_revision_file" || -L "$accepted_revision_file" ]]; then
  accepted_revision="$(read_state_value "$accepted_revision_file" revision)"
  validate_revision "$accepted_revision"
  git_as_deploy merge-base --is-ancestor "$accepted_revision" "$candidate_revision" \
    || fail "the accepted development revision is not an ancestor of the candidate"
fi

if [[ -z "$accepted_revision" ]]; then
  if release_is_accepted "$source_revision"; then
    write_accepted_revision "$source_revision"
    accepted_revision="$source_revision"
  else
    mapfile -t existing_app_containers < <(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=app)
    if [[ "$source_revision" != "$candidate_revision" || ${#existing_app_containers[@]} != 0 ]]; then
      write_failure_state "$hard_failure_latch" hard "$source_revision" "$candidate_revision" \
        accepted-state-initialization "" false
      fail "no verified accepted revision is available for automatic recovery"
    fi
    printf 'No prior development runtime exists; installing initial revision %s.\n' \
      "$candidate_revision"
  fi
elif [[ "$source_revision" != "$accepted_revision" ]]; then
  if release_is_accepted "$source_revision"; then
    write_accepted_revision "$source_revision"
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

if [[ -e "$quarantine_file" || -L "$quarantine_file" ]]; then
  [[ "$(read_state_value "$quarantine_file" kind)" == quarantine ]] \
    || fail "the protected quarantine state has an invalid kind"
  quarantined_source="$(read_state_value "$quarantine_file" sourceRevision)"
  quarantined_candidate="$(read_state_value "$quarantine_file" candidateRevision)"
  quarantined_stage="$(read_state_value "$quarantine_file" stage)"
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
  if release_is_accepted "$candidate_revision"; then
    write_accepted_revision "$candidate_revision"
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
      && restore_accepted_revision "$candidate_revision" "$accepted_revision"; then
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
    write_failure_state "$hard_failure_latch" hard "${accepted_revision:-$source_revision}" \
      "$candidate_revision" "$deployment_stage" "" false
    printf 'Development candidate %s failed during %s and recovery could not be verified; hard failure state recorded and candidate artifacts retained.\n' \
      "$candidate_revision" "$deployment_stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

mutated=true
deployment_stage=checkout
git_as_deploy merge --ff-only "$candidate_revision"
[[ "$(git_as_deploy rev-parse HEAD)" == "$candidate_revision" \
  && -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the development checkout did not move cleanly to the candidate"
replace_environment_revision "$source_revision" "$candidate_revision" \
  || fail "could not atomically select the candidate image revision"

verify_compose_boundary
deployment_stage=build
compose build \
  database provision_auth_worker_role migrate reconcile_runtime_grants \
  reconcile_auth_worker_grants reconcile_backup_grants verify_database_contract \
  bootstrap_demo app auth_email_worker release_acceptance

deployment_stage=live-apply
compose up --detach --wait --no-build app

if [[ "$(read_environment_value ACCOUNT_LOGIN_ENABLED)" == true ]]; then
  compose --profile auth-email up --detach --wait --no-deps --no-build auth_email_worker
else
  compose --profile auth-email rm --force --stop auth_email_worker >/dev/null 2>&1 || true
fi

if [[ "$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" == true ]]; then
  deployment_stage=public-acceptance
  run_public_acceptance || fail "development public acceptance failed twice"
fi

deployment_stage=final-verification
release_is_accepted "$candidate_revision" \
  || fail "development deployment did not pass final acceptance"
write_accepted_revision "$candidate_revision"
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
