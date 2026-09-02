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
readonly failure_latch="$state_directory/deployment-failed"
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
  mktemp mv readlink rm runuser sed sort stat sync uniq; do
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
  [[ -f "$failure_latch" && ! -L "$failure_latch" ]] \
    || fail "the protected failure latch is unavailable"
  grep -Fxq "candidateRevision=$2" "$failure_latch" \
    || fail "the failure latch does not identify the acknowledged revision"
  rm -- "$failure_latch"
  sync -f -- "$state_directory"
  printf 'Development deployment failure latch cleared for %s.\n' "$2"
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

[[ ! -e "$failure_latch" && ! -L "$failure_latch" ]] \
  || fail "a previous development deployment failed; inspect it and clear the protected latch explicitly"

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
  local app_container detailed_health public_health hostname require_public
  local -a app_containers
  mapfile -t app_containers < <(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project="$project" \
    --filter label=com.docker.compose.service=app)
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  [[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$app_container")" == "$candidate_revision" ]] || return 1
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3200/api/health)" \
    || return 1
  jq -e --arg revision "$candidate_revision" \
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

verify_compose_boundary
if [[ "$source_revision" == "$candidate_revision" ]]; then
  if release_is_accepted; then
    printf 'Development already runs accepted dev revision %s.\n' "$candidate_revision"
    exit 0
  fi
  printf 'Development revision %s is checked out but not yet accepted; completing its installation.\n' \
    "$candidate_revision"
fi

temporary_environment="$(mktemp "${compose_environment}.deployment.XXXXXX")"
mutated=false
cleanup() {
  local status="$?" latch_temporary
  [[ -z "$temporary_environment" ]] || rm -f -- "$temporary_environment"
  if [[ "$status" != 0 && "$mutated" == true ]]; then
    latch_temporary="$(mktemp "${failure_latch}.XXXXXX")"
    printf 'sourceRevision=%s\ncandidateRevision=%s\nfailedAt=%s\n' \
      "$source_revision" "$candidate_revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$latch_temporary"
    chmod 0600 "$latch_temporary"
    chown root:root "$latch_temporary"
    mv -f -- "$latch_temporary" "$failure_latch"
    sync -f -- "$state_directory"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

[[ "$(grep -Fxc "BUSINESS_FINLYNQ_IMAGE_REVISION=$source_revision" "$compose_environment")" == 1 ]] \
  || fail "development environment does not identify the checked-out source revision"
[[ -z "$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$compose_environment" | sort | uniq -d)" ]] \
  || fail "development environment contains duplicate keys"
awk -v old="$source_revision" -v new="$candidate_revision" '
  $0 == "BUSINESS_FINLYNQ_IMAGE_REVISION=" old {
    print "BUSINESS_FINLYNQ_IMAGE_REVISION=" new
    count++
    next
  }
  { print }
  END { if (count != 1) exit 42 }
' "$compose_environment" >"$temporary_environment" \
  || fail "could not prepare the development revision environment"
chown root:deploy "$temporary_environment"
chmod 0600 "$temporary_environment"

mutated=true
git_as_deploy merge --ff-only "$candidate_revision"
[[ "$(git_as_deploy rev-parse HEAD)" == "$candidate_revision" \
  && -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the development checkout did not move cleanly to the candidate"
mv -f -- "$temporary_environment" "$compose_environment"
temporary_environment=""
sync -f -- "$compose_environment"

verify_compose_boundary
compose build \
  database provision_auth_worker_role migrate reconcile_runtime_grants \
  reconcile_auth_worker_grants reconcile_backup_grants verify_database_contract \
  bootstrap_demo app auth_email_worker release_acceptance
compose up --detach --wait --no-build app

if [[ "$(read_environment_value ACCOUNT_LOGIN_ENABLED)" == true ]]; then
  compose --profile auth-email up --detach --wait --no-deps --no-build auth_email_worker
else
  compose --profile auth-email rm --force --stop auth_email_worker >/dev/null 2>&1 || true
fi

if [[ "$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" == true ]]; then
  compose --profile acceptance run --rm --no-deps release_acceptance
fi

release_is_accepted || fail "development deployment did not pass final acceptance"
rm -f -- "$failure_latch"
mutated=false
trap - EXIT INT TERM
printf 'Development deployment accepted for dev revision %s.\n' "$candidate_revision"
