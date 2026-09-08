#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repository="/home/deploy/business-finlynq"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly configuration_directory="/etc/business-finlynq"
readonly secret_directory="$configuration_directory/secrets"
readonly backup_configuration_directory="$configuration_directory/backup"
readonly recovery_directory="$configuration_directory/recovery"
readonly edge_directory="$configuration_directory/edge"
readonly edge_contract="$edge_directory/edge-contract.env"
readonly edge_route="$edge_directory/business-finlynq-routes.caddy"
readonly compose_environment="$configuration_directory/compose.env"
readonly operations_environment="$configuration_directory/operations.env"
readonly repository_environment="$repository/.env"
readonly placeholder="$secret_directory/not-configured"
readonly recipient_target="$backup_configuration_directory/age-recipients.txt"
readonly state_directory="/var/lib/business-finlynq"
readonly release_evidence_root="$state_directory/release-evidence"
readonly rehearsal_configuration_directory="$configuration_directory/rehearsals"
readonly rehearsal_acceptance="$rehearsal_configuration_directory/accepted.json"
readonly rehearsal_evidence_root="$state_directory/rehearsal-evidence"
readonly backup_directory="/var/backups/business-finlynq"
readonly host_lock="$state_directory/deployment-host.lock"
readonly install_state="$configuration_directory/initial-install-state.json"
readonly preparation_state="$configuration_directory/initial-preparation.json"
readonly install_completion="$configuration_directory/initial-install-complete.json"
readonly pristine_retry_root="$state_directory/initial-pristine-retries"
readonly production_network="business_finlynq_edge"
readonly external_edge_verifier_source="$repository/deploy/edge/verify-external-edge.sh"
readonly external_edge_verifier_route_source="$repository/deploy/edge/Caddyfile.business-external"
readonly external_edge_verifier_root="/usr/local/libexec/business-finlynq"
readonly external_edge_verifier_directory="$external_edge_verifier_root/deploy/edge"
readonly external_edge_verifier_target="$external_edge_verifier_directory/verify-external-edge.sh"
readonly external_edge_verifier_route_target="$external_edge_verifier_directory/Caddyfile.business-external"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'Business Finlynq initial production installation failed: %s\n' "$*" >&2
  exit 1
}

checked_utc_timestamp() {
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || return 1
  printf '%s' "$timestamp"
}

checked_compact_utc_timestamp() {
  local timestamp
  timestamp="$(date -u +%Y%m%d%H%M%S)" || return 1
  [[ "$timestamp" =~ ^[0-9]{14}$ ]] || return 1
  printf '%s' "$timestamp"
}

checked_file_sha256() {
  local selected_file="$1" checksum_output digest remainder
  checksum_output="$(sha256sum -- "$selected_file")" || return 1
  read -r digest remainder <<<"$checksum_output" || return 1
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] || return 1
  printf '%s' "$digest"
}

checked_random_hex_32() {
  local value
  value="$(openssl rand -hex 32)" || return 1
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s' "$value"
}

# Installation is always local-host work. Ignore ambient Docker contexts,
# remote-daemon variables, Compose file/profile overrides, and user config.
docker() {
  env -i PATH="$clean_path" docker "$@"
}

revision=""
recipient_input=""
edge_contract_input=""
prepare_edge_network_only="false"
prepare_configuration_only="false"
run_provisioned="false"
resume_run_id=""
finalize_run_id=""
pristine_retry_run_id=""
production_owner_password=""
first_owner_password=""
second_owner_password=""
while (( $# > 0 )); do
  case "$1" in
    --revision|--backup-age-recipient-file|--external-edge-contract-file|--resume-initial|--finalize-accepted-initial|--retry-pristine-initial)
      (( $# >= 2 )) || fail "$1 requires a value"
      case "$1" in
        --revision) revision="$2" ;;
        --backup-age-recipient-file) recipient_input="$2" ;;
        --external-edge-contract-file) edge_contract_input="$2" ;;
        --resume-initial) resume_run_id="$2" ;;
        --finalize-accepted-initial) finalize_run_id="$2" ;;
        --retry-pristine-initial) pristine_retry_run_id="$2" ;;
      esac
      shift 2
      ;;
    --prepare-edge-network-only)
      prepare_edge_network_only="true"
      shift
      ;;
    --prepare-configuration-only)
      prepare_configuration_only="true"
      shift
      ;;
    --run-provisioned)
      run_provisioned="true"
      shift
      ;;
    --help|-h)
      printf '%s\n' \
        'Usage: install-initial-production.sh --revision <full-sha> --prepare-edge-network-only' \
        '   or: install-initial-production.sh --revision <full-sha> --prepare-configuration-only --backup-age-recipient-file <public-recipient-file> --external-edge-contract-file <root-managed-contract>' \
        '   or: install-initial-production.sh --revision <full-sha> --run-provisioned' \
        '   or: install-initial-production.sh --revision <full-sha> --retry-pristine-initial <failed-run-id>' \
        '   or: install-initial-production.sh --revision <full-sha> --resume-initial <failed-run-id>' \
        '   or: install-initial-production.sh --revision <full-sha> --finalize-accepted-initial <accepted-run-id>'
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" == 0 ]] || fail "run this installer as root"
[[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] \
  || fail "--revision must be a non-zero full 40-character Git SHA"
mode_count=0
[[ "$prepare_edge_network_only" == true ]] && (( mode_count += 1 ))
[[ "$prepare_configuration_only" == true ]] && (( mode_count += 1 ))
[[ "$run_provisioned" == true ]] && (( mode_count += 1 ))
[[ -n "$pristine_retry_run_id" ]] && (( mode_count += 1 ))
[[ -n "$resume_run_id" ]] && (( mode_count += 1 ))
[[ -n "$finalize_run_id" ]] && (( mode_count += 1 ))
[[ "$mode_count" == 1 ]] \
  || fail "select exactly one network, configuration, provisioned-run, retry, resume, or finalize mode"
if [[ "$prepare_edge_network_only" == true ]]; then
  [[ -z "$recipient_input" && -z "$edge_contract_input" \
    && -z "$resume_run_id" && -z "$finalize_run_id" \
    && -z "$pristine_retry_run_id" ]] \
    || fail "edge-network-only mode accepts only --revision"
elif [[ "$prepare_configuration_only" == true ]]; then
  [[ -n "$recipient_input" && -n "$edge_contract_input" ]] \
    || fail "configuration mode requires the public recipient and external edge contract files"
elif [[ "$run_provisioned" == true ]]; then
  [[ -z "$recipient_input" && -z "$edge_contract_input" ]] \
    || fail "provisioned-run mode accepts no new input files"
elif [[ -n "$pristine_retry_run_id" ]]; then
  [[ -z "$recipient_input" && -z "$edge_contract_input" \
    && "$pristine_retry_run_id" =~ ^initial-[a-z0-9][a-z0-9._-]{2,22}$ ]] \
    || fail "pristine-retry mode requires one safe prior run ID and no new input files"
elif [[ -n "$resume_run_id" ]]; then
  [[ -z "$recipient_input" && -z "$edge_contract_input" \
    && "$resume_run_id" =~ ^initial-[a-z0-9][a-z0-9._-]{2,22}$ ]] \
    || fail "resume mode requires one safe prior run ID and no new input files"
elif [[ -n "$finalize_run_id" ]]; then
  [[ -z "$recipient_input" && -z "$edge_contract_input" \
    && "$finalize_run_id" =~ ^initial-[a-z0-9][a-z0-9._-]{2,22}$ ]] \
    || fail "finalize mode requires one safe accepted run ID and no new input files"
fi

for command_name in awk bash chmod chown cmp curl date df docker env find flock getent git grep id \
  install jq mktemp mv nproc openssl readlink rm runuser sha256sum sort stat sync \
  sleep systemctl timedatectl tr; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
compose_version="$(docker compose version --short 2>/dev/null)" \
  || fail "Docker Compose v2 is unavailable"
compose_version="${compose_version#v}"
[[ "$compose_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] \
  || fail "Docker Compose returned an unrecognized version"
compose_major="${BASH_REMATCH[1]}"
compose_minor="${BASH_REMATCH[2]}"
compose_patch="${BASH_REMATCH[3]}"
(( compose_major > 2 || (compose_major == 2 && \
  (compose_minor > 24 || (compose_minor == 24 && compose_patch >= 4))) )) \
  || fail "Docker Compose 2.24.4 or newer is required for fail-closed overlay tags"

getent passwd deploy >/dev/null || fail "the deploy account is unavailable"
getent group business-finlynq-secrets >/dev/null \
  || fail "the business-finlynq-secrets group is unavailable"
secret_gid="$(getent group business-finlynq-secrets | awk -F: '{print $3}')"
deploy_gid="$(id -g deploy)"
[[ "$secret_gid" =~ ^[0-9]+$ && "$deploy_gid" =~ ^[0-9]+$ ]] \
  || fail "required deployment group identities are invalid"

os_release_link="$(readlink -- /etc/os-release)" \
  || fail "host OS metadata must use the canonical Ubuntu symlink"
[[ "$os_release_link" == ../usr/lib/os-release ]] \
  || fail "host OS metadata does not use the canonical Ubuntu symlink target"
readonly os_release_target="/usr/lib/os-release"
os_release_owner="$(stat -c '%u:%g' -- "$os_release_target")" \
  || fail "canonical host OS metadata ownership could not be inspected"
os_release_mode="$(stat -c '%a' -- "$os_release_target")" \
  || fail "canonical host OS metadata mode could not be inspected"
[[ -f "$os_release_target" && ! -L "$os_release_target" \
  && "$os_release_owner" == 0:0 && "$os_release_mode" =~ ^[0-7]{3,4}$ ]] \
  || fail "canonical host OS metadata is unavailable or unsafe"
(( (8#$os_release_mode & 8#022) == 0 )) \
  || fail "canonical host OS metadata is group- or other-writable"
os_id="$(awk -F= '$1 == "ID" { gsub(/\"/, "", $2); print $2 }' \
  "$os_release_target")" || fail "host OS identity could not be read"
os_version="$(awk -F= '$1 == "VERSION_ID" { gsub(/\"/, "", $2); print $2 }' \
  "$os_release_target")" || fail "host OS version could not be read"
[[ "$os_id" == ubuntu && ( "$os_version" == 24.04 || "$os_version" == 26.04 ) ]] \
  || fail "initial production requires an explicitly supported Ubuntu 24.04 or 26.04 host"
[[ "$(timedatectl show --property=NTPSynchronized --value)" == yes ]] \
  || fail "host time synchronization is not confirmed"
(( $(nproc) >= 4 )) || fail "host requires at least four logical CPUs"
memory_kib="$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)"
[[ "$memory_kib" =~ ^[0-9]+$ && "$memory_kib" -ge 7500000 ]] \
  || fail "host requires at least approximately 8 GiB RAM"
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[[ "$docker_root" == /* && -d "$docker_root" ]] || fail "Docker root directory is unavailable"
available_bytes="$(df --output=avail -B1 "$docker_root" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
[[ "$available_bytes" =~ ^[0-9]+$ && "$available_bytes" -ge 32212254720 ]] \
  || fail "Docker storage requires at least 30 GiB available"

git_as_deploy() {
  runuser -u deploy -- /usr/bin/env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git --no-optional-locks -c safe.directory="$repository" -c core.hooksPath=/dev/null \
      -C "$repository" "$@"
}

[[ -d "$repository/.git" && ! -L "$repository" \
  && "$(stat -c '%U:%G' -- "$repository")" == deploy:deploy ]] \
  || fail "pre-cloned canonical production checkout is unavailable or unsafe"
repository_toplevel="$(git_as_deploy rev-parse --show-toplevel)" \
  || fail "canonical production checkout root could not be inspected"
repository_branch="$(git_as_deploy symbolic-ref --short HEAD)" \
  || fail "canonical production checkout branch could not be inspected"
repository_origin="$(git_as_deploy remote get-url origin)" \
  || fail "canonical production checkout origin could not be inspected"
repository_revision="$(git_as_deploy rev-parse HEAD)" \
  || fail "canonical production checkout revision could not be inspected"
repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" \
  || fail "canonical production checkout status could not be inspected"
[[ "$repository_toplevel" == "$repository" \
  && "$repository_branch" == main \
  && "$repository_origin" == "$expected_origin" \
  && "$repository_revision" == "$revision" \
  && -z "$repository_status" ]] \
  || fail "canonical production checkout, origin, branch, or revision is not exact"
tag_revision="$(git_as_deploy rev-parse \
  "refs/tags/deploy-production-$revision^{commit}" 2>/dev/null)" \
  || fail "the exact immutable production deployment tag could not be inspected"
[[ "$tag_revision" == "$revision" ]] \
  || fail "the exact immutable production deployment tag is unavailable"

install -d -o root -g deploy -m 0775 -- "$state_directory"
[[ "$(stat -c '%U:%G:%a' -- "$state_directory")" == root:deploy:775 ]] \
  || fail "shared deployment state directory is not root:deploy mode 0775"
[[ ! -L "$host_lock" ]] || fail "shared deployment lock is symbolic"
exec 8>"$host_lock"
chown root:root "$host_lock"
chmod 0600 "$host_lock"
flock --exclusive --nonblock 8 \
  || fail "another production or development deployment is active"

assert_empty_production_runtime() {
  local query resource
  query="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq')" \
    || fail "production containers could not be inspected"
  [[ -z "$query" ]] || fail "Business Finlynq production containers already exist"
  query="$(docker volume ls --format '{{.Name}}')" \
    || fail "Docker volumes could not be inspected"
  for resource in business_finlynq_pgdata business_finlynq_pgdata_clamav \
    business_finlynq_caddy_data business_finlynq_caddy_config; do
    ! grep -Fxq "$resource" <<<"$query" \
      || fail "production volume already exists: $resource"
  done
  query="$(docker network ls --format '{{.Name}}')" \
    || fail "Docker networks could not be inspected"
  for resource in business_finlynq_private business_finlynq_private_evidence \
    business_finlynq_egress business_finlynq_egress_scanner business_finlynq_restore_drill; do
    ! grep -Fxq "$resource" <<<"$query" \
      || fail "production network already exists: $resource"
  done
}

verify_production_edge_network() {
  docker network inspect "$production_network" \
    | jq -e '
      length == 1 and .[0].Name == "business_finlynq_edge" and
      .[0].Driver == "bridge" and .[0].Scope == "local" and
      .[0].Internal == true and .[0].Attachable == false and .[0].Ingress == false and
      (.[0].Options == null or .[0].Options == {}) and
      .[0].Labels == {
        "com.business-finlynq.edge-owner": "external",
        "com.business-finlynq.environment": "production"
      }
    ' >/dev/null || fail "production ingress network does not match the external-owner contract"
}

if [[ "$prepare_edge_network_only" == true ]]; then
  assert_empty_production_runtime
  if docker network inspect "$production_network" >/dev/null 2>&1; then
    verify_production_edge_network
  else
    docker network create --driver bridge --internal \
      --label com.business-finlynq.environment=production \
      --label com.business-finlynq.edge-owner=external "$production_network" >/dev/null \
      || fail "production ingress network could not be created"
    verify_production_edge_network
  fi
  printf 'Prepared only the attested external production ingress network: %s\n' \
    "$production_network"
  exit 0
fi

verify_production_edge_network

readonly -a edge_contract_keys=(
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_DATA_VOLUME
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_VOLUME
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE
  BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION
  EPM_FINLYNQ_HOSTNAME
)
declare -A edge_values=()

read_edge_contract() {
  local line key value allowed expected_key
  [[ -f "$edge_contract" && ! -L "$edge_contract" \
    && "$(stat -c '%u:%g:%a' -- "$edge_contract")" == 0:0:600 ]] \
    || fail "protected edge-contract.env must be root:root mode 0600"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] \
      || fail "edge-contract.env must contain only KEY=value records"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    allowed="false"
    for expected_key in "${edge_contract_keys[@]}"; do
      [[ "$key" == "$expected_key" ]] && allowed="true"
    done
    [[ "$allowed" == true ]] || fail "edge-contract.env contains an unsupported key: $key"
    [[ ! -v "edge_values[$key]" ]] || fail "edge-contract.env repeats $key"
    [[ -n "$value" && "$value" != *$'\r'* && "$value" != *$'\n'* \
      && "$value" != *[[:space:]]* ]] \
      || fail "edge-contract.env contains an empty or unsafe value for $key"
    edge_values["$key"]="$value"
  done <"$edge_contract"
  [[ "${#edge_values[@]}" == "${#edge_contract_keys[@]}" ]] \
    || fail "edge-contract.env does not have the exact reviewed key set"
  for expected_key in "${edge_contract_keys[@]}"; do
    [[ -v "edge_values[$expected_key]" ]] \
      || fail "edge-contract.env is missing $expected_key"
  done
}

validate_edge_contract() {
  local route_hash repository_route_hash config_mode
  read_edge_contract
  [[ "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT]}" == epm-finlynq \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE]}" == edge \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER]}" == epm-finlynq ]] \
    || fail "edge owner identity must be the reviewed EPM Compose service"
  [[ "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE]}" \
      =~ ^[^[:space:]]+@sha256:[a-f0-9]{64}$ \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID]}" \
      =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail "edge image metadata is not digest-pinned"
  [[ "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG]}" == /etc/caddy/Caddyfile \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE]}" == "$edge_route" \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION]}" \
      == /etc/caddy/business-finlynq-routes.caddy \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION]}" \
      == /config/epm-basic-auth \
    && "${edge_values[EPM_FINLYNQ_HOSTNAME]}" == epm.finlynq.com ]] \
    || fail "edge mount, route, or hostname metadata differs from the reviewed contract"
  [[ "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256]}" \
      =~ ^[a-f0-9]{64}$ \
    && "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256]}" \
      =~ ^[a-f0-9]{64}$ ]] \
    || fail "edge configuration hashes are invalid"
  [[ -f "$edge_route" && ! -L "$edge_route" \
    && "$(stat -c '%u:%g:%a' -- "$edge_route")" == 0:0:444 ]] \
    || fail "promoted Business edge route must be root:root mode 0444"
  route_hash="$(checked_file_sha256 "$edge_route")" \
    || fail "promoted Business edge route checksum could not be read"
  repository_route_hash="$(checked_file_sha256 \
    "$repository/deploy/edge/Caddyfile.business-external")" \
    || fail "reviewed Business edge route checksum could not be read"
  [[ "$route_hash" == "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256]}" \
    && "$route_hash" == "$repository_route_hash" ]] \
    || fail "promoted Business edge route differs from its metadata or reviewed source"
  [[ -f "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE]}" \
    && ! -L "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE]}" \
    && "$(stat -c '%u' -- \
      "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE]}")" == 0 ]] \
    || fail "the root-owned external Caddy source is unavailable"
  config_mode="$(stat -c '%a' -- \
    "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE]}")"
  [[ "$config_mode" =~ ^[0-7]{3,4}$ ]] \
    || fail "external Caddy source mode is invalid"
  (( (8#$config_mode & 8#022) == 0 )) \
    || fail "external Caddy source must not be group- or other-writable"
  [[ -f "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE]}" \
    && ! -L "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE]}" \
    && -s "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE]}" \
    && "$(stat -c '%u:%a' -- \
      "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE]}")" == 0:400 ]] \
    || fail "the preserved EPM authentication source is unavailable or unsafe"
}

if [[ -n "$edge_contract_input" ]]; then
  [[ -f "$edge_contract_input" && ! -L "$edge_contract_input" \
    && "$(stat -c '%u:%g:%a' -- "$edge_contract_input")" == 0:0:400 ]] \
    || fail "external edge contract source must be a root:root mode 0400 regular file"
  install -d -o root -g root -m 0700 -- "$edge_directory"
  edge_partial_list="$(mktemp)"
  if ! find "$edge_directory" -mindepth 1 -maxdepth 1 \
    -name '.edge-contract.*' -print0 >"$edge_partial_list"; then
    rm -f -- "$edge_partial_list"
    fail "partial canonical edge contracts could not be enumerated"
  fi
  mapfile -d '' -t edge_partials <"$edge_partial_list"
  rm -- "$edge_partial_list"
  for contract_partial in "${edge_partials[@]}"; do
    [[ "$contract_partial" == "$edge_directory"/.edge-contract.* \
      && -f "$contract_partial" && ! -L "$contract_partial" \
      && "$(stat -c '%u:%g:%a:%h' -- "$contract_partial")" == 0:0:600:1 ]] \
      || fail "partial canonical edge contract is unsafe"
    rm -- "$contract_partial"
  done
  edge_contract_input_sha="$(checked_file_sha256 "$edge_contract_input")" \
    || fail "external edge contract source checksum could not be read"
  if [[ -e "$edge_contract" || -L "$edge_contract" ]]; then
    canonical_edge_contract_sha="$(checked_file_sha256 "$edge_contract")" \
      || fail "canonical external edge contract checksum could not be read"
    [[ -f "$edge_contract" && ! -L "$edge_contract" \
      && "$(stat -c '%u:%g:%a' -- "$edge_contract")" == 0:0:600 \
      && "$canonical_edge_contract_sha" == "$edge_contract_input_sha" ]] \
      || fail "canonical edge contract differs from the supplied root-managed source"
  else
    contract_temporary="$(mktemp "$edge_directory/.edge-contract.XXXXXX")"
    install -o root -g root -m 0600 -- "$edge_contract_input" "$contract_temporary"
    mv -- "$contract_temporary" "$edge_contract"
    sync -f -- "$edge_contract"
    sync -f -- "$edge_directory"
  fi
fi
validate_edge_contract

readonly -a operation_timers=(
  business-finlynq-backup.timer
  business-finlynq-monitor.timer
  business-finlynq-accounting-evidence.timer
  business-finlynq-demo-reconcile.timer
)
readonly -a operation_services=(
  business-finlynq-backup.service
  business-finlynq-monitor.service
  business-finlynq-accounting-evidence.service
  business-finlynq-demo-reconcile.service
)

unit_is_absent_or_inactive() {
  local unit_name="$1" active_state active_status
  active_state=""; active_status=0
  if active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"; then
    active_status=0
  else
    active_status=$?
  fi
  [[ "$active_status" != 0 && "$active_state" == inactive ]] \
    || fail "deployment unit must be inactive: $unit_name"
}

timer_is_absent_or_disabled() {
  local unit_name="$1" enabled_state enabled_status
  enabled_state=""; enabled_status=0
  if enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"; then
    enabled_status=0
  else
    enabled_status=$?
  fi
  [[ "$enabled_status" != 0 \
    && ( "$enabled_state" == disabled || "$enabled_state" == not-found ) ]] \
    || fail "deployment timer must be disabled: $unit_name"
}

quiesce_bootstrap_schedulers() {
  local unit_name load_state
  systemctl daemon-reload || fail "systemd could not reload before bootstrap containment"
  for unit_name in "${operation_timers[@]}" business-finlynq-continuous-deployment.timer; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || fail "could not inspect scheduler unit $unit_name"
    [[ -n "$load_state" && "$load_state" != error ]] \
      || fail "scheduler unit returned an ambiguous load state: $unit_name"
    if [[ "$load_state" != not-found ]]; then
      systemctl disable --now "$unit_name" \
        || fail "could not disable scheduler timer $unit_name"
    fi
    timer_is_absent_or_disabled "$unit_name"
    unit_is_absent_or_inactive "$unit_name"
  done
  for unit_name in "${operation_services[@]}" business-finlynq-continuous-deployment.service; do
    load_state="$(systemctl show --property=LoadState --value "$unit_name" 2>/dev/null)" \
      || fail "could not inspect scheduler service $unit_name"
    [[ -n "$load_state" && "$load_state" != error ]] \
      || fail "scheduler service returned an ambiguous load state: $unit_name"
    if [[ "$load_state" != not-found ]]; then
      systemctl stop "$unit_name" \
        || fail "could not stop scheduler service $unit_name"
    fi
    unit_is_absent_or_inactive "$unit_name"
  done
  timer_is_absent_or_disabled business-finlynq-development-deployment.timer
  unit_is_absent_or_inactive business-finlynq-development-deployment.timer
  unit_is_absent_or_inactive business-finlynq-development-deployment.service
}

verify_all_bootstrap_automation_disabled() {
  local unit_name
  for unit_name in "${operation_timers[@]}" \
    business-finlynq-continuous-deployment.timer \
    business-finlynq-development-deployment.timer; do
    timer_is_absent_or_disabled "$unit_name"
    unit_is_absent_or_inactive "$unit_name"
  done
  for unit_name in "${operation_services[@]}" \
    business-finlynq-continuous-deployment.service \
    business-finlynq-development-deployment.service; do
    unit_is_absent_or_inactive "$unit_name"
  done
}

quiesce_bootstrap_schedulers

initial_wrapper_active="false"
wrapper_stop_app_on_failure="false"
contain_initial_wrapper_failure() {
  local exit_status="$?" unit_name containment_failed=false
  local enabled_state enabled_status active_state active_status
  local service_name container_output container_id stopped_state
  [[ "$exit_status" != 0 && "$initial_wrapper_active" == true ]] || return "$exit_status"
  set +e
  systemctl daemon-reload >/dev/null 2>&1 || containment_failed=true
  for unit_name in "${operation_timers[@]}" \
    business-finlynq-continuous-deployment.timer \
    business-finlynq-development-deployment.timer; do
    systemctl disable --now "$unit_name" >/dev/null 2>&1 || true
    enabled_state="$(systemctl is-enabled "$unit_name" 2>/dev/null)"
    enabled_status=$?
    active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"
    active_status=$?
    [[ "$enabled_status" != 0 \
      && ( "$enabled_state" == disabled || "$enabled_state" == not-found ) \
      && "$active_status" != 0 && "$active_state" == inactive ]] \
      || containment_failed=true
  done
  for unit_name in "${operation_services[@]}" \
    business-finlynq-continuous-deployment.service \
    business-finlynq-development-deployment.service; do
    systemctl stop "$unit_name" >/dev/null 2>&1 || true
    active_state="$(systemctl is-active "$unit_name" 2>/dev/null)"
    active_status=$?
    [[ "$active_status" != 0 && "$active_state" == inactive ]] \
      || containment_failed=true
  done
  for service_name in app auth_email_worker; do
    [[ "$service_name" != app || "$wrapper_stop_app_on_failure" == true ]] \
      || continue
    if ! container_output="$(docker ps --all --quiet --no-trunc \
      --filter 'label=com.docker.compose.project=business-finlynq' \
      --filter "label=com.docker.compose.service=$service_name")"; then
      containment_failed=true
      continue
    fi
    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] && continue
      if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
        containment_failed=true
        continue
      fi
      docker stop --time 30 "$container_id" >/dev/null 2>&1 || true
      stopped_state="$(docker inspect --format \
        '{{.State.Running}}|{{.State.Status}}' "$container_id" 2>/dev/null)"
      [[ "$stopped_state" == false\|exited ]] || containment_failed=true
    done <<<"$container_output"
  done
  if [[ "$containment_failed" == true ]]; then
    printf '%s\n' \
      'URGENT: failed initial wrapper could not prove every deployment timer/service disabled.' >&2
  else
    printf '%s\n' \
      'Initial wrapper failure left every deployment timer/service disabled and inactive.' >&2
  fi
  return "$exit_status"
}
trap contain_initial_wrapper_failure EXIT

assert_path_absent() {
  local selected_path="$1" description="$2"
  [[ ! -e "$selected_path" && ! -L "$selected_path" ]] \
    || fail "$description already exists without a matching protected install state"
}

create_protected_directories() {
  install -d -o root -g deploy -m 0750 -- "$configuration_directory"
  install -d -o root -g business-finlynq-secrets -m 0750 -- \
    "$secret_directory" "$backup_configuration_directory" "$recovery_directory"
  install -d -o root -g deploy -m 0750 -- "$rehearsal_configuration_directory"
  install -d -o root -g root -m 0700 -- \
    "$release_evidence_root" "$rehearsal_evidence_root"
  install -d -o 70 -g 70 -m 0700 -- "$backup_directory" \
    "$rehearsal_evidence_root/backups" \
    "$rehearsal_evidence_root/backups/first" \
    "$rehearsal_evidence_root/backups/second"
  install -d -o deploy -g deploy -m 0700 -- \
    /home/deploy/.local/state/business-finlynq/release-locks
  install -d -o root -g root -m 0755 -- /usr/local/libexec \
    "$external_edge_verifier_root" "$external_edge_verifier_root/deploy" \
    "$external_edge_verifier_directory"
}

install_protected_external_edge_verifier() {
  local tree_entry expected_output expected_sha expected_remainder target_sha
  local route_tree_entry route_expected_output route_expected_sha route_expected_remainder
  local route_target_sha
  [[ -f "$external_edge_verifier_source" && ! -L "$external_edge_verifier_source" ]] \
    || fail "reviewed external-edge verifier source is unavailable"
  tree_entry="$(git_as_deploy ls-tree "$revision" -- \
    deploy/edge/verify-external-edge.sh)" \
    || fail "external-edge verifier Git entry could not be inspected"
  [[ "$tree_entry" =~ ^100644[[:space:]]blob[[:space:]]([a-f0-9]{40}|[a-f0-9]{64})[[:space:]]deploy/edge/verify-external-edge\.sh$ ]] \
    || fail "external-edge verifier is not the exact regular Git blob"
  if ! expected_output="$(git_as_deploy show \
    "$revision:deploy/edge/verify-external-edge.sh" | sha256sum)"; then
    fail "external-edge verifier Git blob could not be hashed"
  fi
  read -r expected_sha expected_remainder <<<"$expected_output" \
    || fail "external-edge verifier Git digest could not be parsed"
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ && -n "$expected_remainder" ]] \
    || fail "external-edge verifier Git digest is invalid"
  [[ -f "$external_edge_verifier_route_source" \
    && ! -L "$external_edge_verifier_route_source" ]] \
    || fail "reviewed external-edge route source is unavailable"
  route_tree_entry="$(git_as_deploy ls-tree "$revision" -- \
    deploy/edge/Caddyfile.business-external)" \
    || fail "external-edge route Git entry could not be inspected"
  [[ "$route_tree_entry" =~ ^100644[[:space:]]blob[[:space:]]([a-f0-9]{40}|[a-f0-9]{64})[[:space:]]deploy/edge/Caddyfile\.business-external$ ]] \
    || fail "external-edge route is not the exact regular Git blob"
  if ! route_expected_output="$(git_as_deploy show \
    "$revision:deploy/edge/Caddyfile.business-external" | sha256sum)"; then
    fail "external-edge route Git blob could not be hashed"
  fi
  read -r route_expected_sha route_expected_remainder <<<"$route_expected_output" \
    || fail "external-edge route Git digest could not be parsed"
  [[ "$route_expected_sha" =~ ^[a-f0-9]{64}$ && -n "$route_expected_remainder" ]] \
    || fail "external-edge route Git digest is invalid"
  install -o root -g root -m 0550 -- \
    "$external_edge_verifier_source" "$external_edge_verifier_target"
  install -o root -g root -m 0444 -- \
    "$external_edge_verifier_route_source" "$external_edge_verifier_route_target"
  target_sha="$(checked_file_sha256 "$external_edge_verifier_target")" \
    || fail "protected external-edge verifier checksum could not be read"
  route_target_sha="$(checked_file_sha256 "$external_edge_verifier_route_target")" \
    || fail "protected external-edge route checksum could not be read"
  [[ "$target_sha" == "$expected_sha" \
    && "$(stat -c '%u:%g:%a:%h' -- "$external_edge_verifier_target")" == 0:0:550:1 \
    && "$route_target_sha" == "$route_expected_sha" \
    && "$(stat -c '%u:%g:%a:%h' -- "$external_edge_verifier_route_target")" \
      == 0:0:444:1 ]] \
    || fail "protected external-edge verifier differs from the exact Git revision"
  sync -f -- "$external_edge_verifier_target"
  sync -f -- "$external_edge_verifier_route_target"
  sync -f -- "$external_edge_verifier_directory"
}

validate_recipient_file() {
  local selected_file="$1" recipient line_count
  [[ -f "$selected_file" && ! -L "$selected_file" ]] \
    || fail "the age recipient input must be a regular non-symbolic-link file"
  line_count="$(awk 'END { print NR + 0 }' "$selected_file")"
  recipient="$(awk 'NR == 1 { sub(/\r$/, ""); print }' "$selected_file")"
  [[ "$line_count" == 1 && "$recipient" =~ ^age1[0-9a-z]{58}$ ]] \
    || fail "the age recipient file must contain exactly one public age recipient"
}

write_generated_secret() {
  local target="$1" kind="$2" temporary
  [[ ! -e "$target" && ! -L "$target" ]] \
    || fail "refusing to replace secret material: $target"
  temporary="$(mktemp "${target%/*}/.secret.XXXXXX")"
  case "$kind" in
    hex32) openssl rand -hex 32 >"$temporary" ;;
    base64-32) openssl rand -base64 32 >"$temporary" ;;
    base64-64)
      openssl rand 64 | openssl base64 -A >"$temporary"
      printf '\n' >>"$temporary"
      ;;
    *) rm -f -- "$temporary"; fail "unsupported secret generation type" ;;
  esac
  [[ -s "$temporary" ]] || { rm -f -- "$temporary"; fail "secret generation failed"; }
  chown root:business-finlynq-secrets "$temporary"
  chmod 0440 "$temporary"
  mv -- "$temporary" "$target"
  sync -f -- "$target"
}

verify_generated_secret() {
  local target="$1" kind="$2"
  [[ -f "$target" && ! -L "$target" \
    && "$(stat -c '%u:%g:%a' -- "$target")" == "0:$secret_gid:440" ]] \
    || fail "generated secret metadata is invalid: $target"
  case "$kind" in
    hex32)
      awk 'NR == 1 && $0 ~ /^[a-f0-9]{64}$/ { ok = 1; next }
        { ok = 0 } END { exit !(ok && NR == 1) }' "$target" \
        || fail "generated hexadecimal secret is invalid: $target"
      ;;
    base64-32)
      awk 'NR == 1 && $0 ~ /^[A-Za-z0-9+\/]{43}=$/ { ok = 1; next }
        { ok = 0 } END { exit !(ok && NR == 1) }' "$target" \
        || fail "generated 32-byte base64 secret is invalid: $target"
      ;;
    base64-64)
      awk 'NR == 1 && $0 ~ /^[A-Za-z0-9+\/]{86}==$/ { ok = 1; next }
        { ok = 0 } END { exit !(ok && NR == 1) }' "$target" \
        || fail "generated 64-byte base64 secret is invalid: $target"
      ;;
    *) fail "unsupported generated secret validation type" ;;
  esac
}

ensure_generated_secret() {
  local target="$1" kind="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    verify_generated_secret "$target" "$kind"
  else
    write_generated_secret "$target" "$kind"
    verify_generated_secret "$target" "$kind"
  fi
}

prepare_secret_bundle() {
  local bundle_directory="$1" recipient_source="$2" recipient_destination="$3"
  local recipient_temporary recipient_source_sha recipient_destination_sha
  install -d -o root -g business-finlynq-secrets -m 0750 -- "$bundle_directory"
  ensure_generated_secret "$bundle_directory/app-db-password" hex32
  ensure_generated_secret "$bundle_directory/auth-worker-db-password" hex32
  ensure_generated_secret "$bundle_directory/backup-db-password" hex32
  ensure_generated_secret "$bundle_directory/organization-root-kek" base64-32
  ensure_generated_secret "$bundle_directory/identity-secret" base64-64
  if [[ ! -e "$bundle_directory/not-configured" \
    && ! -L "$bundle_directory/not-configured" ]]; then
    install -o root -g business-finlynq-secrets -m 0440 -- /dev/null \
      "$bundle_directory/not-configured"
  fi
  [[ -f "$bundle_directory/not-configured" \
    && ! -L "$bundle_directory/not-configured" \
    && ! -s "$bundle_directory/not-configured" \
    && "$(stat -c '%u:%g:%a' -- "$bundle_directory/not-configured")" \
      == "0:$secret_gid:440" ]] \
    || fail "durable disabled-secret placeholder is invalid"
  if [[ -e "$recipient_destination" || -L "$recipient_destination" ]]; then
    recipient_source_sha="$(checked_file_sha256 "$recipient_source")" \
      || fail "public age recipient source checksum could not be read"
    recipient_destination_sha="$(checked_file_sha256 "$recipient_destination")" \
      || fail "configured public age recipient checksum could not be read"
    [[ -f "$recipient_destination" && ! -L "$recipient_destination" \
      && "$(stat -c '%u:%g:%a' -- "$recipient_destination")" \
        == "0:$secret_gid:440" \
      && "$recipient_source_sha" == "$recipient_destination_sha" ]] \
      || fail "configured public age recipient changed during preparation recovery"
  else
    recipient_temporary="$(mktemp "${recipient_destination%/*}/.recipient.XXXXXX")"
    install -o root -g business-finlynq-secrets -m 0440 -- \
      "$recipient_source" "$recipient_temporary"
    mv -- "$recipient_temporary" "$recipient_destination"
    sync -f -- "$recipient_destination"
  fi
}

write_compose_environment() {
  local target="$1" bundle_directory="$2" age_recipient_file="$3"
  local selected_backup_directory="$4" app_port="$5" app_origin="$6"
  local cookie_name="$7" resource_prefix="$8" selected_edge_mode="$9"
  local owner_password="${10}" temporary
  local external_project="" external_service="edge" external_owner=""
  local external_image="" external_image_id="" external_config="/etc/caddy/Caddyfile"
  local external_config_source="" external_public_ipv4s="" external_route_source="$edge_route"
  local external_route_destination="/etc/caddy/business-finlynq-routes.caddy"
  local external_route_sha256="" external_active_config_sha256=""
  local external_data_volume="" external_config_volume="" external_epm_secret_source=""
  local external_epm_secret_destination="/config/epm-basic-auth"

  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" \
      && "$(stat -c '%U:%G:%a' -- "$target")" == root:deploy:600 ]] \
      || fail "partially prepared Compose environment is unsafe: $target"
    return 0
  fi

  if [[ "$selected_edge_mode" == external ]]; then
    external_project="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT]}"
    external_service="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE]}"
    external_owner="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER]}"
    external_image="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE]}"
    external_image_id="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID]}"
    external_config="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG]}"
    external_config_source="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE]}"
    external_public_ipv4s="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S]}"
    external_route_source="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE]}"
    external_route_destination="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION]}"
    external_route_sha256="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256]}"
    external_active_config_sha256="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256]}"
    external_data_volume="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_DATA_VOLUME]}"
    external_config_volume="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_VOLUME]}"
    external_epm_secret_source="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE]}"
    external_epm_secret_destination="${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION]}"
  fi

  temporary="$(mktemp "${target%/*}/.compose-env.XXXXXX")"
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$owner_password"
    printf 'APP_DATABASE_PASSWORD_FILE=%s/app-db-password\n' "$bundle_directory"
    printf 'AUTH_WORKER_DATABASE_PASSWORD_FILE=%s/auth-worker-db-password\n' "$bundle_directory"
    printf 'BACKUP_DATABASE_PASSWORD_FILE=%s/backup-db-password\n' "$bundle_directory"
    printf 'ORGANIZATION_ROOT_KEK_FILE=%s/organization-root-kek\n' "$bundle_directory"
    printf 'IDENTITY_SECRET_FILE=%s/identity-secret\n' "$bundle_directory"
    printf 'BUSINESS_FINLYNQ_SECRET_GID=%s\n' "$secret_gid"
    printf 'BUSINESS_FINLYNQ_HOSTNAME=business.finlynq.com\n'
    printf 'BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME=dev.business.finlynq.com\n'
    printf 'EPM_FINLYNQ_HOSTNAME=epm.finlynq.com\n'
    printf 'CONSULT_FINLYNQ_HOSTNAME=consult.finlynq.com\n'
    printf 'BUSINESS_FINLYNQ_APP_ORIGIN=%s\n' "$app_origin"
    printf 'BUSINESS_FINLYNQ_APP_PORT=%s\n' "$app_port"
    printf 'BUSINESS_FINLYNQ_APP_NETWORK_ALIAS=production-app\n'
    printf 'BUSINESS_FINLYNQ_PGDATA_VOLUME=%s_pgdata\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_CADDY_DATA_VOLUME=%s_caddy_data\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_CADDY_CONFIG_VOLUME=%s_caddy_config\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_PRIVATE_NETWORK=%s_private\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_EGRESS_NETWORK=%s_egress\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_EDGE_NETWORK=%s_edge\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_RESTORE_DRILL_NETWORK=%s_restore_drill\n' "$resource_prefix"
    printf 'BUSINESS_FINLYNQ_EDGE_MODE=%s\n' "$selected_edge_mode"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT=%s\n' "$external_project"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE=%s\n' "$external_service"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER=%s\n' "$external_owner"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE=%s\n' "$external_image"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID=%s\n' "$external_image_id"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG=%s\n' "$external_config"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE=%s\n' "$external_config_source"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S=%s\n' "$external_public_ipv4s"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE=%s\n' "$external_route_source"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION=%s\n' "$external_route_destination"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256=%s\n' "$external_route_sha256"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256=%s\n' "$external_active_config_sha256"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_DATA_VOLUME=%s\n' "$external_data_volume"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_VOLUME=%s\n' "$external_config_volume"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE=%s\n' "$external_epm_secret_source"
    printf 'BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION=%s\n' "$external_epm_secret_destination"
    printf 'TRUSTED_PROXY_HOPS=%s\n' "$([[ "$selected_edge_mode" == external ]] && printf 1 || printf 0)"
    printf 'SESSION_COOKIE_NAME=%s\n' "$cookie_name"
    printf 'DEMO_LOGIN_ENABLED=true\n'
    printf 'DEMO_WRITES_ENABLED=true\n'
    printf 'ACCOUNT_LOGIN_ENABLED=false\n'
    printf 'ACCOUNT_SIGNUP_ENABLED=false\n'
    printf 'AUTH_EMAIL_DELIVERY_ENABLED=false\n'
    printf 'SIGNUP_TURNSTILE_ENABLED=false\n'
    printf 'SIGNUP_TURNSTILE_SITE_KEY=\n'
    printf 'BUSINESS_WRITES_ENABLED=false\n'
    printf 'BANK_FEEDS_ENABLED=false\n'
    printf 'YAHOO_FX_ENABLED=false\n'
    printf 'AUTH_EMAIL_PROVIDER=resend\n'
    printf 'AUTH_EMAIL_FROM=\n'
    printf 'AUTH_EMAIL_REPLY_TO=\n'
    printf 'AUTH_RESEND_API_KEY_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'TURNSTILE_SECRET_KEY_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'DOCUMENT_GOOGLE_CLIENT_ID=\n'
    printf 'DOCUMENT_GOOGLE_CLIENT_SECRET_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'DOCUMENT_MICROSOFT_CLIENT_ID=\n'
    printf 'DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'DOCUMENT_INBOX_MAX_DEPTH=8\n'
    printf 'DOCUMENT_INBOX_MAX_PROVIDER_CALLS=10\n'
    printf 'BACKUP_AGE_RECIPIENT_FILE=%s\n' "$age_recipient_file"
    printf 'BACKUP_AGE_IDENTITY_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'BACKUP_RCLONE_CONFIG_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'BACKUP_RECEIVER_SSH_PRIVATE_KEY_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'BACKUP_RECEIVER_KNOWN_HOSTS_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256=%064d\n' 0
    printf 'BACKUP_RCLONE_REMOTE=\n'
    printf 'BACKUP_LOCAL_DIR=%s\n' "$selected_backup_directory"
    printf 'BACKUP_LOCAL_RETENTION_DAYS=14\n'
    printf 'BACKUP_REQUIRE_OFFSITE=false\n'
    printf 'RESTORE_DATABASE_PASSWORD_FILE=%s/not-configured\n' "$bundle_directory"
    printf 'RESTORE_BACKUP_MANIFEST=\n'
    printf 'RESTORE_REQUIRE_WRAPPED_KEYS=true\n'
    printf 'RESTORE_ALLOW_EMPTY_SECRET_FIXTURES=false\n'
    printf 'RESTORE_DRILL_LOCK_FILE=%s_restore_drill.lock\n' "$selected_backup_directory"
    printf 'RESTORE_DRILL_LOCK_WAIT_SECONDS=0\n'
    printf 'RESTORE_RPO_SECONDS=21600\n'
    printf 'RESTORE_RTO_SECONDS=14400\n'
    printf 'RESTORE_REQUIRE_OFFSITE_EVIDENCE=false\n'
    printf 'MONITOR_BACKUP_DIR=%s\n' "$selected_backup_directory"
    printf 'MONITOR_MAX_BACKUP_AGE_HOURS=6\n'
    printf 'MONITOR_MAX_BACKUP_ACTIVE_SECONDS=4800\n'
    printf 'MONITOR_REQUIRE_OFFSITE=false\n'
    printf 'BUSINESS_FINLYNQ_IMAGE_REVISION=%s\n' "$revision"
  } >"$temporary"
  chown root:deploy "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$target"
  sync -f -- "$target"
}

write_operations_environment() {
  local temporary
  if [[ -e "$operations_environment" || -L "$operations_environment" ]]; then
    [[ -f "$operations_environment" && ! -L "$operations_environment" \
      && "$(stat -c '%U:%G:%a' -- "$operations_environment")" == root:deploy:600 ]] \
      || fail "partially prepared operations environment is unsafe"
    return 0
  fi
  temporary="$(mktemp "$configuration_directory/.operations-env.XXXXXX")"
  {
    printf 'BUSINESS_FINLYNQ_IMAGE_REVISION=%s\n' "$revision"
    printf 'MONITOR_EXPECT_REVISION=%s\n' "$revision"
    printf 'MONITOR_HOSTNAME=business.finlynq.com\n'
    printf 'MONITOR_BASE_URL=https://business.finlynq.com\n'
    printf 'MONITOR_BACKUP_DIR=%s\n' "$backup_directory"
    printf 'MONITOR_MAX_BACKUP_AGE_HOURS=6\n'
    printf 'SCHEDULED_BACKUP_TIMEOUT_SECONDS=5400\n'
    printf 'MONITOR_MAX_BACKUP_ACTIVE_SECONDS=4800\n'
    printf 'MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS=90\n'
    printf 'ACCOUNTING_EVIDENCE_VERIFY_TIMEOUT_SECONDS=180\n'
    printf 'ACCOUNTING_EVIDENCE_STATEMENT_TIMEOUT_MS=120000\n'
    printf 'ACCOUNTING_EVIDENCE_METRICS_FILE=%s/accounting-evidence.prom\n' "$state_directory"
    printf 'ACCOUNTING_EVIDENCE_LOCK_FILE=%s/accounting-evidence.lock\n' "$state_directory"
    printf 'MONITOR_MIN_TLS_DAYS=21\n'
    printf 'MONITOR_MAX_DISK_PERCENT=85\n'
    printf 'MONITOR_EXPECT_EDGE=true\n'
    printf 'MONITOR_EDGE_MODE=external\n'
    printf 'MONITOR_EXTERNAL_EDGE_PROJECT=%s\n' \
      "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT]}"
    printf 'MONITOR_EXTERNAL_EDGE_SERVICE=%s\n' \
      "${edge_values[BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE]}"
    printf 'MONITOR_EXTERNAL_EDGE_NETWORK=%s\n' "$production_network"
    printf 'MONITOR_EXPECT_AUTH_EMAIL_WORKER=false\n'
    printf 'MONITOR_EXPECT_OUTBOX_PUBLISHER=false\n'
    printf 'MONITOR_EXPECT_DEMO_LOGIN_ENABLED=true\n'
    printf 'MONITOR_EXPECT_DEMO_WRITES_ENABLED=true\n'
    printf 'MONITOR_EXPECT_ACCOUNT_LOGIN_ENABLED=false\n'
    printf 'MONITOR_EXPECT_ACCOUNT_SIGNUP_ENABLED=false\n'
    printf 'MONITOR_EXPECT_BUSINESS_WRITES_ENABLED=false\n'
    printf 'MONITOR_EXPECT_BANK_FEEDS_ENABLED=false\n'
    printf 'MONITOR_EXPECT_DEMO_MAINTENANCE=true\n'
    printf 'MONITOR_EXPECT_SCHEDULERS_ACTIVE=false\n'
    printf 'MONITOR_MAINTENANCE_SCHEDULER=systemd\n'
    printf 'MONITOR_REQUIRE_OFFSITE=false\n'
    printf 'MONITOR_ALERT_WEBHOOK_URL_FILE=%s\n' "$placeholder"
    printf 'MONITOR_METRICS_FILE=%s/host.prom\n' "$state_directory"
  } >"$temporary"
  chown root:deploy "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$operations_environment"
  sync -f -- "$operations_environment"
}

readonly first_rehearsal_secrets="$rehearsal_configuration_directory/first-secrets"
readonly second_rehearsal_secrets="$rehearsal_configuration_directory/second-secrets"
readonly first_rehearsal_environment="$rehearsal_configuration_directory/first.env"
readonly second_rehearsal_environment="$rehearsal_configuration_directory/second.env"
readonly first_rehearsal_recipient="$first_rehearsal_secrets/age-recipients.txt"
readonly second_rehearsal_recipient="$second_rehearsal_secrets/age-recipients.txt"

declare -a managed_configuration_files=(
  "$external_edge_verifier_target"
  "$external_edge_verifier_route_target"
  "$edge_contract"
  "$edge_route"
  "$compose_environment"
  "$operations_environment"
  "$repository_environment"
  "$recipient_target"
  "$secret_directory/app-db-password"
  "$secret_directory/auth-worker-db-password"
  "$secret_directory/backup-db-password"
  "$secret_directory/organization-root-kek"
  "$secret_directory/identity-secret"
  "$placeholder"
  "$first_rehearsal_environment"
  "$first_rehearsal_secrets/app-db-password"
  "$first_rehearsal_secrets/auth-worker-db-password"
  "$first_rehearsal_secrets/backup-db-password"
  "$first_rehearsal_secrets/organization-root-kek"
  "$first_rehearsal_secrets/identity-secret"
  "$first_rehearsal_secrets/not-configured"
  "$first_rehearsal_recipient"
  "$second_rehearsal_environment"
  "$second_rehearsal_secrets/app-db-password"
  "$second_rehearsal_secrets/auth-worker-db-password"
  "$second_rehearsal_secrets/backup-db-password"
  "$second_rehearsal_secrets/organization-root-kek"
  "$second_rehearsal_secrets/identity-secret"
  "$second_rehearsal_secrets/not-configured"
  "$second_rehearsal_recipient"
)
declare -A managed_configuration_paths=()
for managed_file in "${managed_configuration_files[@]}"; do
  managed_configuration_paths["$managed_file"]="true"
done

verify_protected_layout() {
  [[ "$(stat -c '%U:%G:%a' -- "$configuration_directory")" == root:deploy:750 \
    && "$(stat -c '%U:%G:%a' -- "$secret_directory")" \
      == root:business-finlynq-secrets:750 \
    && "$(stat -c '%U:%G:%a' -- "$backup_configuration_directory")" \
      == root:business-finlynq-secrets:750 \
    && "$(stat -c '%U:%G:%a' -- "$recovery_directory")" \
      == root:business-finlynq-secrets:750 \
    && "$(stat -c '%U:%G:%a' -- "$rehearsal_configuration_directory")" \
      == root:deploy:750 ]] \
    || fail "protected configuration directory ownership or mode changed"
  [[ "$(stat -c '%u:%g:%a' -- "$release_evidence_root")" == 0:0:700 \
    && "$(stat -c '%u:%g:%a' -- "$rehearsal_evidence_root")" == 0:0:700 \
    && "$(stat -c '%u:%g:%a' -- "$backup_directory")" == 70:70:700 \
    && "$(stat -c '%u:%g:%a' -- "$rehearsal_evidence_root/backups/first")" \
      == 70:70:700 \
    && "$(stat -c '%u:%g:%a' -- "$rehearsal_evidence_root/backups/second")" \
      == 70:70:700 ]] \
    || fail "backup or evidence directory ownership or mode changed"
  [[ "$(stat -c '%U:%G:%a' -- \
    /home/deploy/.local/state/business-finlynq/release-locks)" == deploy:deploy:700 ]] \
    || fail "release coordination lock directory is unsafe"
  [[ -f "$external_edge_verifier_target" && ! -L "$external_edge_verifier_target" \
    && "$(readlink -f -- "$external_edge_verifier_target")" \
      == "$external_edge_verifier_target" \
    && "$(stat -c '%u:%g:%a:%h' -- "$external_edge_verifier_target")" \
      == 0:0:550:1 ]] \
    || fail "protected external-edge verifier ownership or mode changed"
  [[ -f "$external_edge_verifier_route_target" \
    && ! -L "$external_edge_verifier_route_target" \
    && "$(readlink -f -- "$external_edge_verifier_route_target")" \
      == "$external_edge_verifier_route_target" \
    && "$(stat -c '%u:%g:%a:%h' -- "$external_edge_verifier_route_target")" \
      == 0:0:444:1 ]] \
    || fail "protected external-edge route ownership or mode changed"
}

write_install_state() {
  local inventory='[]' selected_file metadata file_sha file_size temporary
  local created_at recipient_sha edge_contract_sha edge_route_sha
  for selected_file in "${managed_configuration_files[@]}"; do
    [[ -f "$selected_file" && ! -L "$selected_file" ]] \
      || fail "managed configuration file is unavailable: $selected_file"
    metadata="$(stat -c '%u:%g:%a' -- "$selected_file")"
    file_sha="$(checked_file_sha256 "$selected_file")" \
      || fail "managed configuration checksum could not be read: $selected_file"
    file_size="$(stat -c '%s' -- "$selected_file")"
    [[ "$metadata" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ \
      && "$file_sha" =~ ^[a-f0-9]{64}$ && "$file_size" =~ ^[0-9]+$ ]] \
      || fail "managed configuration metadata is invalid: $selected_file"
    inventory="$(jq -c --arg path "$selected_file" --arg metadata "$metadata" \
      --arg sha256 "$file_sha" --argjson bytes "$file_size" \
      '. + [{path: $path, metadata: $metadata, sha256: $sha256, bytes: $bytes}]' \
      <<<"$inventory")"
  done
  created_at="$(checked_utc_timestamp)" \
    || fail "install-state timestamp could not be generated"
  recipient_sha="$(checked_file_sha256 "$recipient_target")" \
    || fail "protected backup recipient checksum could not be read"
  edge_contract_sha="$(checked_file_sha256 "$edge_contract")" \
    || fail "protected edge contract checksum could not be read"
  edge_route_sha="$(checked_file_sha256 "$edge_route")" \
    || fail "protected edge route checksum could not be read"
  temporary="$(mktemp "$configuration_directory/.initial-install-state.XXXXXX")"
  jq -n \
    --arg createdAt "$created_at" \
    --arg revision "$revision" \
    --arg recipientSha256 "$recipient_sha" \
    --arg edgeContractSha256 "$edge_contract_sha" \
    --arg edgeRouteSha256 "$edge_route_sha" \
    --argjson files "$inventory" \
    '{schemaVersion: 1, product: "business-finlynq", phase: "configured",
      createdAt: $createdAt, revision: $revision,
      recipientSha256: $recipientSha256,
      edgeContractSha256: $edgeContractSha256,
      edgeRouteSha256: $edgeRouteSha256,
      configurationFiles: $files}' >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$install_state"
  sync -f -- "$install_state"
  sync -f -- "$configuration_directory"
}

verify_install_state() {
  local records record selected_path recorded_metadata recorded_sha recorded_bytes observed_sha
  local recipient_sha edge_contract_sha edge_route_sha
  local seen_count=0
  declare -A seen_paths=()
  [[ -f "$install_state" && ! -L "$install_state" \
    && "$(stat -c '%u:%g:%a' -- "$install_state")" == 0:0:600 ]] \
    || fail "protected initial install state is unavailable"
  recipient_sha="$(checked_file_sha256 "$recipient_target")" \
    || fail "protected backup recipient checksum could not be read"
  edge_contract_sha="$(checked_file_sha256 "$edge_contract")" \
    || fail "protected edge contract checksum could not be read"
  edge_route_sha="$(checked_file_sha256 "$edge_route")" \
    || fail "protected edge route checksum could not be read"
  jq -e --arg revision "$revision" \
    --arg recipientSha256 "$recipient_sha" \
    --arg edgeContractSha256 "$edge_contract_sha" \
    --arg edgeRouteSha256 "$edge_route_sha" \
    --argjson expectedFiles "${#managed_configuration_files[@]}" '
      type == "object" and
      keys == ["configurationFiles", "createdAt", "edgeContractSha256",
        "edgeRouteSha256", "phase", "product", "recipientSha256", "revision",
        "schemaVersion"] and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .phase == "configured" and .revision == $revision and
      .recipientSha256 == $recipientSha256 and
      .edgeContractSha256 == $edgeContractSha256 and
      .edgeRouteSha256 == $edgeRouteSha256 and
      (.createdAt | type == "string") and
      (.configurationFiles | type == "array" and length == $expectedFiles)
    ' "$install_state" >/dev/null \
    || fail "initial install state identity or configuration digests differ"
  records="$(jq -c '.configurationFiles[]' "$install_state")" \
    || fail "managed configuration inventory could not be read"
  while IFS= read -r record; do
    selected_path="$(jq -er '.path' <<<"$record")" \
      || fail "managed configuration inventory has no path"
    [[ -v "managed_configuration_paths[$selected_path]" \
      && ! -v "seen_paths[$selected_path]" ]] \
      || fail "managed configuration inventory contains an unexpected or duplicate path"
    jq -e 'type == "object" and keys == ["bytes", "metadata", "path", "sha256"] and
      (.metadata | test("^[0-9]+:[0-9]+:[0-7]{3,4}$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and
      (.bytes | type == "number" and . == floor and . >= 0)' \
      <<<"$record" >/dev/null \
      || fail "managed configuration inventory record is invalid"
    recorded_metadata="$(jq -r '.metadata' <<<"$record")" \
      || fail "managed configuration metadata could not be read"
    recorded_sha="$(jq -r '.sha256' <<<"$record")" \
      || fail "managed configuration checksum could not be read"
    recorded_bytes="$(jq -r '.bytes' <<<"$record")" \
      || fail "managed configuration size could not be read"
    observed_sha="$(checked_file_sha256 "$selected_path")" \
      || fail "managed configuration checksum could not be verified: $selected_path"
    [[ -f "$selected_path" && ! -L "$selected_path" \
      && "$(stat -c '%u:%g:%a' -- "$selected_path")" == "$recorded_metadata" \
      && "$observed_sha" == "$recorded_sha" \
      && "$(stat -c '%s' -- "$selected_path")" == "$recorded_bytes" ]] \
      || fail "managed configuration changed after initial setup: $selected_path"
    seen_paths["$selected_path"]="true"
    (( seen_count += 1 ))
  done <<<"$records"
  [[ "$seen_count" == "${#managed_configuration_files[@]}" ]] \
    || fail "managed configuration inventory is incomplete"
  verify_protected_layout
}

validate_new_configuration_boundary() {
  local edge_entries backup_entries
  assert_empty_production_runtime
  for selected_path in "$compose_environment" "$operations_environment" \
    "$repository_environment" "$secret_directory" "$backup_configuration_directory" \
    "$recovery_directory" "$rehearsal_configuration_directory" "$install_state" \
    "$preparation_state" "$install_completion" "$release_evidence_root" \
    "$rehearsal_evidence_root"; do
    assert_path_absent "$selected_path" "fresh production configuration path"
  done
  assert_path_absent "$external_edge_verifier_target" \
    "protected external-edge verifier"
  assert_path_absent "$external_edge_verifier_route_target" \
    "protected external-edge verifier route"
  if [[ -e "$backup_directory" || -L "$backup_directory" ]]; then
    [[ -d "$backup_directory" && ! -L "$backup_directory" ]] \
      || fail "fresh production backup directory must be a real directory"
    backup_entries="$(find "$backup_directory" -mindepth 1 -maxdepth 1 -print -quit)" \
      || fail "fresh production backup directory could not be inspected"
    [[ -z "$backup_entries" ]] \
      || fail "fresh production backup directory must be absent or empty"
  fi
  edge_entries="$(find "$edge_directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)" \
    || fail "protected edge directory could not be inspected"
  [[ "$edge_entries" == $'business-finlynq-routes.caddy\nedge-contract.env' ]] \
    || fail "protected edge directory contains an unexpected entry"
  for selected_path in \
    /etc/systemd/system/business-finlynq-continuous-deployment.service \
    /etc/systemd/system/business-finlynq-continuous-deployment.timer; do
    assert_path_absent "$selected_path" "production continuous-deployment unit"
  done
}

write_preparation_state() {
  local temporary created_at recipient_sha edge_contract_sha
  [[ ! -e "$preparation_state" && ! -L "$preparation_state" ]] \
    || fail "initial preparation journal already exists"
  production_owner_password="$(checked_random_hex_32)" \
    || fail "production database owner credential generation failed"
  first_owner_password="$(checked_random_hex_32)" \
    || fail "first rehearsal database owner credential generation failed"
  second_owner_password="$(checked_random_hex_32)" \
    || fail "second rehearsal database owner credential generation failed"
  [[ "$production_owner_password" =~ ^[a-f0-9]{64}$ \
    && "$first_owner_password" =~ ^[a-f0-9]{64}$ \
    && "$second_owner_password" =~ ^[a-f0-9]{64}$ \
    && "$production_owner_password" != "$first_owner_password" \
    && "$production_owner_password" != "$second_owner_password" \
    && "$first_owner_password" != "$second_owner_password" ]] \
    || fail "independent database owner credentials could not be generated"
  created_at="$(checked_utc_timestamp)" \
    || fail "preparation-journal timestamp could not be generated"
  recipient_sha="$(checked_file_sha256 "$recipient_input")" \
    || fail "preparation recipient checksum could not be read"
  edge_contract_sha="$(checked_file_sha256 "$edge_contract")" \
    || fail "preparation edge-contract checksum could not be read"
  temporary="$(mktemp "$configuration_directory/.initial-preparation.XXXXXX")"
  jq -n --arg createdAt "$created_at" \
    --arg revision "$revision" \
    --arg recipientSha256 "$recipient_sha" \
    --arg edgeContractSha256 "$edge_contract_sha" \
    --arg productionOwnerPassword "$production_owner_password" \
    --arg firstOwnerPassword "$first_owner_password" \
    --arg secondOwnerPassword "$second_owner_password" '
    {schemaVersion: 1, product: "business-finlynq", phase: "configuring",
      createdAt: $createdAt, revision: $revision,
      recipientSha256: $recipientSha256,
      edgeContractSha256: $edgeContractSha256,
      ownerPasswords: {production: $productionOwnerPassword,
        first: $firstOwnerPassword, second: $secondOwnerPassword}}
  ' >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$preparation_state"
  sync -f -- "$preparation_state"
  sync -f -- "$configuration_directory"
}

verify_preparation_state() {
  local preparation_recipient_source="${recipient_input:-$recipient_target}"
  local recipient_sha edge_contract_sha
  [[ -f "$preparation_recipient_source" && ! -L "$preparation_recipient_source" ]] \
    || fail "preparation recovery recipient is unavailable"
  [[ -f "$preparation_state" && ! -L "$preparation_state" \
    && "$(stat -c '%u:%g:%a' -- "$preparation_state")" == 0:0:600 ]] \
    || fail "initial preparation journal is unavailable or unsafe"
  recipient_sha="$(checked_file_sha256 "$preparation_recipient_source")" \
    || fail "preparation recovery recipient checksum could not be read"
  edge_contract_sha="$(checked_file_sha256 "$edge_contract")" \
    || fail "preparation recovery edge-contract checksum could not be read"
  jq -e --arg revision "$revision" \
    --arg recipientSha256 "$recipient_sha" \
    --arg edgeContractSha256 "$edge_contract_sha" '
    type == "object" and
    keys == ["createdAt", "edgeContractSha256", "ownerPasswords", "phase",
      "product", "recipientSha256", "revision", "schemaVersion"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .phase == "configuring" and .revision == $revision and
    .recipientSha256 == $recipientSha256 and
    .edgeContractSha256 == $edgeContractSha256 and
    (.ownerPasswords | type == "object" and
      keys == ["first", "production", "second"] and
      all(.[]; type == "string" and test("^[a-f0-9]{64}$")) and
      .production != .first and .production != .second and .first != .second) and
    (.createdAt | type == "string")
  ' "$preparation_state" >/dev/null \
    || fail "initial preparation journal does not match the exact retry inputs"
  production_owner_password="$(jq -r '.ownerPasswords.production' "$preparation_state")" \
    || fail "production owner credential could not be recovered from the preparation journal"
  first_owner_password="$(jq -r '.ownerPasswords.first' "$preparation_state")" \
    || fail "first rehearsal owner credential could not be recovered from the preparation journal"
  second_owner_password="$(jq -r '.ownerPasswords.second' "$preparation_state")" \
    || fail "second rehearsal owner credential could not be recovered from the preparation journal"
}

cleanup_preparation_temporary_files() {
  local selected_directory selected_file temporary_list
  local selected_metadata selected_links temporary_sha compose_sha
  local -a temporary_files=()
  for selected_directory in "$configuration_directory" "$secret_directory" \
    "$rehearsal_configuration_directory" "$first_rehearsal_secrets" \
    "$second_rehearsal_secrets" "$repository"; do
    [[ ! -e "$selected_directory" || ( -d "$selected_directory" \
      && ! -L "$selected_directory" ) ]] \
      || fail "preparation temporary-file directory is unsafe"
    [[ -d "$selected_directory" ]] || continue
    temporary_list="$(mktemp)"
    if ! find "$selected_directory" -mindepth 1 -maxdepth 1 \
      \( -name '.secret.*' -o -name '.recipient.*' -o -name '.compose-env.*' \
      -o -name '.operations-env.*' -o -name '.env.initial.*' \
      -o -name '.initial-install-state.*' -o -name '.initial-preparation.*' \) \
      -print0 >"$temporary_list"; then
      rm -f -- "$temporary_list"
      fail "preparation temporary files could not be enumerated"
    fi
    mapfile -d '' -t temporary_files <"$temporary_list"
    rm -- "$temporary_list"
    for selected_file in "${temporary_files[@]}"; do
      [[ "$selected_file" == "$selected_directory"/.* \
        && -f "$selected_file" && ! -L "$selected_file" ]] \
        || fail "preparation temporary file is unsafe"
      if [[ "$selected_directory" == "$repository" \
        && "${selected_file##*/}" == .env.initial.* ]]; then
        selected_links="$(stat -c '%h' -- "$selected_file")" \
          || fail "repository environment temporary link count could not be inspected"
        selected_metadata="$(stat -c '%U:%G:%a' -- "$selected_file")" \
          || fail "repository environment temporary metadata could not be inspected"
        [[ "$selected_links" == 1 ]] \
          || fail "partially prepared repository environment temporary file is linked"
        if [[ "$selected_metadata" == root:root:600 ]]; then
          : # Root-owned partial copy is safe to remove from the ignored staging namespace.
        elif [[ "$selected_metadata" == deploy:deploy:600 ]]; then
          [[ -f "$compose_environment" && ! -L "$compose_environment" ]] \
            || fail "canonical Compose environment is unavailable for staging recovery"
          temporary_sha="$(checked_file_sha256 "$selected_file")" \
            || fail "repository environment temporary checksum could not be read"
          compose_sha="$(checked_file_sha256 "$compose_environment")" \
            || fail "canonical Compose environment checksum could not be read"
          [[ "$temporary_sha" == "$compose_sha" ]] \
            || fail "deploy-owned repository environment staging copy is incomplete"
        else
          fail "partially prepared repository environment temporary file is unsafe"
        fi
      else
        [[ "$(stat -c '%u' -- "$selected_file")" == 0 ]] \
          || fail "preparation temporary file is not root owned"
      fi
      rm -- "$selected_file"
    done
    temporary_files=()
  done
}

read_unique_environment_value() {
  local selected_file="$1" selected_key="$2" count value
  count="$(awk -F= -v key="$selected_key" '$1 == key { count++ }
    END { print count + 0 }' "$selected_file")" \
    || fail "prepared environment key count could not be read: $selected_key"
  [[ "$count" == 1 ]] \
    || fail "prepared environment must define $selected_key exactly once"
  value="$(awk -F= -v key="$selected_key" '$1 == key {
    sub(/^[^=]*=/, ""); print; exit
  }' "$selected_file")" \
    || fail "prepared environment value could not be read: $selected_key"
  printf '%s' "$value"
}

assert_environment_value() {
  local selected_file="$1" selected_key="$2" expected_value="$3" observed_value
  observed_value="$(read_unique_environment_value "$selected_file" "$selected_key")" \
    || fail "prepared environment value could not be read: $selected_key"
  [[ "$observed_value" == "$expected_value" ]] \
    || fail "prepared environment has an unexpected value for $selected_key"
}

verify_prepared_environment_file() {
  local selected_file="$1"
  [[ -f "$selected_file" && ! -L "$selected_file" ]] \
    || fail "prepared environment file is unavailable: $selected_file"
  awk -F= '
    $0 !~ /^[A-Z][A-Z0-9_]*=/ || index($0, "\r") { exit 1 }
    seen[$1]++ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' "$selected_file" \
    || fail "prepared environment contains malformed or duplicate records: $selected_file"
}

verify_prepared_configuration_content() {
  local environment_file bundle_directory selected_key expected_value
  local production_password first_password second_password generated_hashes generated_hash
  local duplicate_generated_hash
  local compose_environment_sha repository_environment_sha generated_hash_count=0
  for environment_file in "$compose_environment" "$first_rehearsal_environment" \
    "$second_rehearsal_environment" "$operations_environment"; do
    verify_prepared_environment_file "$environment_file"
  done
  compose_environment_sha="$(checked_file_sha256 "$compose_environment")" \
    || fail "canonical Compose environment checksum could not be read"
  repository_environment_sha="$(checked_file_sha256 "$repository_environment")" \
    || fail "repository Compose environment checksum could not be read"
  [[ "$compose_environment_sha" == "$repository_environment_sha" ]] \
    || fail "canonical and scheduler Compose environments differ"
  production_password="$(read_unique_environment_value \
    "$compose_environment" POSTGRES_PASSWORD)" \
    || fail "production database owner credential could not be read"
  first_password="$(read_unique_environment_value \
    "$first_rehearsal_environment" POSTGRES_PASSWORD)" \
    || fail "first rehearsal database owner credential could not be read"
  second_password="$(read_unique_environment_value \
    "$second_rehearsal_environment" POSTGRES_PASSWORD)" \
    || fail "second rehearsal database owner credential could not be read"
  [[ "$production_password" =~ ^[a-f0-9]{64}$ \
    && "$first_password" =~ ^[a-f0-9]{64}$ \
    && "$second_password" =~ ^[a-f0-9]{64}$ \
    && "$production_password" != "$first_password" \
    && "$production_password" != "$second_password" \
    && "$first_password" != "$second_password" ]] \
    || fail "prepared database owner credentials are not independent"
  if [[ -e "$preparation_state" && ! -L "$preparation_state" ]]; then
    [[ "$production_password" == "$production_owner_password" \
      && "$first_password" == "$first_owner_password" \
      && "$second_password" == "$second_owner_password" ]] \
      || fail "prepared database owner credentials differ from the recovery journal"
  fi
  for environment_file in "$compose_environment" "$first_rehearsal_environment" \
    "$second_rehearsal_environment"; do
    assert_environment_value "$environment_file" DEMO_LOGIN_ENABLED true
    assert_environment_value "$environment_file" DEMO_WRITES_ENABLED true
    assert_environment_value "$environment_file" ACCOUNT_LOGIN_ENABLED false
    assert_environment_value "$environment_file" ACCOUNT_SIGNUP_ENABLED false
    assert_environment_value "$environment_file" AUTH_EMAIL_DELIVERY_ENABLED false
    assert_environment_value "$environment_file" SIGNUP_TURNSTILE_ENABLED false
    assert_environment_value "$environment_file" BUSINESS_WRITES_ENABLED false
    assert_environment_value "$environment_file" BANK_FEEDS_ENABLED false
    assert_environment_value "$environment_file" YAHOO_FX_ENABLED false
    assert_environment_value "$environment_file" DOCUMENT_GOOGLE_CLIENT_ID ""
    assert_environment_value "$environment_file" DOCUMENT_MICROSOFT_CLIENT_ID ""
    assert_environment_value "$environment_file" BACKUP_RCLONE_REMOTE ""
  done
  for environment_file in "$compose_environment" "$first_rehearsal_environment" \
    "$second_rehearsal_environment"; do
    case "$environment_file" in
      "$compose_environment") bundle_directory="$secret_directory" ;;
      "$first_rehearsal_environment") bundle_directory="$first_rehearsal_secrets" ;;
      "$second_rehearsal_environment") bundle_directory="$second_rehearsal_secrets" ;;
    esac
    for selected_key in AUTH_RESEND_API_KEY_FILE TURNSTILE_SECRET_KEY_FILE \
      DOCUMENT_GOOGLE_CLIENT_SECRET_FILE DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE \
      BACKUP_AGE_IDENTITY_FILE BACKUP_RCLONE_CONFIG_FILE \
      BACKUP_RECEIVER_SSH_PRIVATE_KEY_FILE BACKUP_RECEIVER_KNOWN_HOSTS_FILE \
      BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE RESTORE_DATABASE_PASSWORD_FILE; do
      expected_value="$bundle_directory/not-configured"
      assert_environment_value "$environment_file" "$selected_key" "$expected_value"
    done
  done
  generated_hashes=""
  for bundle_directory in "$secret_directory" \
    "$first_rehearsal_secrets" "$second_rehearsal_secrets"; do
    for selected_key in app-db-password auth-worker-db-password backup-db-password \
      organization-root-kek identity-secret; do
      generated_hash="$(checked_file_sha256 "$bundle_directory/$selected_key")" \
        || fail "generated secret checksum could not be read: $bundle_directory/$selected_key"
      generated_hashes+="$generated_hash"$'\n'
      (( generated_hash_count += 1 ))
    done
  done
  [[ "$generated_hash_count" == 15 ]] \
    || fail "generated secret checksum inventory is incomplete"
  generated_hashes="$(sort <<<"$generated_hashes")" \
    || fail "generated secret checksum inventory could not be sorted"
  duplicate_generated_hash="$(awk 'previous == $0 { print; exit } { previous = $0 }' \
    <<<"$generated_hashes")" \
    || fail "generated secret checksum inventory could not be inspected"
  [[ -z "$duplicate_generated_hash" ]] \
    || fail "production and rehearsal generated secrets are not independent"
}

render_and_verify_initial_configuration() {
  local rendered inert_rendered rehearsal_environment rehearsal_project rehearsal_port rehearsal_backup
  verify_prepared_configuration_content
  rendered="$(env -i "PATH=$clean_path" docker compose \
    --project-name business-finlynq \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    -f "$repository/docker-compose.yml" \
    -f "$repository/deploy/edge/docker-compose.external.yml" \
    --profile operations --profile auth-email --profile acceptance \
    config --format json)" \
    || fail "initial production Compose configuration could not be rendered"
  jq -e --arg revision "$revision" '
    .name == "business-finlynq" and
    .services.app.image == ("business-finlynq-app:" + $revision) and
    .services.app.environment.DEMO_LOGIN_ENABLED == "true" and
    .services.app.environment.DEMO_WRITES_ENABLED == "true" and
    .services.app.environment.ACCOUNT_LOGIN_ENABLED == "false" and
    .services.app.environment.ACCOUNT_SIGNUP_ENABLED == "false" and
    .services.app.environment.AUTH_EMAIL_DELIVERY_ENABLED == "false" and
    .services.app.environment.SIGNUP_TURNSTILE_ENABLED == "false" and
    .services.app.environment.BUSINESS_WRITES_ENABLED == "false" and
    .services.app.environment.BANK_FEEDS_ENABLED == "false" and
    .services.app.environment.YAHOO_FX_ENABLED == "false" and
    (.services | has("edge") | not) and
    .networks.business_finlynq_edge.external == true and
    .networks.business_finlynq_edge.name == "business_finlynq_edge" and
    .services.backup.environment.BACKUP_REQUIRE_OFFSITE == "false" and
    .services.verify_latest_backup.environment.BACKUP_REQUIRE_OFFSITE_MARKER == "false"
  ' <<<"$rendered" >/dev/null \
    || fail "initial production Compose gates or external-edge isolation are invalid"
  inert_rendered="$(env -i "PATH=$clean_path" docker compose \
    --project-name business-finlynq \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    -f "$repository/docker-compose.yml" \
    -f "$repository/deploy/edge/docker-compose.external.yml" \
    --profile external-edge-disabled config --format json)" \
    || fail "disabled local-edge Compose configuration could not be rendered"
  jq -e '
    .services.edge.profiles == ["external-edge-disabled"] and
    .services.edge.entrypoint == ["/bin/false"] and
    .services.edge.restart == "no" and
    .services.edge.network_mode == "none" and
    ((.services.edge.ports // []) | length) == 0 and
    ((.services.edge.volumes // []) | length) == 0 and
    ((.services.edge.networks // {}) | length) == 0 and
    ((.services.edge.depends_on // {}) | length) == 0 and
    .networks.business_finlynq_edge.external == true and
    .networks.business_finlynq_edge.name == "business_finlynq_edge"
  ' <<<"$inert_rendered" >/dev/null \
    || fail "external-edge overlay does not leave the local listener inert"
  for rehearsal_environment in "$first_rehearsal_environment" \
    "$second_rehearsal_environment"; do
    if [[ "$rehearsal_environment" == "$first_rehearsal_environment" ]]; then
      rehearsal_project=business-finlynq-rehearsal-config-a
      rehearsal_port=3310
      rehearsal_backup="$rehearsal_evidence_root/backups/first"
    else
      rehearsal_project=business-finlynq-rehearsal-config-b
      rehearsal_port=3311
      rehearsal_backup="$rehearsal_evidence_root/backups/second"
    fi
    rendered="$(env -i "PATH=$clean_path" "RELEASE_REHEARSAL_PROJECT=$rehearsal_project" \
      docker compose --project-name "$rehearsal_project" \
      --project-directory "$repository" --env-file "$rehearsal_environment" \
      -f "$repository/docker-compose.yml" \
      -f "$repository/deploy/release/docker-compose.rehearsal.yml" \
      --profile operations --profile auth-email --profile acceptance \
      config --format json)" \
      || fail "rehearsal Compose configuration could not be rendered"
    jq -e --arg revision "$revision" --arg project "$rehearsal_project" \
      --arg port "$rehearsal_port" --arg backup "$rehearsal_backup" '
      .name == $project and
      .services.app.image == ("business-finlynq-app:" + $revision) and
      ([.services.app.ports[] | select(.target == 3000) | .published] == [$port]) and
      .services.app.environment.APP_ORIGIN == ("http://127.0.0.1:" + $port) and
      .services.app.environment.DEMO_LOGIN_ENABLED == "true" and
      .services.app.environment.DEMO_WRITES_ENABLED == "true" and
      .services.app.environment.ACCOUNT_LOGIN_ENABLED == "false" and
      .services.app.environment.ACCOUNT_SIGNUP_ENABLED == "false" and
      .services.app.environment.BUSINESS_WRITES_ENABLED == "false" and
      .services.app.environment.BANK_FEEDS_ENABLED == "false" and
      .services.backup.environment.BACKUP_REQUIRE_OFFSITE == "false" and
      .services.verify_latest_backup.environment.BACKUP_REQUIRE_OFFSITE_MARKER == "false" and
      ([.volumes[].name, .networks[].name] |
        all(.[]; startswith($project + "-"))) and
      ([.services.backup.volumes[] | select(.target == "/backups") | .source] == [$backup])
    ' <<<"$rendered" >/dev/null \
      || fail "rehearsal isolation, gates, port, or backup path is invalid"
  done
}

prepare_new_configuration() {
  local repository_environment_temporary repository_environment_sha compose_environment_sha
  validate_recipient_file "$recipient_input"
  if [[ -e "$preparation_state" || -L "$preparation_state" ]]; then
    verify_preparation_state
    assert_empty_production_runtime
  else
    validate_new_configuration_boundary
    write_preparation_state
    verify_preparation_state
  fi
  create_protected_directories
  install_protected_external_edge_verifier
  cleanup_preparation_temporary_files

  prepare_secret_bundle "$secret_directory" "$recipient_input" "$recipient_target"
  prepare_secret_bundle "$first_rehearsal_secrets" "$recipient_input" \
    "$first_rehearsal_recipient"
  prepare_secret_bundle "$second_rehearsal_secrets" "$recipient_input" \
    "$second_rehearsal_recipient"
  write_compose_environment "$compose_environment" "$secret_directory" \
    "$recipient_target" "$backup_directory" 3100 \
    https://business.finlynq.com __Host-business_finlynq_session \
    business_finlynq external "$production_owner_password"
  write_compose_environment "$first_rehearsal_environment" "$first_rehearsal_secrets" \
    "$first_rehearsal_recipient" "$rehearsal_evidence_root/backups/first" 3310 \
    http://127.0.0.1:3310 business_finlynq_rehearsal_a_session \
    business_finlynq_rehearsal_a compose "$first_owner_password"
  write_compose_environment "$second_rehearsal_environment" "$second_rehearsal_secrets" \
    "$second_rehearsal_recipient" "$rehearsal_evidence_root/backups/second" 3311 \
    http://127.0.0.1:3311 business_finlynq_rehearsal_b_session \
    business_finlynq_rehearsal_b compose "$second_owner_password"
  write_operations_environment
  compose_environment_sha="$(checked_file_sha256 "$compose_environment")" \
    || fail "canonical Compose environment checksum could not be read"
  if [[ -e "$repository_environment" || -L "$repository_environment" ]]; then
    repository_environment_sha="$(checked_file_sha256 "$repository_environment")" \
      || fail "partially prepared repository environment checksum could not be read"
    [[ -f "$repository_environment" && ! -L "$repository_environment" \
      && "$(stat -c '%U:%G:%a' -- "$repository_environment")" == deploy:deploy:600 \
      && "$repository_environment_sha" == "$compose_environment_sha" ]] \
      || fail "partially prepared repository environment is unsafe or inconsistent"
  else
    # The staging name is intentionally covered by the repository's `.env*`
    # ignore rule, so a power loss before the atomic rename cannot make the
    # canonical checkout appear dirty before recovery can inspect it.
    repository_environment_temporary="$(mktemp "$repository/.env.initial.XXXXXX")"
    install -o root -g root -m 0600 -- "$compose_environment" \
      "$repository_environment_temporary"
    repository_environment_sha="$(checked_file_sha256 \
      "$repository_environment_temporary")" \
      || fail "repository environment staging checksum could not be read"
    [[ "$repository_environment_sha" == "$compose_environment_sha" ]] \
      || fail "repository environment staging copy is incomplete"
    chown deploy:deploy "$repository_environment_temporary"
    mv -- "$repository_environment_temporary" "$repository_environment"
    sync -f -- "$repository_environment"
  fi
  render_and_verify_initial_configuration
  write_install_state
  verify_install_state
  rm -- "$preparation_state"
  sync -f -- "$configuration_directory"
  unset production_owner_password first_owner_password second_owner_password
}

allocate_rehearsal_batch() {
  local base candidate counter suffix
  base="$(checked_compact_utc_timestamp)" \
    || fail "rehearsal batch timestamp could not be generated"
  for (( counter = 0; counter < 100; counter++ )); do
    printf -v suffix '%02d' "$counter"
    candidate="$base$suffix"
    if [[ ! -e "$rehearsal_evidence_root/$revision/rehearsal-a-$candidate" \
      && ! -L "$rehearsal_evidence_root/$revision/rehearsal-a-$candidate" \
      && ! -e "$rehearsal_evidence_root/$revision/rehearsal-b-$candidate" \
      && ! -L "$rehearsal_evidence_root/$revision/rehearsal-b-$candidate" \
      && ! -e "$rehearsal_configuration_directory/accepted-$candidate.json" \
      && ! -L "$rehearsal_configuration_directory/accepted-$candidate.json" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  fail "no unused rehearsal batch ID is available for the current UTC second"
}

verify_rehearsal_acceptance() {
  local batch_report batch_report_sha recorded_batch_report_sha
  [[ -f "$rehearsal_acceptance" && ! -L "$rehearsal_acceptance" \
    && "$(stat -c '%u:%g:%a' -- "$rehearsal_acceptance")" == 0:0:600 ]] \
    || fail "protected rehearsal acceptance receipt is unavailable"
  jq -e --arg revision "$revision" '
    type == "object" and
    keys == ["acceptedAt", "batchReport", "batchReportSha256", "product",
      "revision", "schemaVersion"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .revision == $revision and (.acceptedAt | type == "string") and
    (.batchReport | type == "string") and
    (.batchReportSha256 | test("^[a-f0-9]{64}$"))
  ' "$rehearsal_acceptance" >/dev/null \
    || fail "protected rehearsal acceptance receipt is invalid"
  batch_report="$(jq -r '.batchReport' "$rehearsal_acceptance")" \
    || fail "protected rehearsal batch report path could not be read"
  [[ "$batch_report" == "$rehearsal_configuration_directory"/accepted-*.json \
    && "$batch_report" != "$rehearsal_acceptance" \
    && -f "$batch_report" && ! -L "$batch_report" \
    && "$(stat -c '%u:%g:%a' -- "$batch_report")" == 0:0:600 ]] \
    || fail "rehearsal batch report path is unsafe"
  batch_report_sha="$(checked_file_sha256 "$batch_report")" \
    || fail "protected rehearsal batch report checksum could not be read"
  recorded_batch_report_sha="$(jq -r '.batchReportSha256' "$rehearsal_acceptance")" \
    || fail "recorded rehearsal batch report checksum could not be read"
  [[ "$batch_report_sha" == "$recorded_batch_report_sha" ]] \
    || fail "rehearsal batch report changed after acceptance"
  bash "$repository/deploy/production/run-initial-rehearsals.sh" \
    --revision "$revision" --host-lock-fd 8 --verify-report "$batch_report"
}

ensure_rehearsals_accepted() {
  local batch_id batch_report batch_report_sha accepted_at temporary
  if [[ -e "$rehearsal_acceptance" || -L "$rehearsal_acceptance" ]]; then
    verify_rehearsal_acceptance
    return 0
  fi
  batch_id="$(allocate_rehearsal_batch)"
  bash "$repository/deploy/production/run-initial-rehearsals.sh" \
    --revision "$revision" --host-lock-fd 8 --batch-id "$batch_id"
  batch_report="$rehearsal_configuration_directory/accepted-$batch_id.json"
  [[ -f "$batch_report" && ! -L "$batch_report" \
    && "$(stat -c '%u:%g:%a' -- "$batch_report")" == 0:0:600 ]] \
    || fail "new rehearsal batch report is unavailable"
  accepted_at="$(checked_utc_timestamp)" \
    || fail "rehearsal-acceptance timestamp could not be generated"
  batch_report_sha="$(checked_file_sha256 "$batch_report")" \
    || fail "rehearsal batch report checksum could not be read"
  temporary="$(mktemp "$rehearsal_configuration_directory/.accepted.XXXXXX")"
  jq -n --arg acceptedAt "$accepted_at" \
    --arg revision "$revision" --arg batchReport "$batch_report" \
    --arg batchReportSha256 "$batch_report_sha" '
    {schemaVersion: 1, product: "business-finlynq", acceptedAt: $acceptedAt,
      revision: $revision, batchReport: $batchReport,
      batchReportSha256: $batchReportSha256}
  ' >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$rehearsal_acceptance"
  sync -f -- "$rehearsal_acceptance"
  sync -f -- "$rehearsal_configuration_directory"
  verify_rehearsal_acceptance
}

allocate_initial_run_id() {
  local base candidate counter suffix timestamp
  timestamp="$(checked_compact_utc_timestamp)" \
    || fail "initial run timestamp could not be generated"
  base="initial-${revision:0:6}-$timestamp"
  for (( counter = 0; counter < 100; counter++ )); do
    printf -v suffix '%02d' "$counter"
    candidate="$base$suffix"
    if [[ ! -e "$release_evidence_root/$revision/$candidate" \
      && ! -L "$release_evidence_root/$revision/$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  fail "no unused initial run ID is available for the current UTC second"
}

verify_protected_evidence_inventory() {
  local evidence_directory="$1" checksum_file="$1/SHA256SUMS"
  local allowed_uninventoried="${2:-}"
  local digest relative extra target actual_file unexpected inventory_count=0 actual_count=0
  local allowed_count=0
  local actual_file_list
  local -a actual_files=()
  local -A recorded_paths=()
  [[ -z "$allowed_uninventoried" \
    || "$allowed_uninventoried" == 90-release-complete.json \
    || "$allowed_uninventoried" == .90-release-complete.json.partial ]] \
    || fail "unsupported uninventoried release evidence exception"
  [[ -d "$evidence_directory" && ! -L "$evidence_directory" \
    && "$(readlink -f -- "$evidence_directory")" == "$evidence_directory" \
    && "$(stat -c '%u:%a:%h' -- "$evidence_directory")" == 0:700:2 \
    && -f "$checksum_file" && ! -L "$checksum_file" \
    && "$(stat -c '%u:%a:%h' -- "$checksum_file")" == 0:600:1 ]] \
    || fail "protected release evidence directory or checksum inventory is unsafe"
  while read -r digest relative extra; do
    [[ -z "$extra" && "$digest" =~ ^[a-f0-9]{64}$ \
      && "$relative" =~ ^\./[0-9A-Za-z][0-9A-Za-z._-]*$ \
      && "$relative" != ./SHA256SUMS \
      && ! -v "recorded_paths[$relative]" ]] \
      || fail "release evidence checksum inventory contains an unsafe entry"
    target="$evidence_directory/${relative#./}"
    [[ -f "$target" && ! -L "$target" \
      && "$(stat -c '%u:%a:%h' -- "$target")" == 0:600:1 ]] \
      || fail "inventoried release evidence file is unsafe: $relative"
    recorded_paths["$relative"]="true"
    (( inventory_count += 1 ))
  done <"$checksum_file"
  (( inventory_count > 0 )) || fail "release evidence checksum inventory is empty"
  unexpected="$(find "$evidence_directory" -mindepth 1 -maxdepth 1 \
    ! -type f -print -quit)" \
    || fail "release evidence directory could not be inspected"
  [[ -z "$unexpected" ]] || fail "release evidence contains a non-regular entry"
  actual_file_list="$(mktemp)"
  if ! find "$evidence_directory" -mindepth 1 -maxdepth 1 -type f \
    -print0 >"$actual_file_list"; then
    rm -f -- "$actual_file_list"
    fail "release evidence files could not be enumerated"
  fi
  mapfile -d '' -t actual_files <"$actual_file_list"
  rm -- "$actual_file_list"
  for actual_file in "${actual_files[@]}"; do
    [[ "$actual_file" == "$checksum_file" ]] && continue
    relative="./${actual_file##*/}"
    if [[ -n "$allowed_uninventoried" \
      && "${actual_file##*/}" == "$allowed_uninventoried" ]]; then
      [[ -f "$actual_file" && ! -L "$actual_file" \
        && "$(stat -c '%u:%a:%h' -- "$actual_file")" == 0:600:1 ]] \
        || fail "uninventoried terminal evidence staging file is unsafe"
      (( allowed_count += 1 ))
      continue
    fi
    [[ -v "recorded_paths[$relative]" ]] \
      || fail "release evidence contains a file omitted from SHA256SUMS: $relative"
    (( actual_count += 1 ))
  done
  [[ "$actual_count" == "$inventory_count" ]] \
    || fail "release evidence checksum inventory is not an exact file set"
  if [[ -n "$allowed_uninventoried" ]]; then
    [[ "$allowed_count" == 1 ]] \
      || fail "the terminal inventory exception is not an exact single file"
  fi
  (
    cd -- "$evidence_directory"
    sha256sum --check --strict --quiet SHA256SUMS
  ) || fail "release evidence failed checksum verification"
}

verify_pristine_initial_failure() {
  local failed_run_id="$1"
  local failed_evidence="$release_evidence_root/$revision/$failed_run_id"
  local failure_stage required_record resume_ready=true
  verify_protected_evidence_inventory "$failed_evidence"
  for required_record in 99-failure.json; do
    [[ -f "$failed_evidence/$required_record" \
      && ! -L "$failed_evidence/$required_record" ]] \
      || fail "pristine retry evidence is missing $required_record"
  done
  [[ ! -e "$failed_evidence/90-release-complete.json" \
    && ! -L "$failed_evidence/90-release-complete.json" ]] \
    || fail "an accepted initial run cannot authorize a pristine retry"
  jq -e --arg revision "$revision" --arg runId "$failed_run_id" '
    .schemaVersion == 1 and .product == "business-finlynq" and
    .status == "failed" and .mode == "initial" and
    .revision == $revision and .runId == $runId and
    (.initialTimersRemainDisabled | type == "boolean") and
    (.stage == "materialize-candidate-git-tree" or
      .stage == "snapshot-release-environments" or
      .stage == "compose-contract" or
      .stage == "initial-fresh-state-contract" or
      .stage == "candidate-image-build" or
      .stage == "candidate-image-content-verification" or
      .stage == "capture-rollback-artifact")
  ' "$failed_evidence/99-failure.json" >/dev/null \
    || fail "failure is not at an acknowledged pre-resource initial stage"
  failure_stage="$(jq -r '.stage' "$failed_evidence/99-failure.json")"
  if [[ -e "$failed_evidence/00-release-plan.json" \
    || -L "$failed_evidence/00-release-plan.json" ]]; then
    [[ -f "$failed_evidence/00-release-plan.json" \
      && ! -L "$failed_evidence/00-release-plan.json" ]] \
      || fail "pristine retry plan is unsafe"
    jq -e --arg revision "$revision" --arg runId "$failed_run_id" '
      .schemaVersion == 1 and .product == "business-finlynq" and
      .status == "started" and .mode == "initial" and
      .revision == $revision and .runId == $runId
    ' "$failed_evidence/00-release-plan.json" >/dev/null \
      || fail "pristine retry plan identity is invalid"
  else
    case "$failure_stage" in
      materialize-candidate-git-tree|snapshot-release-environments|compose-contract) ;;
      *) fail "post-plan pristine retry evidence is missing its release plan" ;;
    esac
  fi
  for required_record in 06-initial-inputs.json 11-images.json \
    12-rollback-artifact.json; do
    [[ -f "$failed_evidence/$required_record" \
      && ! -L "$failed_evidence/$required_record" ]] || resume_ready=false
  done
  [[ "$resume_ready" == false ]] \
    || fail "failed run has complete resume evidence; use --resume-initial instead"
  assert_empty_production_runtime
  # The first runner plan is intentionally published only after the immutable
  # tree and Compose contract have been captured. For earlier failures the
  # protected 99 record is the exact run identity; current scheduler posture
  # is therefore re-established and attested independently here.
  quiesce_bootstrap_schedulers
  verify_all_bootstrap_automation_disabled
  printf 'Validated pristine pre-resource failure %s at %s.\n' \
    "$failed_run_id" "$failure_stage"
}

authorize_pristine_retry() {
  local failed_run_id="$1" retry_directory retry_receipt temporary new_run_id
  local retry_temporary_list prior_inventory_sha install_state_sha authorized_at
  local -a retry_temporary_files=()
  retry_directory="$pristine_retry_root/$revision"
  retry_receipt="$retry_directory/$failed_run_id.json"
  install -d -o root -g root -m 0700 -- "$pristine_retry_root" "$retry_directory"
  [[ "$(stat -c '%u:%g:%a' -- "$pristine_retry_root")" == 0:0:700 \
    && "$(stat -c '%u:%g:%a' -- "$retry_directory")" == 0:0:700 ]] \
    || fail "pristine retry authorization directory is unsafe"
  retry_temporary_list="$(mktemp)"
  if ! find "$retry_directory" -mindepth 1 -maxdepth 1 \
    -name '.retry.*' -print0 >"$retry_temporary_list"; then
    rm -f -- "$retry_temporary_list"
    fail "pristine retry temporary receipts could not be enumerated"
  fi
  mapfile -d '' -t retry_temporary_files <"$retry_temporary_list"
  rm -- "$retry_temporary_list"
  for temporary in "${retry_temporary_files[@]}"; do
    [[ -f "$temporary" && ! -L "$temporary" \
      && "$(stat -c '%u:%g:%a:%h' -- "$temporary")" == 0:0:600:1 ]] \
      || fail "pristine retry temporary receipt is unsafe"
    rm -- "$temporary"
  done
  prior_inventory_sha="$(checked_file_sha256 \
    "$release_evidence_root/$revision/$failed_run_id/SHA256SUMS")" \
    || fail "failed initial checksum inventory could not be read"
  install_state_sha="$(checked_file_sha256 "$install_state")" \
    || fail "initial install-state checksum could not be read"
  if [[ -e "$retry_receipt" || -L "$retry_receipt" ]]; then
    [[ -f "$retry_receipt" && ! -L "$retry_receipt" \
      && "$(stat -c '%u:%g:%a:%h' -- "$retry_receipt")" == 0:0:600:1 ]] \
      || fail "pristine retry authorization receipt is unsafe"
    jq -e --arg revision "$revision" --arg failedRunId "$failed_run_id" \
      --arg priorInventorySha256 "$prior_inventory_sha" \
      --arg installStateSha256 "$install_state_sha" '
      type == "object" and
      keys == ["authorizedAt", "authorizedRunId", "failedRunId",
        "installStateSha256", "priorInventorySha256", "product", "revision",
        "schemaVersion", "status"] and
      .schemaVersion == 1 and .product == "business-finlynq" and
      .status == "authorized" and .revision == $revision and
      .failedRunId == $failedRunId and
      .priorInventorySha256 == $priorInventorySha256 and
      .installStateSha256 == $installStateSha256 and
      (.authorizedAt | type == "string") and
      (.authorizedRunId | test("^initial-[a-z0-9][a-z0-9._-]{2,22}$"))
    ' "$retry_receipt" >/dev/null \
      || fail "pristine retry authorization no longer matches protected state"
    new_run_id="$(jq -r '.authorizedRunId' "$retry_receipt")"
  else
    new_run_id="$(allocate_initial_run_id)"
    authorized_at="$(checked_utc_timestamp)" \
      || fail "pristine-retry authorization timestamp could not be generated"
    temporary="$(mktemp "$retry_directory/.retry.XXXXXX")"
    jq -n --arg authorizedAt "$authorized_at" \
      --arg revision "$revision" --arg failedRunId "$failed_run_id" \
      --arg authorizedRunId "$new_run_id" \
      --arg priorInventorySha256 "$prior_inventory_sha" \
      --arg installStateSha256 "$install_state_sha" '
      {schemaVersion: 1, product: "business-finlynq", status: "authorized",
        authorizedAt: $authorizedAt, revision: $revision,
        failedRunId: $failedRunId, authorizedRunId: $authorizedRunId,
        priorInventorySha256: $priorInventorySha256,
        installStateSha256: $installStateSha256}
    ' >"$temporary"
    chown root:root "$temporary"
    chmod 0600 "$temporary"
    mv -- "$temporary" "$retry_receipt"
    sync -f -- "$retry_receipt"
    sync -f -- "$retry_directory"
  fi
  [[ ! -e "$release_evidence_root/$revision/$new_run_id" \
    && ! -L "$release_evidence_root/$revision/$new_run_id" ]] \
    || fail "authorized pristine retry run already has evidence; review that run explicitly"
  printf '%s' "$new_run_id"
}

verify_contained_initial_terminal_evidence_records() {
  local initial_run_id="$1" initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  local terminal_record="${2:-$initial_evidence/90-release-complete.json}"
  local expected_app_image browser_log_sha compose_environment_sha operations_environment_sha
  local secret_records secret_record secret_path secret_sha secret_bytes
  local secret_uid secret_gid_value secret_mode secret_count=0 required_record
  local -A expected_secret_paths=()
  local -A seen_secret_paths=()
  for required_record in 06-initial-inputs.json 11-images.json \
    14-evidence-scanner.json 70-browser-acceptance.log \
    85-contained-initial-deferrals.json SHA256SUMS; do
    [[ -f "$initial_evidence/$required_record" \
      && ! -L "$initial_evidence/$required_record" ]] \
      || fail "accepted initial evidence is missing $required_record"
  done
  [[ -f "$terminal_record" && ! -L "$terminal_record" \
    && "$(stat -c '%u:%a:%h' -- "$terminal_record")" == 0:600:1 ]] \
    || fail "accepted initial terminal record is unavailable or unsafe"
  expected_app_image="$(jq -er '.images[] | select(.name == "app") | .imageId' \
    "$initial_evidence/11-images.json")" \
    || fail "accepted terminal evidence has no app image identity"
  [[ "$expected_app_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail "accepted terminal evidence has an invalid app image identity"
  browser_log_sha="$(checked_file_sha256 \
    "$initial_evidence/70-browser-acceptance.log")" \
    || fail "accepted browser log checksum could not be read"
  jq -e --arg revision "$revision" --arg runId "$initial_run_id" \
    --arg candidateAppImageId "$expected_app_image" \
    --arg browserLogSha256 "$browser_log_sha" '
    type == "object" and
    keys == ["browserAcceptancePassed", "browserLogSha256", "candidateAppImageId",
      "completedAt", "containedInitial", "databaseRollback",
      "localEncryptedBackupVerified", "mode", "offsiteBackupDeferred",
      "postBootstrapAccountingEvidenceVerified", "preTrafficDatabaseContractVerified",
      "previousAppImageId", "product", "revision", "runId",
      "schedulerActivationDeferred", "schemaVersion", "status"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .status == "accepted" and .mode == "initial" and
    .revision == $revision and .runId == $runId and
    (.completedAt | type == "string") and
    .candidateAppImageId == $candidateAppImageId and .previousAppImageId == null and
    .preTrafficDatabaseContractVerified == true and
    .postBootstrapAccountingEvidenceVerified == true and
    .browserAcceptancePassed == true and .browserLogSha256 == $browserLogSha256 and
    .databaseRollback == "forward-repair-only" and
    .containedInitial == true and .localEncryptedBackupVerified == true and
    .offsiteBackupDeferred == true and .schedulerActivationDeferred == true
  ' "$terminal_record" >/dev/null \
    || fail "initial completion evidence does not retain the contained posture"
  jq -e --arg revision "$revision" '
    type == "object" and
    keys == ["activationRequiresReviewedRelease", "localEncryptedBackup",
      "offsiteBackup", "product", "recordedAt", "revision", "scheduledExecution",
      "scheduler", "schemaVersion", "timersActive", "timersEnabled",
      "timersInstalled"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .revision == $revision and .scheduler == "systemd" and
    (.recordedAt | type == "string") and
    .timersInstalled == true and .timersEnabled == false and
    .timersActive == false and .scheduledExecution == "deferred" and
    .offsiteBackup == "deferred" and .localEncryptedBackup == "verified" and
    .activationRequiresReviewedRelease == true
  ' "$initial_evidence/85-contained-initial-deferrals.json" >/dev/null \
    || fail "initial deferral evidence is missing or invalid"

  compose_environment_sha="$(checked_file_sha256 "$compose_environment")" \
    || fail "canonical Compose environment checksum could not be read"
  operations_environment_sha="$(checked_file_sha256 "$operations_environment")" \
    || fail "canonical operations environment checksum could not be read"
  jq -e --arg revision "$revision" \
    --arg composeEnvironmentSha256 "$compose_environment_sha" \
    --arg operationsEnvironmentSha256 "$operations_environment_sha" '
    type == "object" and
    keys == ["composeEnvironmentSha256", "operationsEnvironmentSha256", "product",
      "revision", "schemaVersion", "secrets"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .revision == $revision and
    .composeEnvironmentSha256 == $composeEnvironmentSha256 and
    .operationsEnvironmentSha256 == $operationsEnvironmentSha256 and
    (.secrets | type == "array" and length == 7)
  ' "$initial_evidence/06-initial-inputs.json" >/dev/null \
    || fail "accepted initial inputs do not match the protected configuration"
  for secret_path in "$secret_directory/app-db-password" \
    "$secret_directory/auth-worker-db-password" "$secret_directory/backup-db-password" \
    "$secret_directory/organization-root-kek" "$secret_directory/identity-secret" \
    "$placeholder" "$recipient_target"; do
    expected_secret_paths["$secret_path"]="true"
  done
  secret_records="$(jq -c '.secrets[]' \
    "$initial_evidence/06-initial-inputs.json")" \
    || fail "accepted initial secret attestations could not be read"
  while IFS= read -r secret_record; do
    secret_path="$(jq -er '.path' <<<"$secret_record")" \
      || fail "accepted initial secret attestation has no path"
    [[ -v "expected_secret_paths[$secret_path]" \
      && ! -v "seen_secret_paths[$secret_path]" \
      && -f "$secret_path" && ! -L "$secret_path" ]] \
      || fail "accepted initial secret attestation has an unsafe or duplicate path"
    IFS='|' read -r secret_uid secret_gid_value secret_mode secret_bytes \
      <<<"$(stat -c '%u|%g|%a|%s' -- "$secret_path")"
    secret_sha="$(checked_file_sha256 "$secret_path")" \
      || fail "accepted initial secret checksum could not be read"
    [[ "$secret_uid" =~ ^[0-9]+$ && "$secret_gid_value" =~ ^[0-9]+$ \
      && "$secret_mode" =~ ^[0-7]{3,4}$ && "$secret_bytes" =~ ^[0-9]+$ \
      && "$secret_sha" =~ ^[a-f0-9]{64}$ ]] \
      || fail "accepted initial secret material returned invalid live metadata"
    jq -e --arg path "$secret_path" --arg sha256 "$secret_sha" \
      --argjson ownerUid "$secret_uid" --argjson groupGid "$secret_gid_value" \
      --arg mode "$secret_mode" --argjson bytes "$secret_bytes" '
      type == "object" and
      keys == ["bytes", "groupGid", "mode", "ownerUid", "path", "sha256"] and
      .path == $path and .sha256 == $sha256 and .ownerUid == $ownerUid and
      .groupGid == $groupGid and .mode == $mode and .bytes == $bytes
    ' <<<"$secret_record" >/dev/null \
      || fail "accepted initial secret material differs from its sealed attestation"
    seen_secret_paths["$secret_path"]="true"
    (( secret_count += 1 ))
  done <<<"$secret_records"
  [[ "$secret_count" == 7 ]] \
    || fail "accepted initial secret attestation set is incomplete"
}

verify_contained_initial_terminal_evidence() {
  local initial_run_id="$1"
  local initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  verify_protected_evidence_inventory "$initial_evidence"
  verify_contained_initial_terminal_evidence_records "$initial_run_id"
}

refresh_accepted_initial_inventory() {
  local initial_evidence="$1"
  local temporary="$initial_evidence/.SHA256SUMS.partial"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] \
    || fail "accepted initial checksum staging path was not clean"
  if ! (
    cd -- "$initial_evidence" || exit 1
    find . -maxdepth 1 -type f ! -name SHA256SUMS \
      ! -name .SHA256SUMS.partial \
      ! -name .90-release-complete.json.partial \
      ! -name .99-failure.json.partial -print0 \
      | sort -z \
      | xargs -0 -r sha256sum >.SHA256SUMS.partial
  ); then
    rm -f -- "$temporary"
    fail "accepted initial checksum inventory could not be rebuilt"
  fi
  chmod 0600 -- "$temporary" \
    || fail "accepted initial checksum staging permissions could not be set"
  sync -f -- "$temporary" \
    || fail "accepted initial checksum staging file could not be synchronized"
  mv -f -- "$temporary" "$initial_evidence/SHA256SUMS" \
    || fail "accepted initial checksum inventory could not be published"
  sync -f -- "$initial_evidence/SHA256SUMS" \
    || fail "accepted initial checksum inventory could not be synchronized"
  sync -f -- "$initial_evidence" \
    || fail "accepted initial evidence directory could not be synchronized"
}

write_recovered_initial_terminal_record() {
  local initial_run_id="$1" terminal_record="$2"
  local initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  local expected_app_image browser_log_sha completed_at
  expected_app_image="$(jq -er '.images[] | select(.name == "app") | .imageId' \
    "$initial_evidence/11-images.json")" \
    || fail "accepted app image ID is unavailable for terminal publication recovery"
  [[ "$expected_app_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail "accepted app image ID is invalid for terminal publication recovery"
  browser_log_sha="$(checked_file_sha256 \
    "$initial_evidence/70-browser-acceptance.log")" \
    || fail "browser log checksum could not be read for terminal publication recovery"
  completed_at="$(checked_utc_timestamp)" \
    || fail "terminal publication recovery timestamp could not be generated"
  jq -n --arg completedAt "$completed_at" --arg revision "$revision" \
    --arg runId "$initial_run_id" --arg candidateAppImageId "$expected_app_image" \
    --arg browserLogSha256 "$browser_log_sha" '
      {schemaVersion: 1, product: "business-finlynq", status: "accepted",
       completedAt: $completedAt, mode: "initial", revision: $revision, runId: $runId,
       candidateAppImageId: $candidateAppImageId, previousAppImageId: null,
       preTrafficDatabaseContractVerified: true,
       postBootstrapAccountingEvidenceVerified: true,
       browserAcceptancePassed: true, browserLogSha256: $browserLogSha256,
       databaseRollback: "forward-repair-only", containedInitial: true,
       localEncryptedBackupVerified: true, offsiteBackupDeferred: true,
       schedulerActivationDeferred: true}
    ' >"$terminal_record" \
    || fail "accepted initial terminal record could not be recovered"
  chmod 0600 -- "$terminal_record" \
    || fail "recovered terminal record permissions could not be set"
  sync -f -- "$terminal_record" \
    || fail "recovered terminal record could not be synchronized"
}

recover_accepted_terminal_inventory_gap() {
  local initial_run_id="$1"
  local initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  local checksum_file="$initial_evidence/SHA256SUMS"
  local terminal_record="$initial_evidence/90-release-complete.json"
  local terminal_temporary="$initial_evidence/.90-release-complete.json.partial"
  local checksum_temporary="$initial_evidence/.SHA256SUMS.partial"
  local terminal_inventory_count

  if [[ -e "$checksum_temporary" || -L "$checksum_temporary" ]]; then
    [[ -f "$checksum_temporary" && ! -L "$checksum_temporary" \
      && "$(stat -c '%u:%a:%h' -- "$checksum_temporary")" == 0:600:1 ]] \
      || fail "terminal-recovery checksum staging path is unsafe"
    rm -- "$checksum_temporary"
    sync -f -- "$initial_evidence" \
      || fail "terminal-recovery checksum cleanup could not be synchronized"
  fi
  terminal_inventory_count="$(awk '$2 == "./90-release-complete.json" { count++ }
    END { print count + 0 }' "$checksum_file")" \
    || fail "terminal acceptance inventory could not be inspected"
  [[ "$terminal_inventory_count" =~ ^[0-9]+$ ]] \
    || fail "terminal acceptance inventory count is invalid"
  if [[ "$terminal_inventory_count" == 1 ]]; then
    [[ -f "$terminal_record" && ! -L "$terminal_record" \
      && ! -e "$terminal_temporary" && ! -L "$terminal_temporary" ]] \
      || fail "inventoried terminal acceptance files are inconsistent"
    return 0
  fi
  [[ "$terminal_inventory_count" == 0 ]] \
    || fail "terminal acceptance inventory contains duplicate records"

  if [[ -e "$terminal_record" || -L "$terminal_record" ]]; then
    [[ ! -e "$terminal_temporary" && ! -L "$terminal_temporary" ]] \
      || fail "terminal acceptance has both published and staged records"
    verify_protected_evidence_inventory "$initial_evidence" \
      90-release-complete.json
    verify_contained_initial_terminal_evidence_records "$initial_run_id"
    wrapper_stop_app_on_failure="true"
  else
    [[ -f "$terminal_temporary" && ! -L "$terminal_temporary" ]] \
      || fail "accepted initial has neither an inventoried nor staged terminal record"
    verify_protected_evidence_inventory "$initial_evidence" \
      .90-release-complete.json.partial
    # A power loss can interrupt the small staging write. Its protected fixed
    # path proves the runner reached terminal publication; rebuild its content
    # from the already-inventoried image and browser evidence before promotion.
    write_recovered_initial_terminal_record "$initial_run_id" "$terminal_temporary"
    verify_contained_initial_terminal_evidence_records \
      "$initial_run_id" "$terminal_temporary"
    wrapper_stop_app_on_failure="true"
    mv -- "$terminal_temporary" "$terminal_record" \
      || fail "recovered terminal record could not be published atomically"
    sync -f -- "$initial_evidence" \
      || fail "recovered terminal record directory entry could not be synchronized"
  fi
  refresh_accepted_initial_inventory "$initial_evidence"
  verify_contained_initial_terminal_evidence "$initial_run_id"
}

verify_install_completion_for_run() {
  local initial_run_id="$1" initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  local evidence_inventory_sha install_state_sha rehearsal_acceptance_sha
  [[ -f "$install_completion" && ! -L "$install_completion" \
    && "$(stat -c '%u:%g:%a:%h' -- "$install_completion")" == 0:0:600:1 ]] \
    || fail "protected initial installation completion is unsafe"
  evidence_inventory_sha="$(checked_file_sha256 "$initial_evidence/SHA256SUMS")" \
    || fail "accepted initial checksum inventory could not be read"
  install_state_sha="$(checked_file_sha256 "$install_state")" \
    || fail "initial install-state checksum could not be read"
  rehearsal_acceptance_sha="$(checked_file_sha256 "$rehearsal_acceptance")" \
    || fail "rehearsal-acceptance checksum could not be read"
  jq -e --arg revision "$revision" --arg initialRunId "$initial_run_id" \
    --arg initialEvidenceDirectory "$initial_evidence" \
    --arg initialEvidenceInventorySha256 "$evidence_inventory_sha" \
    --arg installStateSha256 "$install_state_sha" \
    --arg rehearsalAcceptance "$rehearsal_acceptance" \
    --arg rehearsalAcceptanceSha256 "$rehearsal_acceptance_sha" '
    type == "object" and
    keys == ["completedAt", "containedInitialPosture", "developmentDeploymentEnabled",
      "initialEvidenceDirectory", "initialEvidenceInventorySha256", "initialRunId",
      "installStateSha256", "operationTimersEnabled", "product",
      "productionContinuousDeploymentEnabled", "productionContinuousDeploymentInstalled",
      "rehearsalAcceptance", "rehearsalAcceptanceSha256", "revision", "schemaVersion",
      "status"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .status == "accepted" and (.completedAt | type == "string") and
    .revision == $revision and .initialRunId == $initialRunId and
    .initialEvidenceDirectory == $initialEvidenceDirectory and
    .initialEvidenceInventorySha256 == $initialEvidenceInventorySha256 and
    .installStateSha256 == $installStateSha256 and
    .rehearsalAcceptance == $rehearsalAcceptance and
    .rehearsalAcceptanceSha256 == $rehearsalAcceptanceSha256 and
    .containedInitialPosture == true and .operationTimersEnabled == false and
    .productionContinuousDeploymentInstalled == false and
    .productionContinuousDeploymentEnabled == false and
    .developmentDeploymentEnabled == false
  ' "$install_completion" >/dev/null \
    || fail "initial installation completion differs from the accepted protected state"
}

write_install_completion() {
  local initial_run_id="$1" initial_evidence="$release_evidence_root/$revision/$initial_run_id"
  local temporary completed_at evidence_inventory_sha install_state_sha
  local rehearsal_acceptance_sha
  verify_contained_initial_terminal_evidence "$initial_run_id"
  if [[ -e "$install_completion" || -L "$install_completion" ]]; then
    verify_install_completion_for_run "$initial_run_id"
    sync -f -- "$install_completion" \
      || fail "existing initial installation completion could not be synchronized"
    sync -f -- "$configuration_directory" \
      || fail "initial configuration directory could not be synchronized"
    return 0
  fi
  completed_at="$(checked_utc_timestamp)" \
    || fail "initial-completion timestamp could not be generated"
  evidence_inventory_sha="$(checked_file_sha256 "$initial_evidence/SHA256SUMS")" \
    || fail "accepted initial checksum inventory could not be read"
  install_state_sha="$(checked_file_sha256 "$install_state")" \
    || fail "initial install-state checksum could not be read"
  rehearsal_acceptance_sha="$(checked_file_sha256 "$rehearsal_acceptance")" \
    || fail "rehearsal-acceptance checksum could not be read"
  temporary="$(mktemp "$configuration_directory/.initial-install-complete.XXXXXX")"
  jq -n \
    --arg completedAt "$completed_at" \
    --arg revision "$revision" --arg initialRunId "$initial_run_id" \
    --arg initialEvidenceDirectory "$initial_evidence" \
    --arg initialEvidenceInventorySha256 "$evidence_inventory_sha" \
    --arg installStateSha256 "$install_state_sha" \
    --arg rehearsalAcceptance "$rehearsal_acceptance" \
    --arg rehearsalAcceptanceSha256 "$rehearsal_acceptance_sha" '
    {schemaVersion: 1, product: "business-finlynq", status: "accepted",
      completedAt: $completedAt, revision: $revision,
      initialRunId: $initialRunId,
      initialEvidenceDirectory: $initialEvidenceDirectory,
      initialEvidenceInventorySha256: $initialEvidenceInventorySha256,
      installStateSha256: $installStateSha256,
      rehearsalAcceptance: $rehearsalAcceptance,
      rehearsalAcceptanceSha256: $rehearsalAcceptanceSha256,
      containedInitialPosture: true,
      operationTimersEnabled: false,
      productionContinuousDeploymentInstalled: false,
      productionContinuousDeploymentEnabled: false,
      developmentDeploymentEnabled: false}
  ' >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$install_completion"
  sync -f -- "$install_completion" \
    || fail "initial installation completion could not be synchronized"
  sync -f -- "$configuration_directory" \
    || fail "initial configuration directory could not be synchronized"
  verify_install_completion_for_run "$initial_run_id"
}

run_initial_release() {
  local prior_run_id="$1" requested_run_id="${2:-}" new_run_id
  if [[ -n "$requested_run_id" ]]; then
    [[ "$requested_run_id" =~ ^initial-[a-z0-9][a-z0-9._-]{2,22}$ \
      && ! -e "$release_evidence_root/$revision/$requested_run_id" \
      && ! -L "$release_evidence_root/$revision/$requested_run_id" ]] \
      || fail "requested initial run ID is unsafe or already used"
    new_run_id="$requested_run_id"
  else
    new_run_id="$(allocate_initial_run_id)"
  fi
  initial_wrapper_active="true"
  wrapper_stop_app_on_failure="true"
  export RELEASE_EXECUTION_ACK="initial:$revision:$new_run_id"
  if [[ -n "$prior_run_id" ]]; then
    export INITIAL_RESUME_ACK="resume:$revision:$prior_run_id:$new_run_id"
    bash "$repository/deploy/release/run-release.sh" \
      --mode initial --revision "$revision" \
      --environment "$compose_environment" \
      --operations-environment "$operations_environment" \
      --evidence-root "$release_evidence_root" \
      --run-id "$new_run_id" --scheduler systemd \
      --resume-initial "$prior_run_id" --host-lock-fd 8
    unset INITIAL_RESUME_ACK
  else
    bash "$repository/deploy/release/run-release.sh" \
      --mode initial --revision "$revision" \
      --environment "$compose_environment" \
      --operations-environment "$operations_environment" \
      --evidence-root "$release_evidence_root" \
      --run-id "$new_run_id" --scheduler systemd --host-lock-fd 8
  fi
  unset RELEASE_EXECUTION_ACK
  "$external_edge_verifier_target" --scope full
  verify_live_accepted_initial_runtime \
    "$release_evidence_root/$revision/$new_run_id"
  verify_all_bootstrap_automation_disabled
  for selected_path in \
    /etc/systemd/system/business-finlynq-continuous-deployment.service \
    /etc/systemd/system/business-finlynq-continuous-deployment.timer; do
    assert_path_absent "$selected_path" "production continuous-deployment unit"
  done
  write_install_completion "$new_run_id"
  wrapper_stop_app_on_failure="false"
  initial_wrapper_active="false"
  printf 'Contained initial production accepted. Completion: %s\n' "$install_completion"
}

run_fresh_installed_oneshot() {
  local service_name="$1" previous_start previous_invocation
  local current_start current_exit current_invocation result main_status
  case "$service_name" in
    business-finlynq-accounting-evidence.service|business-finlynq-monitor.service) ;;
    *) fail "unsupported finalization one-shot service: $service_name" ;;
  esac
  previous_start="$(systemctl show --property=ExecMainStartTimestampMonotonic \
    --value "$service_name")" \
    || fail "could not inspect the previous $service_name invocation"
  [[ "$previous_start" =~ ^[0-9]+$ ]] \
    || fail "$service_name returned an invalid previous invocation timestamp"
  previous_invocation="$(systemctl show --property=InvocationID --value "$service_name")" \
    || fail "could not inspect the previous $service_name InvocationID"
  [[ -z "$previous_invocation" || "$previous_invocation" =~ ^[a-f0-9]{32}$ ]] \
    || fail "$service_name returned an invalid previous InvocationID"
  systemctl start "$service_name" \
    || fail "$service_name failed during accepted-initial finalization"
  current_start="$(systemctl show --property=ExecMainStartTimestampMonotonic \
    --value "$service_name")" \
    || fail "could not inspect the new $service_name start"
  current_exit="$(systemctl show --property=ExecMainExitTimestampMonotonic \
    --value "$service_name")" \
    || fail "could not inspect the new $service_name exit"
  current_invocation="$(systemctl show --property=InvocationID --value "$service_name")" \
    || fail "could not inspect the new $service_name InvocationID"
  result="$(systemctl show --property=Result --value "$service_name")" \
    || fail "could not inspect the new $service_name result"
  main_status="$(systemctl show --property=ExecMainStatus --value "$service_name")" \
    || fail "could not inspect the new $service_name exit status"
  [[ "$current_start" =~ ^[1-9][0-9]*$ && "$current_start" != "$previous_start" \
    && "$current_exit" =~ ^[1-9][0-9]*$ && "$current_exit" -gt "$current_start" \
    && "$current_invocation" =~ ^[a-f0-9]{32}$ \
    && "$current_invocation" != "$previous_invocation" \
    && "$result" == success && "$main_status" == 0 ]] \
    || fail "$service_name did not complete one fresh successful invocation"
}

verify_live_accepted_initial_runtime() {
  local accepted_evidence="$1" project_container_output container_id inspect_json service
  local expected_app_image expected_database_image expected_scanner_image
  local -A service_containers=()
  jq -e --arg revision "$revision" '
    .schemaVersion == 1 and
    (.pinnedComposeConfigurationSha256 | test("^[a-f0-9]{64}$")) and
    (.images | type == "array" and length == 6) and
    ([.images[].name] | sort) ==
      ["acceptance", "app", "authWorker", "database", "migrator", "operations"] and
    all(.images[];
      (.imageId | test("^sha256:[a-f0-9]{64}$")) and
      .ociRevision == $revision and
      .reference == ("business-finlynq-" +
        (if .name == "authWorker" then "auth-worker"
         elif .name == "acceptance" then "acceptance"
         elif .name == "migrator" then "migrator"
         elif .name == "operations" then "operations"
         else .name end) + ":" + $revision))
  ' "$accepted_evidence/11-images.json" >/dev/null \
    || fail "accepted image inventory is invalid"
  jq -e '
    .schemaVersion == 1 and .product == "business-finlynq" and
    (.imageId | test("^sha256:[a-f0-9]{64}$")) and
    .runtimeUser == "100:101" and .readOnlyRootFilesystem == true and
    (.signatures | type == "array" and length > 0)
  ' "$accepted_evidence/14-evidence-scanner.json" >/dev/null \
    || fail "accepted evidence-scanner inventory is invalid"
  expected_app_image="$(jq -er '.images[] | select(.name == "app") | .imageId' \
    "$accepted_evidence/11-images.json")" \
    || fail "accepted app image ID is unavailable"
  expected_database_image="$(jq -er '.images[] | select(.name == "database") | .imageId' \
    "$accepted_evidence/11-images.json")" \
    || fail "accepted database image ID is unavailable"
  expected_scanner_image="$(jq -er '.imageId' \
    "$accepted_evidence/14-evidence-scanner.json")" \
    || fail "accepted scanner image ID is unavailable"
  project_container_output="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq')" \
    || fail "accepted production container set could not be inspected"
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] \
      || fail "Docker returned an invalid production container ID"
    inspect_json="$(docker inspect "$container_id")" \
      || fail "production container could not be inspected: $container_id"
    service="$(jq -er '.[0].Config.Labels["com.docker.compose.service"]' \
      <<<"$inspect_json")" \
      || fail "production container has no Compose service identity"
    case "$service" in
      app|database|evidence_scanner) ;;
      *) fail "unexpected container remains in accepted production project: $service" ;;
    esac
    [[ ! -v "service_containers[$service]" ]] \
      || fail "accepted production has duplicate $service containers"
    service_containers["$service"]="$container_id"
    case "$service" in
      app)
        jq -e --arg imageId "$expected_app_image" --arg revision "$revision" \
          --arg secretDirectory "$secret_directory" '
          length == 1 and .[0].Image == $imageId and
          .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
          .[0].Config.Labels["com.docker.compose.service"] == "app" and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
          .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
          .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
          .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
          (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
          (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
          (.[0].HostConfig.PortBindings | keys) == ["3000/tcp"] and
          .[0].HostConfig.PortBindings["3000/tcp"] ==
            [{"HostIp":"127.0.0.1", "HostPort":"3100"}] and
          (.[0].Mounts | length) == 6 and
          all(.[0].Mounts[]; .Type == "bind" and .RW == false and
            ((.Source == ($secretDirectory + "/app-db-password") and
                .Destination == "/run/secrets/business_finlynq_app_db_password") or
             (.Source == ($secretDirectory + "/organization-root-kek") and
                .Destination == "/run/secrets/business_finlynq_root_kek") or
             (.Source == ($secretDirectory + "/identity-secret") and
                .Destination == "/run/secrets/business_finlynq_identity_secret") or
             (.Source == ($secretDirectory + "/not-configured") and
                (.Destination == "/run/secrets/business_finlynq_turnstile_secret_key" or
                 .Destination == "/run/secrets/business_finlynq_document_google_secret" or
                 .Destination == "/run/secrets/business_finlynq_document_microsoft_secret")))) and
          ([.[0].Mounts[].Destination] | unique | length) == 6 and
          ([.[0].NetworkSettings.Networks | keys[]] | sort) ==
            ["business_finlynq_edge", "business_finlynq_egress",
              "business_finlynq_private", "business_finlynq_private_evidence"] and
          ([.[0].Config.Env[]] | index("DEMO_LOGIN_ENABLED=true") != null) and
          ([.[0].Config.Env[]] | index("DEMO_WRITES_ENABLED=true") != null) and
          ([.[0].Config.Env[]] | index("ACCOUNT_LOGIN_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("ACCOUNT_SIGNUP_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("AUTH_EMAIL_DELIVERY_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("SIGNUP_TURNSTILE_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("BUSINESS_WRITES_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("BANK_FEEDS_ENABLED=false") != null) and
          ([.[0].Config.Env[]] | index("YAHOO_FX_ENABLED=false") != null)
        ' <<<"$inspect_json" >/dev/null \
          || fail "live app differs from the accepted contained runtime"
        ;;
      database)
        jq -e --arg imageId "$expected_database_image" --arg revision "$revision" '
          length == 1 and .[0].Image == $imageId and
          .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
          .[0].Config.Labels["com.docker.compose.service"] == "database" and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
          .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
          .[0].HostConfig.Init == true and
          .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
          ((.[0].HostConfig.PortBindings // {}) | length) == 0 and
          (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
          ([.[0].NetworkSettings.Networks | keys[]] | sort) == ["business_finlynq_private"] and
          (.[0].Mounts | length) == 1 and
          ([.[0].Mounts[] | select(.Destination == "/var/lib/postgresql/data") |
            [.Type, .Name, .RW]] == [["volume", "business_finlynq_pgdata", true]])
        ' <<<"$inspect_json" >/dev/null \
          || fail "live database differs from the accepted contained runtime"
        ;;
      evidence_scanner)
        jq -e --arg imageId "$expected_scanner_image" '
          length == 1 and .[0].Image == $imageId and
          .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
          .[0].Config.Labels["com.docker.compose.service"] == "evidence_scanner" and
          .[0].Config.User == "100:101" and .[0].HostConfig.ReadonlyRootfs == true and
          .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
          .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
          ((.[0].HostConfig.PortBindings // {}) | length) == 0 and
          (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
          (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
          ([.[0].NetworkSettings.Networks | keys[]] | sort) ==
            ["business_finlynq_egress_scanner", "business_finlynq_private_evidence"] and
          (.[0].Mounts | length) == 1 and
          ([.[0].Mounts[] | select(.Destination == "/var/lib/clamav") |
            [.Type, .Name, .RW]] ==
            [["volume", "business_finlynq_pgdata_clamav", true]])
        ' <<<"$inspect_json" >/dev/null \
          || fail "live evidence scanner differs from the accepted contained runtime"
        ;;
    esac
  done <<<"$project_container_output"
  [[ "${#service_containers[@]}" == 3 \
    && -v 'service_containers[app]' \
    && -v 'service_containers[database]' \
    && -v 'service_containers[evidence_scanner]' ]] \
    || fail "accepted production runtime does not contain exactly app, database, and scanner"
  run_fresh_installed_oneshot business-finlynq-accounting-evidence.service
  run_fresh_installed_oneshot business-finlynq-monitor.service
}

recover_accepted_stopped_app() {
  local accepted_evidence="$1" project_container_output container_id service
  local app_container inspect_json supporting_inspect
  local expected_app_image expected_database_image expected_scanner_image
  local app_state start_output readiness health_state
  local signature_inventory signature_path signature_uid signature_gid signature_mode
  local signature_mtime now signature_count=0
  local -A recovery_containers=()
  expected_app_image="$(jq -er '.images[] | select(.name == "app") | .imageId' \
    "$accepted_evidence/11-images.json")" \
    || fail "accepted app image ID is unavailable for terminal recovery"
  expected_database_image="$(jq -er \
    '.images[] | select(.name == "database") | .imageId' \
    "$accepted_evidence/11-images.json")" \
    || fail "accepted database image ID is unavailable for terminal recovery"
  expected_scanner_image="$(jq -er '.imageId' \
    "$accepted_evidence/14-evidence-scanner.json")" \
    || fail "accepted scanner image ID is unavailable for terminal recovery"
  project_container_output="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq')" \
    || fail "terminal-recovery production containers could not be enumerated"
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] \
      || fail "Docker returned an invalid terminal-recovery container ID"
    service="$(docker inspect --format \
      '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id")" \
      || fail "terminal-recovery container service could not be inspected"
    case "$service" in app|database|evidence_scanner) ;; \
      *) fail "terminal recovery found an unexpected production service: $service" ;; \
    esac
    [[ ! -v "recovery_containers[$service]" ]] \
      || fail "terminal recovery found duplicate $service containers"
    recovery_containers["$service"]="$container_id"
  done <<<"$project_container_output"
  [[ "${#recovery_containers[@]}" == 3 \
    && -v 'recovery_containers[app]' \
    && -v 'recovery_containers[database]' \
    && -v 'recovery_containers[evidence_scanner]' ]] \
    || fail "terminal recovery requires exactly app, database, and scanner containers"
  supporting_inspect="$(docker inspect "${recovery_containers[database]}")" \
    || fail "terminal-recovery database could not be inspected"
  jq -e --arg imageId "$expected_database_image" '
    length == 1 and .[0].Image == $imageId and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "database" and
    .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
    ((.[0].HostConfig.PortBindings // {}) | length) == 0 and
    ([.[0].NetworkSettings.Networks | keys[]] | sort) == ["business_finlynq_private"] and
    (.[0].Mounts | length) == 1 and
    ([.[0].Mounts[] | select(.Destination == "/var/lib/postgresql/data") |
      [.Type, .Name, .RW]] == [["volume", "business_finlynq_pgdata", true]])
  ' <<<"$supporting_inspect" >/dev/null \
    || fail "terminal-recovery database differs from accepted runtime"
  supporting_inspect="$(docker inspect "${recovery_containers[evidence_scanner]}")" \
    || fail "terminal-recovery scanner could not be inspected"
  jq -e --arg imageId "$expected_scanner_image" '
    length == 1 and .[0].Image == $imageId and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "evidence_scanner" and
    .[0].Config.User == "100:101" and .[0].HostConfig.ReadonlyRootfs == true and
    .[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and
    ((.[0].HostConfig.PortBindings // {}) | length) == 0 and
    ([.[0].NetworkSettings.Networks | keys[]] | sort) ==
      ["business_finlynq_egress_scanner", "business_finlynq_private_evidence"] and
    (.[0].Mounts | length) == 1 and
    ([.[0].Mounts[] | select(.Destination == "/var/lib/clamav") |
      [.Type, .Name, .RW]] ==
      [["volume", "business_finlynq_pgdata_clamav", true]])
  ' <<<"$supporting_inspect" >/dev/null \
    || fail "terminal-recovery scanner differs from accepted runtime"
  signature_inventory="$(docker exec "${recovery_containers[evidence_scanner]}" \
    /bin/sh -ec '
      found=false
      for path in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do
        [ -f "$path" ] || continue
        found=true
        stat -c "%n|%u|%g|%a|%Y" "$path"
      done
      [ "$found" = true ]
    ')" || fail "terminal-recovery scanner signatures could not be inspected"
  now="$(date +%s)"
  [[ "$now" =~ ^[1-9][0-9]*$ ]] \
    || fail "terminal-recovery scanner time is invalid"
  while IFS='|' read -r signature_path signature_uid signature_gid signature_mode \
    signature_mtime; do
    [[ "$signature_path" =~ ^/var/lib/clamav/[A-Za-z0-9_.-]+\.(cvd|cld)$ \
      && "$signature_uid" == 100 && "$signature_gid" == 101 \
      && "$signature_mode" =~ ^[0-7]{3,4}$ \
      && "$signature_mtime" =~ ^[1-9][0-9]*$ ]] \
      || fail "terminal-recovery scanner signature metadata is unsafe"
    (( (8#$signature_mode & 8#002) == 0 \
      && signature_mtime <= now + 300 && now - signature_mtime <= 604800 )) \
      || fail "terminal-recovery scanner signature is writable, stale, or future-dated"
    (( signature_count += 1 ))
  done <<<"$signature_inventory"
  (( signature_count > 0 )) \
    || fail "terminal-recovery scanner has no accepted signature database"
  app_container="${recovery_containers[app]}"
  inspect_json="$(docker inspect "$app_container")" \
    || fail "stopped accepted app could not be inspected"
  jq -e --arg imageId "$expected_app_image" --arg revision "$revision" \
    --arg secretDirectory "$secret_directory" '
    length == 1 and .[0].Image == $imageId and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "app" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    (.[0].State.Status == "exited" or
      (.[0].State.Status == "running" and .[0].State.Health.Status == "healthy")) and
    .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Init == true and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
    (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
    (.[0].HostConfig.PortBindings | keys) == ["3000/tcp"] and
    .[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":"3100"}] and
    (.[0].Mounts | length) == 6 and
    all(.[0].Mounts[]; .Type == "bind" and .RW == false and
      ((.Source == ($secretDirectory + "/app-db-password") and
          .Destination == "/run/secrets/business_finlynq_app_db_password") or
       (.Source == ($secretDirectory + "/organization-root-kek") and
          .Destination == "/run/secrets/business_finlynq_root_kek") or
       (.Source == ($secretDirectory + "/identity-secret") and
          .Destination == "/run/secrets/business_finlynq_identity_secret") or
       (.Source == ($secretDirectory + "/not-configured") and
          (.Destination == "/run/secrets/business_finlynq_turnstile_secret_key" or
           .Destination == "/run/secrets/business_finlynq_document_google_secret" or
           .Destination == "/run/secrets/business_finlynq_document_microsoft_secret")))) and
    ([.[0].Mounts[].Destination] | unique | length) == 6 and
    ([.[0].NetworkSettings.Networks | keys[]] | sort) ==
      ["business_finlynq_edge", "business_finlynq_egress",
        "business_finlynq_private", "business_finlynq_private_evidence"] and
    ([.[0].Config.Env[]] | index("DEMO_LOGIN_ENABLED=true") != null) and
    ([.[0].Config.Env[]] | index("DEMO_WRITES_ENABLED=true") != null) and
    ([.[0].Config.Env[]] | index("ACCOUNT_LOGIN_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("ACCOUNT_SIGNUP_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("AUTH_EMAIL_DELIVERY_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("SIGNUP_TURNSTILE_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("BUSINESS_WRITES_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("BANK_FEEDS_ENABLED=false") != null) and
    ([.[0].Config.Env[]] | index("YAHOO_FX_ENABLED=false") != null)
  ' <<<"$inspect_json" >/dev/null \
    || fail "stopped app differs from the exact accepted contained contract"
  app_state="$(jq -r '.[0].State.Status' <<<"$inspect_json")"
  if [[ "$app_state" == exited ]]; then
    start_output="$(docker start "$app_container")" \
      || fail "exact accepted app container could not be restarted"
    [[ "$start_output" == "$app_container" \
      || "$start_output" == "${app_container:0:12}" ]] \
      || fail "Docker returned an unexpected restarted app identity"
  fi
  health_state=""
  for _ in {1..60}; do
    health_state="$(docker inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$app_container")" \
      || fail "restarted accepted app health could not be inspected"
    [[ "$health_state" == true\|healthy ]] && break
    sleep 2
  done
  [[ "$health_state" == true\|healthy ]] \
    || fail "exact accepted app did not become healthy after terminal recovery"
  readiness="$(curl --fail --silent --show-error --max-time 15 \
    --header 'X-Business-Finlynq-Internal-Health: 1' \
    http://127.0.0.1:3100/api/health)" \
    || fail "restarted accepted app did not answer loopback detailed readiness"
  jq -e --arg revision "$revision" '
    .status == "ready" and .revision == $revision and
    .checks.database == "ready" and .checks.organizationKey == "ready" and
    .checks.identityKey == "ready" and
    .checks.accountAuthentication == "disabled" and
    .checks.accountSignup == "disabled" and .checks.emailWorker == "disabled" and
    .checks.bankFeeds == "disabled"
  ' <<<"$readiness" >/dev/null \
    || fail "restarted accepted app readiness differs from the contained posture"
}

finalize_accepted_initial() {
  local accepted_run_id="$1"
  local accepted_evidence="$release_evidence_root/$revision/$accepted_run_id"
  [[ -d "$accepted_evidence" && ! -L "$accepted_evidence" \
    && "$(readlink -f -- "$accepted_evidence")" == "$accepted_evidence" \
    && "$(stat -c '%u:%a' -- "$accepted_evidence")" == 0:700 \
    && -f "$accepted_evidence/00-release-plan.json" \
    && -f "$accepted_evidence/06-initial-inputs.json" \
    && -f "$accepted_evidence/11-images.json" \
    && -f "$accepted_evidence/14-evidence-scanner.json" \
    && -f "$accepted_evidence/85-contained-initial-deferrals.json" \
    && -f "$accepted_evidence/SHA256SUMS" \
    && ! -L "$accepted_evidence/00-release-plan.json" \
    && ! -L "$accepted_evidence/06-initial-inputs.json" \
    && ! -L "$accepted_evidence/11-images.json" \
    && ! -L "$accepted_evidence/14-evidence-scanner.json" \
    && ! -L "$accepted_evidence/85-contained-initial-deferrals.json" \
    && ! -L "$accepted_evidence/SHA256SUMS" \
    && ( ( -f "$accepted_evidence/90-release-complete.json" \
        && ! -L "$accepted_evidence/90-release-complete.json" ) \
      || ( -f "$accepted_evidence/.90-release-complete.json.partial" \
        && ! -L "$accepted_evidence/.90-release-complete.json.partial" ) ) \
    && ( ! -e "$accepted_evidence/99-failure.json" \
      || ( -f "$accepted_evidence/99-failure.json" \
        && ! -L "$accepted_evidence/99-failure.json" ) ) ]] \
    || fail "accepted initial evidence is incomplete or unsafe"
  recover_accepted_terminal_inventory_gap "$accepted_run_id"
  verify_protected_evidence_inventory "$accepted_evidence"
  jq -e --arg revision "$revision" --arg runId "$accepted_run_id" '
    .schemaVersion == 1 and .product == "business-finlynq" and
    .status == "started" and .mode == "initial" and
    .revision == $revision and .runId == $runId
  ' "$accepted_evidence/00-release-plan.json" >/dev/null \
    || fail "accepted initial plan identity is invalid"
  # Validate the terminal acceptance, deferral, and protected-input evidence
  # before restarting an app that is already attached to the public edge.
  verify_contained_initial_terminal_evidence "$accepted_run_id"
  # Once the protected terminal evidence is accepted, any later finalizer
  # failure must stop the app even if it was already running before inspection.
  wrapper_stop_app_on_failure="true"
  if [[ -f "$accepted_evidence/99-failure.json" ]]; then
    jq -e --arg revision "$revision" --arg runId "$accepted_run_id" '
      .schemaVersion == 1 and .product == "business-finlynq" and
      .status == "failed" and .mode == "initial" and
      .revision == $revision and .runId == $runId and
      .stage == "complete-evidence" and .initialTimersRemainDisabled == true
    ' "$accepted_evidence/99-failure.json" >/dev/null \
      || fail "accepted-plus-failure evidence is not the narrow complete-evidence case"
  fi
  verify_rehearsal_acceptance
  if [[ -e "$install_completion" || -L "$install_completion" ]]; then
    verify_install_completion_for_run "$accepted_run_id"
  fi
  recover_accepted_stopped_app "$accepted_evidence"
  "$external_edge_verifier_target" --scope full
  verify_live_accepted_initial_runtime "$accepted_evidence"
  verify_all_bootstrap_automation_disabled
  for selected_path in \
    /etc/systemd/system/business-finlynq-continuous-deployment.service \
    /etc/systemd/system/business-finlynq-continuous-deployment.timer; do
    assert_path_absent "$selected_path" "production continuous-deployment unit"
  done
  write_install_completion "$accepted_run_id"
  wrapper_stop_app_on_failure="false"
  initial_wrapper_active="false"
  printf 'Recovered wrapper completion for accepted initial run %s. Completion: %s\n' \
    "$accepted_run_id" "$install_completion"
}

if [[ "$prepare_configuration_only" == true ]]; then
  if [[ -e "$install_completion" || -L "$install_completion" ]]; then
    fail "initial production is already complete"
  fi
  if [[ -e "$install_state" || -L "$install_state" ]]; then
    validate_recipient_file "$recipient_input"
    supplied_recipient_sha="$(checked_file_sha256 "$recipient_input")" \
      || fail "supplied public recipient checksum could not be read"
    protected_recipient_sha="$(checked_file_sha256 "$recipient_target")" \
      || fail "protected public recipient checksum could not be read"
    [[ -f "$recipient_target" && ! -L "$recipient_target" \
      && "$supplied_recipient_sha" == "$protected_recipient_sha" ]] \
      || fail "supplied public recipient differs from the protected configured recipient"
    verify_install_state
    if [[ -e "$preparation_state" || -L "$preparation_state" ]]; then
      verify_preparation_state
      rm -- "$preparation_state"
      sync -f -- "$configuration_directory"
    fi
    assert_empty_production_runtime
    render_and_verify_initial_configuration
  else
    prepare_new_configuration
  fi
  printf '%s\n' \
    "Prepared and attested production configuration without starting Business services." \
    "Next, rerun the exact development revision with --external-edge --require-public-acceptance," \
    "then invoke this installer with --revision $revision --run-provisioned."
  exit 0
fi

[[ -f "$install_state" && ! -L "$install_state" ]] \
  || fail "run --prepare-configuration-only before provisioning or resume"
if [[ -e "$install_completion" || -L "$install_completion" ]]; then
  [[ -n "$finalize_run_id" ]] \
    || fail "initial production is already complete"
fi
verify_install_state
if [[ -e "$preparation_state" || -L "$preparation_state" ]]; then
  verify_preparation_state
  rm -- "$preparation_state"
  sync -f -- "$configuration_directory"
fi
render_and_verify_initial_configuration

if [[ -n "$finalize_run_id" ]]; then
  initial_wrapper_active="true"
  wrapper_stop_app_on_failure="false"
  finalize_accepted_initial "$finalize_run_id"
  wrapper_stop_app_on_failure="false"
  initial_wrapper_active="false"
  exit 0
fi

if [[ "$run_provisioned" == true ]]; then
  assert_empty_production_runtime
  existing_initial_directory=""
  if [[ -d "$release_evidence_root/$revision" ]]; then
    existing_initial_directory="$(find "$release_evidence_root/$revision" \
      -mindepth 1 -maxdepth 1 -type d -name 'initial-*' -print -quit)" \
      || fail "existing initial evidence could not be enumerated"
  fi
  [[ -z "$existing_initial_directory" ]] \
    || fail "initial evidence already exists; review it and use --resume-initial only for an exact failed run"
  "$external_edge_verifier_target" --scope preflight
  ensure_rehearsals_accepted
  # Recheck the edge after the potentially long image/rehearsal work and before
  # the first production database is created.
  "$external_edge_verifier_target" --scope preflight
  run_initial_release ""
  exit 0
fi

if [[ -n "$pristine_retry_run_id" ]]; then
  verify_pristine_initial_failure "$pristine_retry_run_id"
  verify_rehearsal_acceptance
  "$external_edge_verifier_target" --scope preflight
  pristine_retry_new_run_id="$(authorize_pristine_retry "$pristine_retry_run_id")"
  # Re-attest emptiness after persisting the exact retry authorization and
  # immediately before invoking a fresh runner attempt.
  assert_empty_production_runtime
  run_initial_release "" "$pristine_retry_new_run_id"
  exit 0
fi

prior_evidence="$release_evidence_root/$revision/$resume_run_id"
[[ -d "$prior_evidence" && ! -L "$prior_evidence" \
  && "$(stat -c '%u:%a' -- "$prior_evidence")" == 0:700 \
  && -f "$prior_evidence/99-failure.json" \
  && ! -L "$prior_evidence/99-failure.json" \
  && ! -e "$prior_evidence/90-release-complete.json" \
  && ! -L "$prior_evidence/90-release-complete.json" ]] \
  || fail "the acknowledged prior initial run is not an incomplete protected failure"
jq -e --arg revision "$revision" --arg runId "$resume_run_id" '
  .schemaVersion == 1 and .product == "business-finlynq" and
  .status == "failed" and .mode == "initial" and
  .revision == $revision and .runId == $runId and
  .initialTimersRemainDisabled == true
' "$prior_evidence/99-failure.json" >/dev/null \
  || fail "the acknowledged prior initial failure identity or timer containment is invalid"
verify_rehearsal_acceptance
"$external_edge_verifier_target" --scope development
run_initial_release "$resume_run_id"
