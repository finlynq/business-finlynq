#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || {
  printf 'Business Finlynq external-edge verification failed: could not resolve the script directory\n' >&2
  exit 1
}
readonly script_directory
repository="$(cd -- "$script_directory/../.." && pwd -P)" || {
  printf 'Business Finlynq external-edge verification failed: could not resolve the repository directory\n' >&2
  exit 1
}
readonly repository
readonly compose_environment="/etc/business-finlynq/compose.env"
readonly production_project="business-finlynq"
readonly development_project="business-finlynq-development"
readonly development_network="business_finlynq_development_edge"
readonly minimum_tls_seconds="$((21 * 24 * 60 * 60))"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly expected_edge_networks=(
  business_finlynq_edge
  business_finlynq_development_edge
  epm_finlynq_edge
  epm_finlynq_edge_egress
)
scope="full"

fail() {
  printf 'Business Finlynq external-edge verification failed: %s\n' "$*" >&2
  exit 1
}

checked_utc_timestamp() {
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    || fail "could not produce a UTC verification timestamp"
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || fail "the generated UTC verification timestamp is invalid"
  printf '%s' "$timestamp"
}

checked_file_sha256() {
  local path="$1" output digest remainder
  output="$(sha256sum -- "$path")" || fail "could not hash $path"
  read -r digest remainder <<<"$output"
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] \
    || fail "sha256sum returned an invalid digest for $path"
  printf '%s' "$digest"
}

checked_container_sha256() {
  local container="$1" path="$2" output digest remainder
  output="$(docker exec "$container" sha256sum "$path")" \
    || fail "could not hash $path inside the external edge container"
  read -r digest remainder <<<"$output"
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" ]] \
    || fail "the external edge returned an invalid digest for $path"
  printf '%s' "$digest"
}

# Edge attestation must always inspect the local host daemon, never an ambient
# Docker context/DOCKER_HOST or caller-supplied Compose environment.
docker() {
  env -i PATH="$clean_path" docker "$@"
}

read_environment_value() {
  local key="$1" value count
  count="$(awk -F= -v selected="$key" '$1 == selected { count++ } END { print count + 0 }' \
    "$compose_environment")" || fail "could not count $key in the Compose environment"
  [[ "$count" == 1 ]] || fail "Compose environment must define $key exactly once"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" || fail "could not read $key from the Compose environment"
  [[ -n "$value" ]] || fail "Compose environment contains an empty $key"
  printf '%s' "$value"
}

container_for_service() {
  local project="$1" service="$2" query container
  local -a containers=()
  if ! query="$(docker ps --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" --format '{{.ID}}')"; then
    fail "could not inspect running $project/$service containers"
  fi
  while IFS= read -r container; do
    [[ -n "$container" ]] && containers+=("$container")
  done <<<"$query"
  [[ "${#containers[@]}" == 1 ]] \
    || fail "exactly one running $project/$service container is required"
  printf '%s' "${containers[0]}"
}

network_is_external_owned() {
  local network="$1"
  docker network inspect "$network" 2>/dev/null \
    | jq -e 'length == 1
        and .[0].Driver == "bridge"
        and .[0].Scope == "local"
        and .[0].Internal == true
        and .[0].Labels["com.business-finlynq.edge-owner"] == "external"' >/dev/null
}

backend_alias_is_present() {
  local project="$1" network="$2" alias="$3" container networks
  container="$(container_for_service "$project" app)" \
    || fail "could not resolve the $project app container"
  networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$container")" \
    || fail "could not inspect $project app network attachments"
  jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null \
    || fail "$project/app is not attached to $network with alias $alias"
}

validate_ipv4() {
  local address="$1" octet
  local -a octets=()
  IFS='.' read -r -a octets <<<"$address"
  [[ "${#octets[@]}" == 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

tls_is_valid() {
  local hostname="$1" address="$2"
  timeout 25s openssl s_client -connect "$address:443" -servername "$hostname" \
    </dev/null 2>/dev/null \
    | openssl x509 -checkend "$minimum_tls_seconds" -noout >/dev/null \
    || fail "$hostname TLS certificate on $address is invalid or expires within 21 days"
}

http_redirect_is_exact() {
  local hostname="$1" address="$2" headers status location
  headers="$(mktemp)"
  temporary_files+=("$headers")
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:80:$address" --dump-header "$headers" \
    --output /dev/null --write-out '%{http_code}' "http://$hostname/api/live")" \
    || fail "$hostname HTTP redirect could not be checked on $address"
  [[ "$status" == 308 ]] || fail "$hostname must use the reviewed permanent HTTPS redirect"
  location="$(awk -F: 'tolower($1) == "location" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print }' \
    "$headers")"
  [[ "$location" == "https://$hostname/api/live" ]] \
    || fail "$hostname redirected to an unexpected location"
}

verify_security_headers() {
  local hostname="$1" headers="$2"
  grep -Eiq '^strict-transport-security:[[:space:]]*max-age=31536000; includeSubDomains[[:space:]\r]*$' \
    "$headers" || fail "$hostname does not return the reviewed HSTS policy"
  grep -Eiq '^x-content-type-options:[[:space:]]*nosniff[[:space:]\r]*$' "$headers" \
    || fail "$hostname is missing X-Content-Type-Options"
  grep -Eiq '^x-frame-options:[[:space:]]*DENY[[:space:]\r]*$' "$headers" \
    || fail "$hostname is missing the reviewed frame policy"
  grep -Eiq '^referrer-policy:[[:space:]]*strict-origin-when-cross-origin[[:space:]\r]*$' \
    "$headers" || fail "$hostname is missing the reviewed referrer policy"
  ! grep -Eiq '^server:' "$headers" || fail "$hostname exposed the edge server header"
}

public_contract_is_valid() {
  local hostname="$1" address="$2" headers body status request_id metrics_status
  headers="$(mktemp)"
  body="$(mktemp)"
  temporary_files+=("$headers" "$body")
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$address" --dump-header "$headers" \
    --output "$body" --write-out '%{http_code}' "https://$hostname/api/live")" \
    || fail "$hostname liveness route is unavailable through the external edge on $address"
  [[ "$status" == 200 ]] || fail "$hostname liveness route returned HTTP $status"
  jq -e 'type == "object" and keys == ["status"] and .status == "live"' "$body" \
    >/dev/null || fail "$hostname returned an unexpected liveness response"
  grep -Eiq '^cache-control:.*no-store' "$headers" \
    || fail "$hostname liveness response is missing no-store"
  verify_security_headers "$hostname" "$headers"

  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$address" \
    -H 'X-Business-Finlynq-Internal-Health: detailed' \
    -H 'X-Business-Finlynq-Internal-Metrics: detailed' \
    -H 'X-Request-Id: untrusted-public-request-id' \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    "https://$hostname/api/health")" \
    || fail "$hostname readiness route is unavailable through the external edge"
  [[ "$status" == 200 ]] || fail "$hostname readiness route returned HTTP $status"
  jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$body" \
    >/dev/null || fail "$hostname exposed a non-minimal public readiness response"
  grep -Eiq '^cache-control:.*no-store' "$headers" \
    || fail "$hostname readiness response is missing no-store"
  verify_security_headers "$hostname" "$headers"
  request_id="$(awk -F: 'tolower($1) == "x-request-id" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print }' \
    "$headers")"
  [[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
    && "$request_id" != untrusted-public-request-id ]] \
    || fail "$hostname did not replace the untrusted public request ID"
  metrics_status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 --output /dev/null \
    --resolve "$hostname:443:$address" \
    --write-out '%{http_code}' -H 'X-Business-Finlynq-Internal-Metrics: detailed' \
    "https://$hostname/api/metrics")" \
    || fail "$hostname metrics boundary could not be checked"
  [[ "$metrics_status" == 404 ]] || fail "$hostname exposed the internal metrics route"
  http_redirect_is_exact "$hostname" "$address"
  tls_is_valid "$hostname" "$address"
}

while (( $# > 0 )); do
  case "$1" in
    --scope)
      (( $# >= 2 )) || fail "--scope requires preflight, development, or full"
      scope="$2"
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$scope" == preflight || "$scope" == development || "$scope" == full ]] \
  || fail "--scope must be preflight, development, or full"
[[ "$(id -u)" == 0 ]] || fail "run this command as root"
for command_name in awk bash curl date docker env grep id jq mktemp openssl rm sha256sum \
  sleep sort stat timeout wc; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
[[ -f "$compose_environment" && ! -L "$compose_environment" \
  && "$(stat -c '%U:%G:%a' -- "$compose_environment")" == root:deploy:600 ]] \
  || fail "the canonical Compose environment is unavailable or unsafe"

edge_mode="$(read_environment_value BUSINESS_FINLYNQ_EDGE_MODE)" \
  || fail "could not read BUSINESS_FINLYNQ_EDGE_MODE"
readonly edge_mode
[[ "$edge_mode" == external ]] || fail "BUSINESS_FINLYNQ_EDGE_MODE must be external"
external_project="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_PROJECT"
external_service="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_SERVICE"
external_owner="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_OWNER"
external_image="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE"
external_image_id="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID"
external_config="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG"
external_config_source="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_SOURCE"
external_public_ipv4s_csv="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S"
route_source="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SOURCE"
route_destination="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_DESTINATION"
route_sha256="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256"
caddy_data_volume="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_DATA_VOLUME)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_DATA_VOLUME"
caddy_config_volume="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_VOLUME)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_CONFIG_VOLUME"
epm_secret_source="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_SOURCE"
epm_secret_destination="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_EPM_SECRET_DESTINATION"
active_config_sha256="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256"
production_network="$(read_environment_value BUSINESS_FINLYNQ_EDGE_NETWORK)" \
  || fail "could not read BUSINESS_FINLYNQ_EDGE_NETWORK"
production_hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" \
  || fail "could not read BUSINESS_FINLYNQ_HOSTNAME"
development_hostname="$(read_environment_value BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME)" \
  || fail "could not read BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME"
epm_hostname="$(read_environment_value EPM_FINLYNQ_HOSTNAME)" \
  || fail "could not read EPM_FINLYNQ_HOSTNAME"
readonly external_project external_service external_owner external_image external_image_id
readonly external_config external_config_source external_public_ipv4s_csv route_source
readonly route_destination route_sha256 caddy_data_volume caddy_config_volume
readonly epm_secret_source epm_secret_destination active_config_sha256 production_network
readonly production_hostname development_hostname epm_hostname

for identifier in "$external_project" "$external_service" "$external_owner" \
  "$caddy_data_volume" "$caddy_config_volume"; do
  [[ "$identifier" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || fail "external edge identity contains unsafe characters"
done
[[ "$external_project" == epm-finlynq && "$external_service" == edge \
  && "$external_owner" == epm-finlynq ]] \
  || fail "external edge must use the reviewed EPM owner identity"
[[ "$external_image" =~ ^[^[:space:]]+@sha256:[a-f0-9]{64}$ \
  && "$external_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "external edge image reference and image ID must be digest-pinned"
[[ "$external_config" == /etc/caddy/Caddyfile ]] \
  || fail "the external edge must validate its canonical Caddy configuration"
[[ "$route_destination" == /etc/caddy/business-finlynq-routes.caddy ]] \
  || fail "external route destination must use the reviewed container path"
[[ -f "$route_source" && ! -L "$route_source" \
  && "$(stat -c '%u:%g:%a' -- "$route_source")" == 0:0:444 ]] \
  || fail "the promoted external route source must be root-owned mode 0444"
promoted_route_sha256="$(checked_file_sha256 "$route_source")" \
  || fail "could not attest the promoted route digest"
repository_route_sha256="$(checked_file_sha256 \
  "$repository/deploy/edge/Caddyfile.business-external")" \
  || fail "could not attest the reviewed route digest"
[[ "$route_sha256" =~ ^[a-f0-9]{64}$ \
  && "$promoted_route_sha256" == "$route_sha256" \
  && "$repository_route_sha256" == "$route_sha256" ]] \
  || fail "promoted route, protected digest, and reviewed repository fragment differ"
[[ -f "$external_config_source" && ! -L "$external_config_source" ]] \
  || fail "the external edge configuration source is unavailable or unsafe"
config_source_mode="$(stat -c '%a' -- "$external_config_source")"
config_source_uid="$(stat -c '%u' -- "$external_config_source")"
deploy_uid="$(id -u deploy 2>/dev/null)" || fail "the deploy account is unavailable"
[[ "$config_source_mode" =~ ^[0-7]{3,4}$ && "$config_source_uid" == 0 ]] \
  || fail "the external edge configuration source has unsafe ownership or mode"
(( (8#$config_source_mode & 8#022) == 0 )) \
  || fail "the external edge configuration source is group- or other-writable"
[[ -f "$epm_secret_source" && ! -L "$epm_secret_source" && -s "$epm_secret_source" \
  && "$(stat -c '%u:%a' -- "$epm_secret_source")" == 0:400 ]] \
  || fail "the preserved EPM authentication source is unavailable or unsafe"
[[ "$epm_secret_destination" == /config/epm-basic-auth ]] \
  || fail "the preserved EPM authentication destination is unexpected"
[[ "$production_network" == business_finlynq_edge ]] \
  || fail "production must use the reviewed external edge network"
[[ "$production_hostname" == business.finlynq.com \
  && "$development_hostname" == dev.business.finlynq.com \
  && "$epm_hostname" == epm.finlynq.com ]] \
  || fail "external edge hostnames must use the reviewed production, development, and EPM names"

for project in "$production_project" "$development_project"; do
  if ! business_edge_query="$(docker ps --all \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=edge' --format '{{.ID}}')"; then
    fail "could not inspect $project edge residue"
  fi
  [[ -z "$business_edge_query" ]] \
    || fail "$project must not run a Compose-owned edge in external mode"
done
for network in "$production_network" "$development_network"; do
  network_is_external_owned "$network" \
    || fail "$network must be an externally owned internal local bridge"
done

edge_container="$(container_for_service "$external_project" "$external_service")" \
  || fail "could not resolve the external edge container"
readonly edge_container
docker inspect --format '{{json .Config.Labels}}' "$edge_container" \
  | jq -e --arg project "$external_project" --arg service "$external_service" \
      --arg owner "$external_owner" '
      .["com.docker.compose.project"] == $project
      and .["com.docker.compose.service"] == $service
      and .["com.business-finlynq.edge-owner"] == $owner
    ' >/dev/null || fail "external edge labels do not match the protected owner identity"
edge_config_image="$(docker inspect --format '{{.Config.Image}}' "$edge_container")" \
  || fail "could not inspect the external edge image reference"
edge_observed_image_id="$(docker inspect --format '{{.Image}}' "$edge_container")" \
  || fail "could not inspect the external edge image ID"
[[ "$edge_config_image" == "$external_image" \
  && "$edge_observed_image_id" == "$external_image_id" ]] \
  || fail "external edge is not running the protected digest-pinned image"
edge_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  "$edge_container")" || fail "could not inspect external edge health"
readonly edge_health
[[ "$edge_health" == healthy ]] || fail "the external edge container is not healthy"

if ! actual_edge_networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
  "$edge_container" | jq -r 'keys[]' | sort)"; then
  fail "external edge network attachments could not be inspected"
fi
expected_edge_networks_sorted="$(printf '%s\n' "${expected_edge_networks[@]}" | sort)" \
  || fail "could not prepare the protected external edge network inventory"
[[ "$actual_edge_networks" == "$expected_edge_networks_sorted" ]] \
  || fail "external edge network attachments differ from the protected inventory"

IFS=',' read -r -a expected_public_ipv4s <<<"$external_public_ipv4s_csv"
(( ${#expected_public_ipv4s[@]} >= 1 )) || fail "at least one protected public IPv4 is required"
for address in "${expected_public_ipv4s[@]}"; do
  validate_ipv4 "$address" || fail "external edge public IPv4 inventory is invalid"
done
if ! actual_port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' \
  "$edge_container" \
  | jq -r 'to_entries[] as $entry | $entry.value[] |
      "\(.HostIp)|\(.HostPort)|\($entry.key)"' | sort)"; then
  fail "external edge host bindings could not be inspected"
fi
expected_port_bindings=()
for address in "${expected_public_ipv4s[@]}"; do
  expected_port_bindings+=(
    "$address|80|80/tcp"
    "$address|443|443/tcp"
    "$address|443|443/udp"
  )
done
expected_port_bindings_sorted="$(printf '%s\n' "${expected_port_bindings[@]}" | sort)" \
  || fail "could not prepare the protected external edge port inventory"
[[ "$actual_port_bindings" == "$expected_port_bindings_sorted" ]] \
  || fail "external edge host bindings differ from the protected public-IP and port inventory"

if [[ "$scope" == preflight ]]; then
  if ! production_project_query="$(docker ps --all \
    --filter 'label=com.docker.compose.project=business-finlynq' --format '{{.ID}}')"; then
    fail "production preflight could not inspect the Business Compose project"
  fi
  [[ -z "$production_project_query" ]] \
    || fail "production preflight requires an empty Business Compose project"
elif [[ "$scope" == full ]]; then
  backend_alias_is_present "$production_project" "$production_network" production-app
fi
backend_alias_is_present "$development_project" "$development_network" development-app

mounts="$(docker inspect --format '{{json .Mounts}}' "$edge_container")" \
  || fail "could not inspect external edge mounts"
jq -e --arg configSource "$external_config_source" --arg configDestination "$external_config" \
    --arg routeSource "$route_source" --arg routeDestination "$route_destination" \
    --arg secretSource "$epm_secret_source" --arg secretDestination "$epm_secret_destination" \
    --arg dataVolume "$caddy_data_volume" --arg configVolume "$caddy_config_volume" '
    length == 5
    and any(.[]; .Type == "bind" and .Source == $configSource
      and .Destination == $configDestination and .RW == false)
    and any(.[]; .Type == "bind" and .Source == $routeSource
      and .Destination == $routeDestination and .RW == false)
    and any(.[]; .Type == "bind" and .Source == $secretSource
      and .Destination == $secretDestination and .RW == false)
    and any(.[]; .Type == "volume" and .Name == $dataVolume
      and .Destination == "/data" and .RW == true)
    and any(.[]; .Type == "volume" and .Name == $configVolume
      and .Destination == "/config" and .RW == true)
  ' <<<"$mounts" >/dev/null \
  || fail "external edge mounts differ from the protected Caddy and EPM inventory"
unset mounts

readonly expected_route_sha256="$route_sha256"
mounted_route_sha256="$(checked_container_sha256 "$edge_container" "$route_destination")" \
  || fail "could not attest the mounted route digest"
readonly mounted_route_sha256
[[ "$mounted_route_sha256" == "$expected_route_sha256" ]] \
  || fail "the external edge route mount differs from the reviewed fragment"
expected_config_sha256="$(checked_file_sha256 "$external_config_source")" \
  || fail "could not attest the protected external edge configuration"
readonly expected_config_sha256
mounted_config_sha256="$(checked_container_sha256 "$edge_container" "$external_config")" \
  || fail "could not attest the mounted external edge configuration"
readonly mounted_config_sha256
[[ "$mounted_config_sha256" == "$expected_config_sha256" ]] \
  || fail "the external edge configuration mount differs from its protected source"
docker exec "$edge_container" grep -Eq \
  '^[[:space:]]*import[[:space:]]+/etc/caddy/business-finlynq-routes[.]caddy[[:space:]]*$' \
  "$external_config" \
  || fail "the external edge configuration does not import the reviewed route fragment"
docker exec "$edge_container" grep -Fq "$epm_hostname" "$external_config" \
  || fail "the external edge configuration no longer preserves the EPM hostname"
docker exec "$edge_container" grep -Eq '^[[:space:]]*log_skip[[:space:]]+/auth/callback[[:space:]]*$' \
  "$external_config" \
  || fail "the external edge configuration no longer excludes EPM callbacks from logs"
docker exec "$edge_container" caddy validate --config "$external_config" --adapter caddyfile \
  >/dev/null 2>&1 || fail "the external edge Caddy configuration is invalid"
[[ "$active_config_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "protected active Caddy configuration digest is invalid"
if ! observed_active_config_sha256="$(docker exec "$edge_container" \
  wget -q -T 10 -O - http://127.0.0.1:2019/config/ | sha256sum | awk '{print $1}')"; then
  fail "the loaded Caddy administration configuration could not be attested"
fi
[[ "$observed_active_config_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "the loaded Caddy administration configuration digest is invalid"
[[ "$observed_active_config_sha256" == "$active_config_sha256" ]] \
  || fail "loaded Caddy configuration differs from the protected active digest"
if [[ "$scope" == full ]]; then
  docker exec "$edge_container" wget -q -T 10 -O /dev/null \
    http://production-app:3000/api/health \
    || fail "the external edge cannot reach the production backend"
fi
docker exec "$edge_container" wget -q -T 10 -O /dev/null \
  http://development-app:3000/api/health \
  || fail "the external edge cannot reach the development backend"
docker exec "$edge_container" wget -q -T 10 -O /dev/null \
  http://epm-finlynq-api:7100/health \
  || fail "the external edge cannot reach the EPM API backend"
docker exec "$edge_container" wget -q -T 10 -O /dev/null \
  http://epm-finlynq-console:7090/api/health \
  || fail "the external edge cannot reach the EPM console backend"

temporary_files=()
cleanup() {
  rm -f -- "${temporary_files[@]}"
}
trap cleanup EXIT INT TERM
for address in "${expected_public_ipv4s[@]}"; do
  if [[ "$scope" == full ]]; then
    public_contract_is_valid "$production_hostname" "$address"
  elif [[ "$scope" == preflight ]]; then
    preflight_headers="$(mktemp)"
    temporary_files+=("$preflight_headers")
    preflight_status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
      --resolve "$production_hostname:443:$address" \
      --dump-header "$preflight_headers" --output /dev/null --write-out '%{http_code}' \
      "https://$production_hostname/api/live")" \
      || fail "the not-yet-started production route could not be checked on $address"
    [[ "$preflight_status" == 502 || "$preflight_status" == 503 ]] \
      || fail "production preflight must expose only the expected unavailable-backend response"
    grep -Eiq '^strict-transport-security:' "$preflight_headers" \
      || fail "production preflight response is missing HSTS"
    http_redirect_is_exact "$production_hostname" "$address"
    tls_is_valid "$production_hostname" "$address"
  fi
  public_contract_is_valid "$development_hostname" "$address"
  http_redirect_is_exact "$epm_hostname" "$address"
  tls_is_valid "$epm_hostname" "$address"
  epm_status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 --output /dev/null \
    --resolve "$epm_hostname:443:$address" \
    --write-out '%{http_code}' "https://$epm_hostname/")" \
    || fail "the EPM public route could not be checked on $address"
  [[ "$epm_status" == 401 ]] \
    || fail "the preserved EPM console is not protected by authentication on $address"
done

callback_random="$(openssl rand -hex 12)" \
  || fail "could not generate the callback log-exclusion sentinel"
control_random="$(openssl rand -hex 12)" \
  || fail "could not generate the positive log-control sentinel"
[[ "$callback_random" =~ ^[a-f0-9]{24}$ && "$control_random" =~ ^[a-f0-9]{24}$ \
  && "$callback_random" != "$control_random" ]] \
  || fail "the generated edge log sentinels are invalid"
callback_sentinel="business-finlynq-callback-log-sentinel-$callback_random"
control_sentinel="business-finlynq-positive-log-control-$control_random"
log_start="$(checked_utc_timestamp)" || fail "could not record the edge log boundary"
readonly callback_sentinel control_sentinel log_start
unset callback_random control_random
callback_targets=(
  "$development_hostname|/api/document-storage/callback/$callback_sentinel?code=$callback_sentinel&state=$callback_sentinel"
  "$epm_hostname|/auth/callback?code=$callback_sentinel&state=$callback_sentinel"
)
if [[ "$scope" == full ]]; then
  callback_targets+=(
    "$production_hostname|/api/document-storage/callback/$callback_sentinel?code=$callback_sentinel&state=$callback_sentinel"
  )
fi
for address in "${expected_public_ipv4s[@]}"; do
  for callback_target in "${callback_targets[@]}"; do
    IFS='|' read -r callback_hostname callback_path <<<"$callback_target"
    curl --disable --noproxy '*' --silent --show-error --max-time 20 --output /dev/null \
      --resolve "$callback_hostname:443:$address" \
      "https://$callback_hostname$callback_path" \
      || fail "a callback log-exclusion probe could not reach the external edge on $address"
  done
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 20 --output /dev/null \
    --resolve "$development_hostname:443:$address" \
    "https://$development_hostname/api/live?edge_log_control=$control_sentinel" \
    || fail "the positive edge log-control probe failed on $address"
done
sleep 2
recent_logs="$(mktemp)"
temporary_files+=("$recent_logs")
if ! docker logs --since "$log_start" "$edge_container" >"$recent_logs" 2>&1; then
  fail "external edge logs could not be read for callback exclusion verification"
fi
grep -Fq "$control_sentinel" "$recent_logs" \
  || fail "positive edge log control was not observed"
if grep -Fq "$callback_sentinel" "$recent_logs"; then
  fail "an OAuth callback path or query value entered the external edge logs"
fi

printf 'External edge contract accepted: container=%s route_sha256=%s config_sha256=%s\n' \
  "$edge_container" "$expected_route_sha256" "$expected_config_sha256"
