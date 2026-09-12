#!/usr/bin/bash
set -Eeuo pipefail
set +x

umask 077

readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly service="business-finlynq-development-deployment.service"
readonly configuration_directory="/etc/business-finlynq-development"
readonly compose_environment="$configuration_directory/compose.env"
readonly state_directory="/var/lib/business-finlynq-development"
readonly accepted_revision_file="$state_directory/accepted-revision"
readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly repository="/home/deploy/business-finlynq-stage"
readonly finalization_verifier="/usr/local/sbin/business-finlynq-verify-development-finalized"
readonly external_edge_verifier="/usr/local/libexec/business-finlynq/verify-external-edge.sh"
readonly project="business-finlynq-development"

PATH="$clean_path"
export PATH

fail() {
  printf 'Business Finlynq development finalization verification failed: %s\n' "$*" >&2
  exit 1
}

docker() {
  env -i PATH="$clean_path" docker "$@"
}

git_as_deploy() {
  runuser -u deploy -- env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH="$clean_path" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -C "$repository" "$@"
}

safe_directory() {
  local target="$1" expected_metadata="$2"
  [[ -d "$target" && ! -L "$target" \
    && "$(readlink -f -- "$target")" == "$target" \
    && "$(stat -c '%U:%G:%a' -- "$target")" == "$expected_metadata" ]]
}

safe_regular_file() {
  local target="$1" expected_metadata="$2"
  [[ -f "$target" && ! -L "$target" \
    && "$(readlink -f -- "$target")" == "$target" \
    && "$(stat -c '%U:%G:%a:%h' -- "$target")" == "$expected_metadata:1" ]]
}

read_exact_value() {
  local target="$1" key="$2" count value
  count="$(awk -F= -v selected="$key" \
    '$1 == selected { count++ } END { print count + 0 }' "$target")" \
    || fail "could not count $key in $target"
  [[ "$count" == 1 ]] || fail "$target must define $key exactly once"
  value="$(awk -F= -v selected="$key" \
    '$1 == selected { sub(/^[^=]*=/, ""); print }' "$target")" \
    || fail "could not read $key from $target"
  [[ -n "$value" ]] || fail "$target contains an empty $key"
  printf '%s' "$value"
}

verify_opened_deployment_lock() {
  local descriptor_path path_identity descriptor_identity path_contract descriptor_contract
  descriptor_path="/proc/$$/fd/$deployment_lock_fd"
  [[ -f "$host_deployment_lock" && ! -L "$host_deployment_lock" \
    && "$(readlink -f -- "$host_deployment_lock")" == "$host_deployment_lock" \
    && -e "$descriptor_path" \
    && "$(readlink -f -- "$descriptor_path")" == "$host_deployment_lock" ]] \
    || fail "the opened deployment lock differs from its protected path"
  path_identity="$(stat -Lc '%d:%i' -- "$host_deployment_lock")" \
    || fail "the deployment-lock path identity is unavailable"
  descriptor_identity="$(stat -Lc '%d:%i' -- "$descriptor_path")" \
    || fail "the deployment-lock descriptor identity is unavailable"
  [[ "$path_identity" == "$descriptor_identity" ]] \
    || fail "the deployment-lock descriptor identity differs from its protected path"
  path_contract="$(stat -Lc '%u:%g:%a:%h' -- "$host_deployment_lock")" \
    || fail "the deployment-lock path metadata is unavailable"
  descriptor_contract="$(stat -Lc '%u:%g:%a:%h' -- "$descriptor_path")" \
    || fail "the deployment-lock descriptor metadata is unavailable"
  [[ "$path_contract" == "$descriptor_contract" \
    && "$path_contract" == "0:$deploy_gid:660:1" ]] \
    || fail "the deployment-lock descriptor does not retain the protected contract"
}

verify_installed_blob() {
  local installed_path="$1" repository_path="$2" expected_oid observed_oid
  expected_oid="$(git_as_deploy rev-parse "$accepted_revision:$repository_path")" \
    || fail "the accepted $repository_path Git blob is unavailable"
  observed_oid="$(env -i PATH="$clean_path" git hash-object -- "$installed_path")" \
    || fail "the installed $repository_path blob could not be hashed"
  [[ "$expected_oid" =~ ^[a-f0-9]{40}$ && "$observed_oid" == "$expected_oid" ]] \
    || fail "the installed $repository_path does not match the accepted revision"
}

single_running_container() {
  local service_name="$1" result
  local -a containers=()
  mapfile -t containers < <(
    docker ps --no-trunc \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service_name" \
      --format '{{.ID}}'
  )
  [[ "${#containers[@]}" == 1 ]] \
    || fail "$project must have exactly one running $service_name container"
  result="${containers[0]}"
  [[ "$result" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$project returned an invalid $service_name container ID"
  printf '%s' "$result"
}

verify_runtime_revision() {
  local container="$1" service_name="$2" expected_image="$3" require_health="$4"
  local running health revision image tagged_image_id container_image_id
  running="$(docker inspect --format '{{.State.Running}}' "$container")" \
    || fail "$service_name running state could not be inspected"
  [[ "$running" == true ]] || fail "$service_name is not running"
  if [[ "$require_health" == true ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$container")" || fail "$service_name health could not be inspected"
    [[ "$health" == healthy ]] || fail "$service_name is not healthy"
  fi
  revision="$(docker inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")" \
    || fail "$service_name revision label could not be inspected"
  [[ "$revision" == "$accepted_revision" ]] \
    || fail "$service_name does not identify the accepted revision"
  image="$(docker inspect --format '{{.Config.Image}}' "$container")" \
    || fail "$service_name image could not be inspected"
  [[ "$image" == "$expected_image:$accepted_revision" ]] \
    || fail "$service_name does not use the accepted immutable image tag"
  tagged_image_id="$(docker image inspect --format '{{.Id}}' "$image")" \
    || fail "$service_name tagged image ID could not be inspected"
  container_image_id="$(docker inspect --format '{{.Image}}' "$container")" \
    || fail "$service_name container image ID could not be inspected"
  [[ "$tagged_image_id" =~ ^sha256:[a-f0-9]{64}$ \
    && "$container_image_id" == "$tagged_image_id" ]] \
    || fail "$service_name does not run the exact accepted tagged image"
}

(( $# == 0 )) || fail "this command accepts no arguments"
[[ "$(id -u)" == 0 ]] || fail "run this verifier as root"
[[ "$(readlink -f -- "$0")" == "$finalization_verifier" ]] \
  || fail "run the installed root-owned verifier"
for command_name in awk bash docker env flock git id readlink runuser stat systemctl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
deploy_gid="$(id -g deploy 2>/dev/null)" \
  || fail "the deploy group identity is unavailable"
readonly deploy_gid
[[ "$deploy_gid" =~ ^[0-9]+$ ]] || fail "the deploy group identity is invalid"

safe_directory "$configuration_directory" root:deploy:750 \
  || fail "the development configuration directory is unsafe"
safe_directory "$state_directory" root:root:700 \
  || fail "the development state directory is unsafe"
safe_regular_file "$compose_environment" root:deploy:600 \
  || fail "the development Compose environment is unsafe"
safe_regular_file "$accepted_revision_file" root:root:600 \
  || fail "the accepted-revision state is unsafe"
safe_regular_file "$host_deployment_lock" root:deploy:660 \
  || fail "the shared deployment lock is unsafe"
safe_regular_file "$finalization_verifier" root:root:550 \
  || fail "the installed finalization verifier is unsafe"
safe_regular_file "$external_edge_verifier" root:root:550 \
  || fail "the installed external-edge verifier is unsafe"

exec {deployment_lock_fd}<>"$host_deployment_lock" \
  || fail "the shared deployment lock could not be opened"
verify_opened_deployment_lock
flock --exclusive --nonblock "$deployment_lock_fd" \
  || fail "a Business Finlynq deployment is in progress"
verify_opened_deployment_lock

[[ "$(systemctl show "$service" --property=ActiveState --value)" == inactive ]] \
  || fail "the development deployment service is not inactive"
[[ "$(systemctl show "$service" --property=SubState --value)" == dead ]] \
  || fail "the development deployment service has not stopped cleanly"
[[ "$(systemctl show "$service" --property=Result --value)" == success ]] \
  || fail "the development deployment service result is not successful"
[[ "$(systemctl show "$service" --property=ExecMainStatus --value)" == 0 ]] \
  || fail "the development deployment service exit status is not zero"

accepted_revision="$(read_exact_value "$accepted_revision_file" revision)"
readonly accepted_revision
[[ "$accepted_revision" =~ ^[a-f0-9]{40}$ && ! "$accepted_revision" =~ ^0+$ ]] \
  || fail "the accepted revision is invalid"
verify_installed_blob \
  "$finalization_verifier" deploy/development/verify-development-finalized.sh
verify_installed_blob \
  "$external_edge_verifier" deploy/edge/verify-external-edge.sh
compose_revision="$(read_exact_value "$compose_environment" BUSINESS_FINLYNQ_IMAGE_REVISION)"
[[ "$compose_revision" == "$accepted_revision" ]] \
  || fail "the Compose environment does not identify the accepted revision"

for failure_state in deployment-failed deployment-hard-failed quarantined-candidate; do
  target="$state_directory/$failure_state"
  [[ ! -e "$target" && ! -L "$target" ]] \
    || fail "a development deployment failure state is present: $failure_state"
done

router_container="$(single_running_container release_router)"
router_health="$(docker inspect --format \
  '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$router_container")" \
  || fail "the development release-router health could not be inspected"
[[ "$router_health" == healthy ]] || fail "the development release router is not healthy"
router_mode="$(docker exec "$router_container" sh -ec 'cat /state/mode')" \
  || fail "the development release-router durable mode could not be read"
[[ "$router_mode" == active ]] || fail "the development release router is not durably active"

app_container="$(single_running_container app)"
verify_runtime_revision "$app_container" app business-finlynq-app true
worker_container="$(single_running_container auth_email_worker)"
verify_runtime_revision \
  "$worker_container" auth_email_worker business-finlynq-auth-worker false

env -i PATH="$clean_path" bash "$external_edge_verifier" \
  --scope development \
  --warmup-host development

printf 'FINALIZED revision=%s\n' "$accepted_revision"
