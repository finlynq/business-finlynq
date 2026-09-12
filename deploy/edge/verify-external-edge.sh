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
readonly development_compose_environment="/etc/business-finlynq-development/compose.env"
readonly production_project="business-finlynq"
readonly development_project="business-finlynq-development"
readonly development_network="business_finlynq_development_edge"
readonly production_frontend_network="business_finlynq_private-frontend"
readonly development_frontend_network="business_finlynq_development_private-frontend"
readonly production_router_control_network="business_finlynq_private-router-control"
readonly development_router_control_network="business_finlynq_development_private-router-control"
readonly production_router_state_volume="business_finlynq_private-release-router-state-v2"
readonly development_router_state_volume="business_finlynq_development_private-release-router-state-v2"
readonly consult_route_source="/home/deploy/consult-finlynq/deploy/server04/Caddyfile.consult-finlynq"
readonly consult_route_destination="/etc/caddy/consult-finlynq.caddy"
readonly release_router_reference="business-finlynq-release-router:v2"
readonly release_router_revision="release-router-v2"
readonly release_router_contract="v2"
readonly legacy_f8485_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
readonly minimum_tls_seconds="$((21 * 24 * 60 * 60))"
readonly public_warmup_attempts=15
readonly public_warmup_retry_seconds=2
readonly public_warmup_request_timeout_seconds=2
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly expected_full_edge_networks=(
  business_finlynq_edge
  business_finlynq_development_edge
  epm_finlynq_edge
  epm_finlynq_edge_egress
  consult_finlynq_edge
)
scope="full"
warmup_host="none"
development_router_mode="active"
production_router_mode="active"
expected_production_revision=""
allow_legacy_minimal_production_health="false"
allow_pre_router_production="false"
allow_production_router_maintenance="false"
allow_first_router_forward_repair="false"
first_router_forward_repair_journal_sha256=""

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

read_development_environment_value() {
  local key="$1" value count
  count="$(awk -F= -v selected="$key" '$1 == selected { count++ } END { print count + 0 }' \
    "$development_compose_environment")" \
    || fail "could not count $key in the development Compose environment"
  [[ "$count" == 1 ]] || fail "development Compose environment must define $key exactly once"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' \
    "$development_compose_environment")" \
    || fail "could not read $key from the development Compose environment"
  [[ -n "$value" ]] || fail "development Compose environment contains an empty $key"
  printf '%s' "$value"
}

container_for_service() {
  local project="$1" service="$2" query container
  local -a containers=()
  if ! query="$(docker ps --no-trunc --filter "label=com.docker.compose.project=$project" \
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

verify_unique_network_alias_owner() {
  local network="$1" alias="$2" expected_container="$3" description="$4"
  local expected_full_id network_query container networks owner_count=0
  expected_full_id="$(docker inspect --format '{{.Id}}' "$expected_container")" \
    || fail "could not inspect the expected $description container identity"
  [[ "$expected_full_id" =~ ^[a-f0-9]{64}$ ]] \
    || fail "the expected $description container identity is invalid"
  network_query="$(docker ps --all --no-trunc \
    --filter "network=$network" --format '{{.ID}}')" \
    || fail "could not inspect every $network endpoint for $description alias ownership"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] \
      || fail "Docker returned an invalid $network endpoint ID"
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$container")" \
      || fail "could not inspect a $network endpoint attachment"
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

verify_pre_router_production_runtime() {
  local project="$1" ingress_network="$2" alias="$3" expected_revision="$4"
  local app app_inspection app_image tagged_image router_query
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=release_router')" \
    || fail "could not inspect the pre-router production router inventory"
  [[ -z "$router_query" ]] \
    || fail "pre-router production verification is invalid after a router container exists"
  app="$(container_for_service "$project" app)" \
    || fail "could not resolve the pre-router production application"
  app_inspection="$(docker inspect "$app")" \
    || fail "could not inspect the pre-router production application"
  jq -e --arg project "$project" --arg revision "$expected_revision" \
    --arg legacyRevision "$legacy_f8485_revision" \
    --arg ingress "$ingress_network" --arg alias "$alias" '
    length == 1 and
    .[0].Config.Labels["com.docker.compose.project"] == $project and
    .[0].Config.Labels["com.docker.compose.service"] == "app" and
    (if $revision == $legacyRevision then
       ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
     else .[0].Config.Labels["org.opencontainers.image.revision"] == $revision end) and
    .[0].HostConfig.ReadonlyRootfs == true and
    (if $revision == $legacyRevision then
       (.[0].HostConfig.Init == false or .[0].HostConfig.Init == null)
     else .[0].HostConfig.Init == true end) and
    .[0].HostConfig.Privileged == false and
    ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
    .[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":"3100"}] and
    (.[0].NetworkSettings.Networks | has($ingress)) and
    any(.[0].NetworkSettings.Networks[$ingress].Aliases[]?; . == $alias)
  ' <<<"$app_inspection" >/dev/null \
    || fail "pre-router production application differs from the accepted legacy boundary"
  app_image="$(jq -er '.[0].Image' <<<"$app_inspection")" \
    || fail "pre-router production image identity could not be read"
  [[ "$app_image" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail "pre-router production image identity is invalid"
  if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
    [[ "$app_image" == "$legacy_f8485_image_id" ]] \
      || fail "pre-router f8485 production does not run its one reviewed immutable image"
  else
    tagged_image="$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-app:$expected_revision")" \
      || fail "pre-router production image tag is unavailable"
    [[ "$app_image" == "$tagged_image" ]] \
      || fail "pre-router production does not run its exact locally tagged image"
  fi
  verify_unique_network_alias_owner \
    "$ingress_network" "$alias" "$app" "$project pre-router public backend"
}

verify_exact_f8485_rollback_app() {
  local app app_inspection
  app="$(container_for_service "$production_project" app)" \
    || fail "could not resolve the exact f8485 rollback application"
  app_inspection="$(docker inspect "$app")" \
    || fail "could not inspect the exact f8485 rollback application"
  jq -e --arg imageId "$legacy_f8485_image_id" \
    --arg revision "$legacy_f8485_revision" \
    --arg frontend "$production_frontend_network" '
    . as $root |
    length == 1 and .[0].Image == $imageId and
    ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "") and
    (.[0].Config.Env | index("BUSINESS_FINLYNQ_IMAGE_REVISION=" + $revision)) != null and
    (.[0].Config.Env | index("ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only")) != null and
    .[0].Config.Entrypoint ==
      ["/bin/sh", "/usr/local/bin/business-finlynq-legacy-db-password"] and
    .[0].Config.Cmd == ["node", "server.js"] and
    .[0].HostConfig.ReadonlyRootfs == true and
    .[0].HostConfig.Privileged == false and
    ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
    (.[0].NetworkSettings.Networks | has($frontend)) and
    any(.[0].NetworkSettings.Networks[$frontend].Aliases[]?; . == "release-app") and
    (["ACCOUNT_LOGIN_ENABLED", "AUTH_OIDC_ENABLED", "ACCOUNT_SIGNUP_ENABLED", "AUTH_EMAIL_DELIVERY_ENABLED",
      "BANK_FEEDS_ENABLED", "BUSINESS_WRITES_ENABLED", "DEMO_LOGIN_ENABLED",
      "DEMO_WRITES_ENABLED", "SIGNUP_TURNSTILE_ENABLED", "YAHOO_FX_ENABLED"] |
      all(.[] as $gate; ($root[0].Config.Env | index($gate + "=false")) != null))
  ' <<<"$app_inspection" >/dev/null \
    || fail "the backend accepted as f8485 does not match its exact immutable compatibility contract"
  verify_unique_network_alias_owner \
    "$production_frontend_network" release-app "$app" \
    "exact f8485 rollback private application"
}

verify_release_router_runtime() {
  local project="$1" ingress_network="$2" frontend_network="$3" control_network="$4"
  local alias="$5" state_volume="$6"
  local expected_router_mode="${7:-active}"
  local require_upstream="${8:-true}"
  local router app expected_image router_image_id tagged_image_id runtime_uid
  local router_liveness router_mode
  [[ "$expected_router_mode" == active || "$expected_router_mode" == maintenance \
    || "$expected_router_mode" == active-or-maintenance ]] \
    || fail "invalid expected durable mode for $project/release_router"
  [[ "$require_upstream" == true || "$require_upstream" == false ]] \
    || fail "invalid upstream requirement for $project/release_router"
  router="$(container_for_service "$project" release_router)" \
    || fail "could not resolve the $project release-router container"
  expected_image="$release_router_reference"
  docker inspect "$router" \
    | jq -e --arg project "$project" --arg routerRevision "$release_router_revision" \
        --arg routerContract "$release_router_contract" \
        --arg ingress "$ingress_network" \
        --arg frontend "$frontend_network" --arg control "$control_network" \
        --arg alias "$alias" \
        --arg stateVolume "$state_volume" '
        length == 1
        and .[0].Config.Labels["com.docker.compose.project"] == $project
        and .[0].Config.Labels["com.docker.compose.service"] == "release_router"
        and .[0].Config.Labels["org.opencontainers.image.revision"] == $routerRevision
        and .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $routerContract
        and .[0].Config.User == "10001:10001"
        and .[0].HostConfig.ReadonlyRootfs == true
        and .[0].HostConfig.Privileged == false
        and ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"]
        and ((.[0].HostConfig.SecurityOpt // []) | sort) == ["no-new-privileges:true"]
        and .[0].State.Running == true
        and .[0].State.Health.Status == "healthy"
        and ((.[0].Mounts // []) | length) == 1
        and .[0].Mounts[0].Type == "volume"
        and .[0].Mounts[0].Name == $stateVolume
        and .[0].Mounts[0].Destination == "/state"
        and .[0].Mounts[0].RW == true
        and .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"]
        and .[0].Config.Cmd == ["serve"]
        and ((.[0].NetworkSettings.Networks | keys | sort) ==
          ([$control, $frontend, $ingress] | sort))
        and any(.[0].NetworkSettings.Networks[$ingress].Aliases[]?; . == $alias)
        and all(.[0].NetworkSettings.Networks[$frontend].Aliases[]?; . != $alias)
      ' >/dev/null \
    || fail "$project/release_router image, hardening, health, or network contract differs"
  router_image_id="$(docker inspect --format '{{.Image}}' "$router")" \
    || fail "could not inspect the $project release-router image ID"
  tagged_image_id="$(docker image inspect --format '{{.Id}}' "$expected_image")" \
    || fail "could not inspect the $project release-router tagged image"
  [[ "$router_image_id" =~ ^sha256:[a-f0-9]{64}$ \
    && "$router_image_id" == "$tagged_image_id" ]] \
    || fail "$project/release_router does not run the exact locally tagged release image"
  runtime_uid="$(docker exec "$router" id -u)" \
    || fail "could not inspect the $project release-router runtime UID"
  [[ "$runtime_uid" == 10001 ]] \
    || fail "$project/release_router is not running as the reviewed non-root UID"
  router_mode="$(docker exec "$router" sh -ec '
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  ')" || fail "$project/release_router durable mode could not be inspected"
  [[ "$router_mode" == "$expected_router_mode" \
    || ( "$expected_router_mode" == active-or-maintenance \
      && ( "$router_mode" == active || "$router_mode" == maintenance ) ) ]] \
    || fail "$project/release_router is not durably committed to $expected_router_mode mode"
  verify_unique_network_alias_owner \
    "$ingress_network" "$alias" "$router" "$project public backend"
  if [[ "$require_upstream" == true ]]; then
    app="$(container_for_service "$project" app)" \
      || fail "could not resolve the $project application container"
    verify_unique_network_alias_owner \
      "$frontend_network" release-app "$app" "$project private application"
  fi
  router_liveness="$(docker exec "$router" wget -q -T 10 -O - \
    http://127.0.0.1:3000/_business-finlynq/release-router/live)" \
    || fail "$project release-router liveness endpoint is unavailable"
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$router_liveness" >/dev/null \
    || fail "$project release-router returned an unexpected independent liveness response"
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

wait_for_public_liveness() {
  local hostname="$1" address="$2" headers="$3" body="$4" attempt_limit="$5"
  local attempt curl_exit status
  [[ "$attempt_limit" =~ ^[1-9][0-9]*$ \
    && "$attempt_limit" -le "$public_warmup_attempts" ]] \
    || fail "$hostname liveness retry limit is invalid"
  for (( attempt = 1; attempt <= attempt_limit; attempt++ )); do
    : >"$headers" || fail "could not reset the $hostname liveness response headers"
    : >"$body" || fail "could not reset the $hostname liveness response body"
    if status="$(curl --disable --noproxy '*' --silent --show-error \
      --max-time "$public_warmup_request_timeout_seconds" \
      --resolve "$hostname:443:$address" --dump-header "$headers" \
      --output "$body" --write-out '%{http_code}' "https://$hostname/api/live")"; then
      case "$status" in
        200) return 0 ;;
        502|503) ;;
        *) fail "$hostname liveness route returned HTTP $status" ;;
      esac
    else
      curl_exit=$?
      case "$curl_exit" in
        5|6|7|16|18|28|35|52|55|56|92|95) ;;
        *) fail "$hostname liveness request failed with non-retryable curl status $curl_exit" ;;
      esac
    fi
    if (( attempt == attempt_limit )); then
      fail "$hostname liveness route did not become available after $attempt_limit attempts"
    fi
    sleep "$public_warmup_retry_seconds" \
      || fail "could not wait before retrying the $hostname liveness route"
  done
  fail "$hostname liveness retry loop ended unexpectedly"
}

verify_public_liveness_contract() {
  local hostname="$1" address="$2" headers="$3" body="$4" attempt_limit="$5"
  wait_for_public_liveness "$hostname" "$address" "$headers" "$body" "$attempt_limit"
  jq -e 'type == "object" and keys == ["status"] and .status == "live"' "$body" \
    >/dev/null || fail "$hostname returned an unexpected liveness response"
  grep -Eiq '^cache-control:.*no-store' "$headers" \
    || fail "$hostname liveness response is missing no-store"
  verify_security_headers "$hostname" "$headers"
}

public_contract_is_valid() {
  local hostname="$1" address="$2" legacy_readiness_only="${3:-false}"
  local headers body status request_id metrics_status
  local attempt_limit=1
  headers="$(mktemp)"
  body="$(mktemp)"
  temporary_files+=("$headers" "$body")
  if [[ ( "$warmup_host" == production && "$hostname" == "$production_hostname" ) \
    || ( "$warmup_host" == development && "$hostname" == "$development_hostname" ) ]]; then
    attempt_limit="$public_warmup_attempts"
  fi
  [[ "$legacy_readiness_only" == true || "$legacy_readiness_only" == false ]] \
    || fail "$hostname public-contract mode is invalid"
  if [[ "$legacy_readiness_only" != true ]]; then
    verify_public_liveness_contract "$hostname" "$address" "$headers" "$body" "$attempt_limit"
  fi

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

public_maintenance_contract_is_valid() {
  local hostname="$1" address="$2" journal_sha256="$3"
  local headers body status request_id attempt_limit=1
  [[ "$journal_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || fail "$hostname forward-repair journal digest is invalid"
  headers="$(mktemp)"
  body="$(mktemp)"
  temporary_files+=("$headers" "$body")
  if [[ "$warmup_host" == production && "$hostname" == "$production_hostname" ]]; then
    attempt_limit="$public_warmup_attempts"
  fi

  # The stable router remains independently live while every application route
  # stays deterministic maintenance. This mode is used only to prove a
  # journal-authorized, no-upstream first-router recovery boundary.
  verify_public_liveness_contract "$hostname" "$address" "$headers" "$body" "$attempt_limit"
  : >"$headers" || fail "could not reset the $hostname maintenance response headers"
  : >"$body" || fail "could not reset the $hostname maintenance response body"
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$address" \
    -H 'X-Business-Finlynq-Internal-Health: detailed' \
    -H 'X-Business-Finlynq-Internal-Metrics: detailed' \
    -H 'X-Request-Id: untrusted-public-request-id' \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    "https://$hostname/api/health")" \
    || fail "$hostname maintenance readiness route is unavailable through the external edge"
  [[ "$status" == 503 ]] \
    || fail "$hostname forward-repair readiness must return deterministic HTTP 503"
  jq -e 'type == "object" and keys == ["status"] and .status == "unavailable"' \
    "$body" >/dev/null \
    || fail "$hostname forward-repair readiness body is not deterministic maintenance"
  grep -Eiq '^cache-control:.*no-store' "$headers" \
    || fail "$hostname forward-repair readiness is missing no-store"
  grep -Eiq '^retry-after:[[:space:]]*5[[:space:]\r]*$' "$headers" \
    || fail "$hostname forward-repair readiness is missing the reviewed retry boundary"
  grep -Eiq '^content-type:[[:space:]]*application/json;[[:space:]]*charset=utf-8[[:space:]\r]*$' \
    "$headers" \
    || fail "$hostname forward-repair readiness has an unexpected content type"
  verify_security_headers "$hostname" "$headers"
  request_id="$(awk -F: 'tolower($1) == "x-request-id" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print }' \
    "$headers")"
  [[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
    && "$request_id" != untrusted-public-request-id ]] \
    || fail "$hostname did not replace the untrusted maintenance request ID"
  http_redirect_is_exact "$hostname" "$address"
  tls_is_valid "$hostname" "$address"
}

while (( $# > 0 )); do
  case "$1" in
    --scope)
      (( $# >= 2 )) || fail "--scope requires preflight, development, production, or full"
      scope="$2"
      shift 2
      ;;
    --allow-development-router-maintenance)
      development_router_mode="active-or-maintenance"
      shift
      ;;
    --allow-production-router-maintenance)
      allow_production_router_maintenance="true"
      production_router_mode="active-or-maintenance"
      shift
      ;;
    --expected-production-revision)
      (( $# >= 2 )) || fail "--expected-production-revision requires a full Git SHA"
      expected_production_revision="$2"
      shift 2
      ;;
    --allow-f8485-minimal-production-health)
      allow_legacy_minimal_production_health="true"
      shift
      ;;
    --allow-pre-router-production)
      allow_pre_router_production="true"
      shift
      ;;
    --allow-first-router-forward-repair)
      (( $# >= 2 )) \
        || fail "--allow-first-router-forward-repair requires the exact journal SHA-256"
      allow_first_router_forward_repair="true"
      first_router_forward_repair_journal_sha256="$2"
      production_router_mode="maintenance"
      shift 2
      ;;
    --warmup-host)
      (( $# >= 2 )) || fail "--warmup-host requires production or development"
      warmup_host="$2"
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$scope" == preflight || "$scope" == development || "$scope" == production \
  || "$scope" == full ]] \
  || fail "--scope must be preflight, development, production, or full"
[[ "$warmup_host" == none || "$warmup_host" == production \
  || "$warmup_host" == development ]] \
  || fail "--warmup-host must be production or development"
[[ "$warmup_host" != production || "$scope" == full || "$scope" == production ]] \
  || fail "production warmup is valid only for the production or full scope"
[[ "$warmup_host" != development || "$scope" == development ]] \
  || fail "development warmup is valid only for the development scope"
[[ "$development_router_mode" == active \
  || ( "$development_router_mode" == active-or-maintenance && "$scope" == development ) ]] \
  || fail "development maintenance mode is valid only for the development scope"
[[ "$production_router_mode" == active \
  || ( "$production_router_mode" == active-or-maintenance && "$scope" == production ) \
  || ( "$production_router_mode" == maintenance && "$scope" == production \
    && "$allow_first_router_forward_repair" == true ) ]] \
  || fail "production maintenance mode is valid only for the production scope"
[[ -z "$expected_production_revision" \
  || ( "$scope" == production \
    && "$expected_production_revision" =~ ^[a-f0-9]{40}$ \
    && ! "$expected_production_revision" =~ ^0+$ ) ]] \
  || fail "an expected production revision is valid only for production scope and must be a full Git SHA"
if [[ "$allow_legacy_minimal_production_health" == true ]]; then
  [[ "$scope" == production \
    && "$expected_production_revision" == "$legacy_f8485_revision" \
    && "${ROLLBACK_COMPATIBILITY_ACK:-}" == f8485-one-release-only ]] \
    || fail "minimal production health is restricted to the acknowledged exact f8485 rollback"
fi
if [[ "$allow_pre_router_production" == true ]]; then
  [[ "$scope" == production \
    && "$expected_production_revision" =~ ^[a-f0-9]{40}$ \
    && ! "$expected_production_revision" =~ ^0+$ \
    && "$allow_legacy_minimal_production_health" == false ]] \
    || fail "pre-router production verification requires an exact production release transition"
fi
if [[ "$allow_first_router_forward_repair" == true ]]; then
  [[ "$scope" == production \
    && "$expected_production_revision" =~ ^[a-f0-9]{40}$ \
    && ! "$expected_production_revision" =~ ^0+$ \
    && "$first_router_forward_repair_journal_sha256" =~ ^[a-f0-9]{64}$ \
    && "$production_router_mode" == maintenance \
    && "$allow_production_router_maintenance" == false \
    && "$allow_pre_router_production" == false \
    && "$allow_legacy_minimal_production_health" == false ]] \
    || fail "first-router forward repair requires exact production maintenance and journal identity"
fi
[[ "$(id -u)" == 0 ]] || fail "run this command as root"
for command_name in awk bash curl date docker env grep id jq mktemp openssl rm sha256sum \
  sleep sort stat timeout wc; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
[[ -f "$compose_environment" && ! -L "$compose_environment" \
  && "$(stat -c '%U:%G:%a' -- "$compose_environment")" == root:deploy:600 ]] \
  || fail "the canonical Compose environment is unavailable or unsafe"
if [[ "$scope" != production ]]; then
  [[ -f "$development_compose_environment" && ! -L "$development_compose_environment" \
    && "$(stat -c '%U:%G:%a' -- "$development_compose_environment")" == root:deploy:600 ]] \
    || fail "the development Compose environment is unavailable or unsafe"
fi

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
active_config_sha256="$(read_environment_value BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256)" \
  || fail "could not read BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256"
production_network="$(read_environment_value BUSINESS_FINLYNQ_EDGE_NETWORK)" \
  || fail "could not read BUSINESS_FINLYNQ_EDGE_NETWORK"
production_private_network="$(read_environment_value BUSINESS_FINLYNQ_PRIVATE_NETWORK)" \
  || fail "could not read BUSINESS_FINLYNQ_PRIVATE_NETWORK"
production_alias="$(read_environment_value BUSINESS_FINLYNQ_APP_NETWORK_ALIAS)" \
  || fail "could not read BUSINESS_FINLYNQ_APP_NETWORK_ALIAS"
configured_production_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)" \
  || fail "could not read BUSINESS_FINLYNQ_IMAGE_REVISION"
development_edge_network=""
development_private_network=""
development_alias=""
development_revision=""
if [[ "$scope" != production ]]; then
  development_edge_network="$(read_development_environment_value BUSINESS_FINLYNQ_EDGE_NETWORK)" \
    || fail "could not read development BUSINESS_FINLYNQ_EDGE_NETWORK"
  development_private_network="$(read_development_environment_value BUSINESS_FINLYNQ_PRIVATE_NETWORK)" \
    || fail "could not read development BUSINESS_FINLYNQ_PRIVATE_NETWORK"
  development_alias="$(read_development_environment_value BUSINESS_FINLYNQ_APP_NETWORK_ALIAS)" \
    || fail "could not read development BUSINESS_FINLYNQ_APP_NETWORK_ALIAS"
  development_revision="$(read_development_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)" \
    || fail "could not read development BUSINESS_FINLYNQ_IMAGE_REVISION"
fi
production_hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" \
  || fail "could not read BUSINESS_FINLYNQ_HOSTNAME"
production_revision="${expected_production_revision:-$configured_production_revision}"
[[ "$configured_production_revision" =~ ^[a-f0-9]{40}$ \
  && ! "$configured_production_revision" =~ ^0+$ \
  && "$production_revision" =~ ^[a-f0-9]{40}$ \
  && ! "$production_revision" =~ ^0+$ ]] \
  || fail "production revision metadata is invalid"
pre_router_legacy_mode="false"
if [[ "$allow_pre_router_production" == true \
  && "$production_revision" == "$legacy_f8485_revision" ]]; then
  pre_router_legacy_mode="true"
fi
if [[ "$allow_pre_router_production" == true ]]; then
  [[ "${RELEASE_EXECUTION_ACK:-}" == release:"$configured_production_revision":* ]] \
    || fail "pre-router production verification requires the active candidate release acknowledgement"
fi
if [[ "$allow_first_router_forward_repair" == true ]]; then
  [[ "$expected_production_revision" == "$configured_production_revision" \
    && "${RELEASE_EXECUTION_ACK:-}" =~ ^release:${configured_production_revision}:[a-z0-9][a-z0-9._-]{2,30}$ \
    && "${FIRST_ROUTER_FORWARD_REPAIR_ACK:-}" \
      == "forward-repair:$configured_production_revision:$first_router_forward_repair_journal_sha256" ]] \
    || fail "first-router forward repair acknowledgements do not match the exact candidate and journal"
fi
development_hostname=""
epm_hostname=""
if [[ "$scope" != production ]]; then
  development_hostname="$(read_environment_value BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME)" \
    || fail "could not read BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME"
  epm_hostname="$(read_environment_value EPM_FINLYNQ_HOSTNAME)" \
    || fail "could not read EPM_FINLYNQ_HOSTNAME"
fi
readonly external_project external_service external_owner external_image external_image_id
readonly external_config external_config_source external_public_ipv4s_csv route_source
readonly route_destination route_sha256 caddy_data_volume caddy_config_volume
readonly active_config_sha256 production_network
readonly production_private_network production_alias configured_production_revision production_revision
readonly pre_router_legacy_mode
readonly development_edge_network development_private_network development_alias development_revision
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
! grep -Eq '^[[:space:]]*log_credentials([[:space:]]|$)' "$external_config_source" \
  || fail "external edge must keep Caddy credential redaction enabled"
config_source_mode="$(stat -c '%a' -- "$external_config_source")"
config_source_uid="$(stat -c '%u' -- "$external_config_source")"
deploy_uid="$(id -u deploy 2>/dev/null)" || fail "the deploy account is unavailable"
[[ "$config_source_mode" =~ ^[0-7]{3,4}$ && "$config_source_uid" == 0 ]] \
  || fail "the external edge configuration source has unsafe ownership or mode"
(( (8#$config_source_mode & 8#022) == 0 )) \
  || fail "the external edge configuration source is group- or other-writable"
[[ "$production_network" == business_finlynq_edge ]] \
  || fail "production must use the reviewed external edge network"
[[ "$production_private_network" == business_finlynq_private \
  && "$production_alias" == production-app ]] \
  || fail "production must use the reviewed private network and public backend alias"
if [[ "$scope" != production ]]; then
  [[ "$development_edge_network" == "$development_network" \
    && "$development_private_network" == business_finlynq_development_private \
    && "$development_alias" == development-app ]] \
    || fail "development must use the reviewed private network and public backend alias"
fi
[[ "$production_hostname" == business.finlynq.com ]] \
  || fail "the production hostname must use the reviewed name"
if [[ "$scope" != production ]]; then
  [[ "$development_hostname" == dev.business.finlynq.com \
    && "$epm_hostname" == epm.finlynq.com ]] \
    || fail "development and EPM hostnames must use the reviewed names"
fi

projects_to_check=("$production_project")
[[ "$scope" == production ]] || projects_to_check+=("$development_project")
for project in "${projects_to_check[@]}"; do
  if ! business_edge_query="$(docker ps --all \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=edge' --format '{{.ID}}')"; then
    fail "could not inspect $project edge residue"
  fi
  [[ -z "$business_edge_query" ]] \
    || fail "$project must not run a Compose-owned edge in external mode"
done
networks_to_check=("$production_network")
[[ "$scope" == production ]] || networks_to_check+=("$development_network")
for network in "${networks_to_check[@]}"; do
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
expected_edge_networks_sorted="$(printf '%s\n' "${expected_full_edge_networks[@]}" | sort)" \
  || fail "could not prepare the protected external edge network inventory"
[[ "$actual_edge_networks" == "$expected_edge_networks_sorted" ]] \
  || fail "external edge network attachments differ from the protected full inventory"

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
elif [[ "$scope" == full || "$scope" == production ]]; then
  if [[ "$allow_pre_router_production" == true ]]; then
    verify_pre_router_production_runtime "$production_project" "$production_network" \
      "$production_alias" "$production_revision"
  elif [[ "$allow_first_router_forward_repair" == true ]]; then
    verify_release_router_runtime "$production_project" "$production_network" \
      "$production_frontend_network" "$production_router_control_network" \
      "$production_alias" "$production_router_state_volume" maintenance false
  else
    verify_release_router_runtime "$production_project" "$production_network" \
      "$production_frontend_network" "$production_router_control_network" \
      "$production_alias" "$production_router_state_volume" "$production_router_mode"
  fi
  if [[ "$allow_legacy_minimal_production_health" == true ]]; then
    verify_exact_f8485_rollback_app
  fi
fi
if [[ "$scope" != production ]]; then
  verify_release_router_runtime "$development_project" "$development_network" \
    "$development_frontend_network" "$development_router_control_network" \
    "$development_alias" "$development_router_state_volume" "$development_router_mode"
fi

mounts="$(docker inspect --format '{{json .Mounts}}' "$edge_container")" \
  || fail "could not inspect external edge mounts"
jq -e --arg configSource "$external_config_source" --arg configDestination "$external_config" \
    --arg routeSource "$route_source" --arg routeDestination "$route_destination" \
    --arg consultSource "$consult_route_source" \
    --arg consultDestination "$consult_route_destination" \
    --arg dataVolume "$caddy_data_volume" --arg configVolume "$caddy_config_volume" '
    length == 5
    and any(.[]; .Type == "bind" and .Source == $configSource
      and .Destination == $configDestination and .RW == false)
    and any(.[]; .Type == "bind" and .Source == $routeSource
      and .Destination == $routeDestination and .RW == false)
    and any(.[]; .Type == "bind" and .Source == $consultSource
      and .Destination == $consultDestination and .RW == false)
    and any(.[]; .Type == "volume" and .Name == $dataVolume
      and .Destination == "/data" and .RW == true)
    and any(.[]; .Type == "volume" and .Name == $configVolume
      and .Destination == "/config" and .RW == true)
    and all(.[]; .Destination != "/config/epm-basic-auth")
  ' <<<"$mounts" >/dev/null \
  || fail "external edge mounts differ from the protected Caddy and Consult inventory"
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
if [[ "$scope" != production ]]; then
  docker exec "$edge_container" grep -Fq "$epm_hostname" "$external_config" \
    || fail "the external edge configuration no longer preserves the EPM hostname"
  docker exec "$edge_container" grep -Eq '^[[:space:]]*log_skip[[:space:]]+/auth/callback[[:space:]]*$' \
    "$external_config" \
    || fail "the external edge configuration no longer excludes EPM callbacks from logs"
fi
docker exec "$edge_container" caddy validate --config "$external_config" --adapter caddyfile \
  >/dev/null 2>&1 || fail "the external edge Caddy configuration is invalid"
docker exec "$edge_container" wget -q -T 10 -O - http://127.0.0.1:2019/config/ \
  | jq -e '[.. | objects | select(has("should_log_credentials")) |
      .should_log_credentials] | all(. != true)' >/dev/null \
  || fail "loaded external edge configuration exposes credential headers in access logs"
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
if [[ "$scope" == full || "$scope" == production ]]; then
  production_outer_health="$(docker exec "$edge_container" wget -q -T 10 -O - \
    http://production-app:3000/api/health)" \
    || fail "the external edge cannot reach the production release-router health probe"
  if [[ "$allow_pre_router_production" == true ]]; then
    jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
      <<<"$production_outer_health" >/dev/null \
      || fail "the pre-router production app did not preserve minimal public readiness"
  else
    jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
      <<<"$production_outer_health" >/dev/null \
      || fail "the production router does not preserve the outer active-health response"
  fi
  if [[ "$allow_first_router_forward_repair" == true ]]; then
    production_router_liveness="$(docker exec "$edge_container" wget -q -T 10 -O - \
      http://production-app:3000/api/live)" \
      || fail "the external edge cannot reach the maintenance router liveness route"
    jq -e 'type == "object" and keys == ["status"] and .status == "live"' \
      <<<"$production_router_liveness" >/dev/null \
      || fail "the maintenance router returned an unexpected liveness response"
  else
    production_router_readiness="$(docker exec "$edge_container" wget -q -T 10 \
      --header='X-Business-Finlynq-Internal-Health: 1' -O - \
      http://production-app:3000/api/health)" \
      || fail "the external edge cannot reach the production backend"
    if [[ "$allow_legacy_minimal_production_health" == true \
      || "$pre_router_legacy_mode" == true ]]; then
      jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
        <<<"$production_router_readiness" >/dev/null \
        || fail "the exact f8485 production router did not return its reviewed minimal readiness"
    else
      jq -e --arg revision "$production_revision" '
        type == "object" and .status == "ready" and .revision == $revision
      ' <<<"$production_router_readiness" >/dev/null \
        || fail "the production router did not return detailed readiness for its exact release"
    fi
  fi
fi
if [[ "$scope" != production ]]; then
  development_outer_health="$(docker exec "$edge_container" wget -q -T 10 -O - \
    http://development-app:3000/api/health)" \
    || fail "the external edge cannot reach the development release-router health probe"
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$development_outer_health" >/dev/null \
    || fail "the development router does not preserve the outer active-health response"
  development_router_readiness="$(docker exec "$edge_container" wget -q -T 10 \
    --header='X-Business-Finlynq-Internal-Health: 1' -O - \
    http://development-app:3000/api/health)" \
    || fail "the external edge cannot reach the development backend"
  jq -e --arg revision "$development_revision" '
    type == "object" and .status == "ready" and .revision == $revision
  ' <<<"$development_router_readiness" >/dev/null \
    || fail "the development router did not return detailed readiness for its exact release"
  docker exec "$edge_container" wget -q -T 10 -O /dev/null \
    http://epm-finlynq-api:7100/health \
    || fail "the external edge cannot reach the EPM API backend"
  docker exec "$edge_container" wget -q -T 10 -O /dev/null \
    http://epm-finlynq-console:7090/api/health \
    || fail "the external edge cannot reach the EPM console backend"
fi

temporary_files=()
cleanup() {
  rm -f -- "${temporary_files[@]}"
}
trap cleanup EXIT INT TERM
for address in "${expected_public_ipv4s[@]}"; do
  if [[ "$scope" == full || "$scope" == production ]]; then
    if [[ "$allow_first_router_forward_repair" == true ]]; then
      public_maintenance_contract_is_valid "$production_hostname" "$address" \
        "$first_router_forward_repair_journal_sha256"
    else
      public_contract_is_valid "$production_hostname" "$address" "$pre_router_legacy_mode"
    fi
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
    verify_security_headers "$production_hostname" "$preflight_headers"
    http_redirect_is_exact "$production_hostname" "$address"
    tls_is_valid "$production_hostname" "$address"
  fi
  if [[ "$scope" != production ]]; then
    public_contract_is_valid "$development_hostname" "$address"
    http_redirect_is_exact "$epm_hostname" "$address"
    tls_is_valid "$epm_hostname" "$address"
    epm_headers="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
      --resolve "$epm_hostname:443:$address" --dump-header - --output /dev/null \
      "https://$epm_hostname/")" \
      || fail "the EPM public route could not be checked on $address"
    epm_status="$(awk 'NR == 1 { print $2 }' <<<"$epm_headers")"
    [[ "$epm_status" == 302 ]] \
      || fail "the EPM console did not begin the application-owned OIDC flow on $address"
    grep -Eiq '^location:[[:space:]]*/auth/login\r?$' <<<"$epm_headers" \
      || fail "the EPM console did not redirect to its OIDC login endpoint on $address"
    ! grep -Eiq '^www-authenticate:' <<<"$epm_headers" \
      || fail "the EPM console still advertises proxy authentication on $address"
    grep -Eiq '^permissions-policy:[[:space:]]*camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)\r?$' \
      <<<"$epm_headers" \
      || fail "the EPM console response is missing its browser permissions policy on $address"
  fi
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
callback_targets=()
if [[ "$scope" != production ]]; then
  callback_targets+=(
    "$development_hostname|/api/document-storage/callback/$callback_sentinel?code=$callback_sentinel&state=$callback_sentinel"
    "$epm_hostname|/auth/callback?code=$callback_sentinel&state=$callback_sentinel"
  )
fi
if [[ "$scope" == full || "$scope" == production ]]; then
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
  control_hostname="$development_hostname"
  [[ "$scope" == production ]] && control_hostname="$production_hostname"
  control_path="/api/live?edge_log_control=$control_sentinel"
  if [[ "$scope" == production && "$pre_router_legacy_mode" == true ]]; then
    control_path="/api/health?edge_log_control=$control_sentinel"
  fi
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 20 --output /dev/null \
    --resolve "$control_hostname:443:$address" \
    "https://$control_hostname$control_path" \
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
