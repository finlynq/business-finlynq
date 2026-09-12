#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly production_environment="/etc/business-finlynq/compose.env"
readonly development_environment="/etc/business-finlynq-development/compose.env"
readonly production_project="business-finlynq"
readonly development_project="business-finlynq-development"
readonly production_network="business_finlynq_edge"
readonly development_network="business_finlynq_development_edge"
readonly production_alias="production-app"
readonly development_alias="development-app"
readonly production_loopback_port="3100"
readonly development_loopback_port="3200"
readonly production_hostname="business.finlynq.com"
readonly development_hostname="dev.business.finlynq.com"
readonly central_project="finlynq-shared-edge"
readonly central_service="edge"
readonly central_container_name="finlynq-shared-edge-edge-1"
readonly central_owner="finlynq-shared-edge"
readonly central_contract="v1"
readonly public_ipv4="51.161.113.222"
readonly legacy_f8485_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
readonly release_router_reference="business-finlynq-release-router:v2"
readonly release_router_revision="release-router-v2"
readonly release_router_contract="v2"
readonly minimum_tls_seconds="$((21 * 24 * 60 * 60))"
readonly public_warmup_attempts=15
readonly public_warmup_retry_seconds=2
readonly public_warmup_request_timeout_seconds=2
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

scope="full"
warmup_host="none"
expected_production_revision=""
allow_legacy_minimal_production_health="false"
allow_pre_router_production="false"
allow_production_router_maintenance="false"
allow_development_router_maintenance="false"
expect_development_live_uncommitted="false"
allow_first_router_forward_repair="false"
first_router_forward_repair_journal_sha256=""
temporary_files=()

fail() {
  printf 'Business Finlynq external-edge verification failed: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if (( ${#temporary_files[@]} > 0 )); then
    rm -f -- "${temporary_files[@]}"
  fi
}
trap cleanup EXIT INT TERM

# Edge attestation always inspects the local daemon; ambient Docker settings
# and caller-supplied Compose values cannot redirect these read-only checks.
docker() {
  env -i PATH="$clean_path" docker "$@"
}

read_environment_value() {
  local file="$1" key="$2" value count
  count="$(awk -F= -v selected="$key" '$1 == selected { count++ } END { print count + 0 }' \
    "$file")" || fail "could not count $key"
  [[ "$count" == 1 ]] || fail "$file must define $key exactly once"
  value="$(awk -F= -v selected="$key" '$1 == selected { sub(/^[^=]*=/, ""); print }' \
    "$file")" || fail "could not read $key"
  [[ -n "$value" ]] || fail "$file contains an empty $key"
  printf '%s' "$value"
}

# Parse a raw curl header block. AWK strips the actual trailing CR byte from
# every line, then requires one case-insensitive field with one exact value.
header_value_is_exact() {
  local headers="$1" header_name="$2" expected_value="$3"
  awk -v wanted_name="$header_name" -v wanted_value="$expected_value" '
    BEGIN { cr = sprintf("%c", 13) }
    {
      line = $0
      if (substr(line, length(line), 1) == cr) {
        line = substr(line, 1, length(line) - 1)
      }
      separator = index(line, ":")
      if (separator == 0) next
      name = substr(line, 1, separator - 1)
      if (tolower(name) != tolower(wanted_name)) next
      value = substr(line, separator + 1)
      sub(/^[ \t]*/, "", value)
      sub(/[ \t]*$/, "", value)
      count++
      if (value == wanted_value) exact++
    }
    END { exit !(count == 1 && exact == 1) }
  ' <<<"$headers"
}

# Cache-Control directives are case-insensitive and may share one field line.
# Require one unambiguous field containing a bare no-store directive. Reject
# directives that permit shared/public caching or a positive freshness lifetime.
cache_control_is_safe_no_store() {
  local headers="$1"
  awk '
    BEGIN { cr = sprintf("%c", 13) }
    {
      line = $0
      if (substr(line, length(line), 1) == cr) {
        line = substr(line, 1, length(line) - 1)
      }
      separator = index(line, ":")
      if (separator == 0) next
      name = substr(line, 1, separator - 1)
      if (tolower(name) != "cache-control") next
      header_count++
      header_value = substr(line, separator + 1)
      sub(/^[ \t]*/, "", header_value)
      sub(/[ \t]*$/, "", header_value)
    }
    END {
      if (header_count != 1 || header_value == "") exit 1
      directive_count = split(header_value, directives, ",")
      for (part_number = 1; part_number <= directive_count; part_number++) {
        directive = directives[part_number]
        sub(/^[ \t]*/, "", directive)
        sub(/[ \t]*$/, "", directive)
        if (directive == "") exit 1

        equals = index(directive, "=")
        if (equals == 0) {
          directive_name = tolower(directive)
          directive_value = ""
          has_value = 0
        } else {
          directive_name = substr(directive, 1, equals - 1)
          directive_value = substr(directive, equals + 1)
          sub(/^[ \t]*/, "", directive_name)
          sub(/[ \t]*$/, "", directive_name)
          sub(/^[ \t]*/, "", directive_value)
          sub(/[ \t]*$/, "", directive_value)
          directive_name = tolower(directive_name)
          has_value = 1
        }
        if (directive_name !~ /^[a-z][a-z0-9-]*$/ || seen[directive_name]++) exit 1

        if (directive_name == "no-store") {
          if (has_value) exit 1
          found_no_store = 1
        } else if (directive_name == "public" || directive_name == "s-maxage") {
          exit 1
        } else if (directive_name == "max-age") {
          if (!has_value || directive_value !~ /^0+$/) exit 1
        }
      }
      exit !found_no_store
    }
  ' <<<"$headers"
}

container_for_service() {
  local project="$1" service="$2" query container
  local -a containers=()
  query="$(docker ps --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.ID}}')" || fail "could not inspect $project/$service"
  while IFS= read -r container; do
    [[ -n "$container" ]] && containers+=("$container")
  done <<<"$query"
  [[ "${#containers[@]}" == 1 ]] \
    || fail "exactly one running $project/$service container is required"
  printf '%s' "${containers[0]}"
}

network_is_contract_dependency() {
  local network="$1"
  docker network inspect "$network" 2>/dev/null | jq -e '
    length == 1 and .[0].Driver == "bridge" and .[0].Scope == "local" and
    .[0].Internal == true and .[0].Attachable == false and .[0].Ingress == false
  ' >/dev/null
}

verify_unique_network_alias_owner() {
  local network="$1" alias="$2" expected_container="$3" description="$4"
  local expected_id query container networks owner_count=0
  expected_id="$(docker inspect --format '{{.Id}}' "$expected_container")" \
    || fail "could not inspect $description identity"
  query="$(docker ps --all --no-trunc --filter "network=$network" --format '{{.ID}}')" \
    || fail "could not inspect $network endpoints"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$container")" \
      || fail "could not inspect a $network endpoint"
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
      [[ "$container" == "$expected_id" ]] \
        || fail "$description alias is owned by another endpoint"
    fi
  done <<<"$query"
  [[ "$owner_count" == 1 ]] || fail "$description alias must be owned exactly once"
}

verify_business_runtime() {
  local project="$1" network="$2" alias="$3" loopback_port="$4"
  local expected_revision="$5" allow_pre_router="$6" allow_legacy_minimal="$7"
  local expect_live_uncommitted="$8"
  local router app app_inspection router_query router_mode detailed_health
  local edge_query router_image_id tagged_router_image_id
  network_is_contract_dependency "$network" \
    || fail "$network is not the required existing internal local bridge"
  edge_query="$(docker ps --all --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=edge' --format '{{.ID}}')" \
    || fail "could not inspect $project edge residue"
  [[ -z "$edge_query" ]] || fail "$project must not run an application-owned edge service"

  app="$(container_for_service "$project" app)"
  app_inspection="$(docker inspect "$app")" || fail "could not inspect $project application"
  jq -e --arg project "$project" --arg revision "$expected_revision" \
    --arg legacyRevision "$legacy_f8485_revision" --arg legacyImage "$legacy_f8485_image_id" '
    length == 1 and .[0].Config.Labels["com.docker.compose.project"] == $project and
    .[0].Config.Labels["com.docker.compose.service"] == "app" and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
    (if $revision == $legacyRevision then
       .[0].Image == $legacyImage and
       ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
     else
       .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
       (.[0].Config.Env | index("BUSINESS_FINLYNQ_IMAGE_REVISION=" + $revision)) != null
     end)
  ' <<<"$app_inspection" >/dev/null \
    || fail "$project application does not run the expected immutable revision"
  if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
    [[ "$allow_pre_router" == true || "$allow_legacy_minimal" == true ]] \
      || fail "the f8485 application requires its explicit compatibility boundary"
  fi

  router_query="$(docker ps --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=release_router' \
    --format '{{.ID}}')" || fail "could not inspect $project release router"
  if [[ -z "$router_query" && "$allow_pre_router" == true ]]; then
    jq -e --arg project "$project" --arg network "$network" \
      --arg alias "$alias" '
      length == 1 and .[0].Config.Labels["com.docker.compose.project"] == $project and
      .[0].Config.Labels["com.docker.compose.service"] == "app" and
      .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
      (.[0].NetworkSettings.Networks | has($network)) and
      any(.[0].NetworkSettings.Networks[$network].Aliases[]?; . == $alias)
    ' <<<"$app_inspection" >/dev/null \
      || fail "$project pre-router application is not healthy and canonical"
    jq -e --arg port "$loopback_port" '
      .[0].HostConfig.PortBindings["3000/tcp"] ==
        [{"HostIp":"127.0.0.1", "HostPort":$port}]
    ' <<<"$app_inspection" >/dev/null \
      || fail "$project pre-router loopback port differs from its contract"
    verify_unique_network_alias_owner "$network" "$alias" "$app" "$project public backend"
    detailed_health="$(curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 \
      -H 'X-Business-Finlynq-Internal-Health: 1' \
      "http://127.0.0.1:$loopback_port/api/health")" \
      || fail "$project pre-router application health endpoint is unavailable"
    if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
      jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
        <<<"$detailed_health" >/dev/null \
        || fail "$project legacy pre-router readiness is unexpected"
    else
      jq -e --arg revision "$expected_revision" \
        'type == "object" and .status == "ready" and .revision == $revision' \
        <<<"$detailed_health" >/dev/null \
        || fail "$project pre-router readiness does not identify its expected revision"
    fi
    printf 'active'
    return 0
  fi

  router="$(container_for_service "$project" release_router)"
  docker inspect "$router" | jq -e --arg project "$project" --arg network "$network" \
    --arg alias "$alias" --arg port "$loopback_port" \
    --arg routerRevision "$release_router_revision" \
    --arg routerContract "$release_router_contract" '
    length == 1 and .[0].Config.Labels["com.docker.compose.project"] == $project and
    .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $routerRevision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $routerContract and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
    .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Privileged == false and
    ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    .[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":$port}] and
    (.[0].NetworkSettings.Networks | has($network)) and
    any(.[0].NetworkSettings.Networks[$network].Aliases[]?; . == $alias)
  ' >/dev/null || fail "$project release router is not healthy and canonical"
  [[ "$(docker inspect --format '{{.Config.Image}}' "$router")" == "$release_router_reference" ]] \
    || fail "$project release router does not use its versioned image reference"
  router_image_id="$(docker inspect --format '{{.Image}}' "$router")" \
    || fail "could not inspect $project release-router image identity"
  tagged_router_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" \
    || fail "the versioned release-router image is unavailable"
  [[ "$router_image_id" == "$tagged_router_image_id" ]] \
    || fail "$project release router does not run the exact locally tagged image"
  verify_unique_network_alias_owner "$network" "$alias" "$router" "$project public backend"
  router_mode="$(docker exec "$router" sh -ec 'cat /state/mode')" \
    || fail "$project release-router mode could not be read"
  [[ "$router_mode" == active || "$router_mode" == maintenance ]] \
    || fail "$project release-router mode is invalid"
  if [[ "$expect_live_uncommitted" == true ]]; then
    [[ "$project" == "$development_project" && "$router_mode" == maintenance ]] \
      || fail "development live-uncommitted verification requires durable maintenance mode"
  fi
  if [[ "$router_mode" == active || "$expect_live_uncommitted" == true ]]; then
    detailed_health="$(curl --disable --noproxy '*' --fail --silent --show-error --max-time 10 \
      -H 'X-Business-Finlynq-Internal-Health: 1' \
      "http://127.0.0.1:$loopback_port/api/health")" \
      || fail "$project internal readiness endpoint is unavailable"
    if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
      jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
        <<<"$detailed_health" >/dev/null \
        || fail "$project legacy readiness is unexpected"
    else
      jq -e --arg revision "$expected_revision" \
        'type == "object" and .status == "ready" and .revision == $revision' \
        <<<"$detailed_health" >/dev/null \
        || fail "$project readiness does not identify its expected revision"
    fi
  fi
  printf '%s' "$router_mode"
}

resolve_development_public_contract() {
  local durable_mode="$1"
  [[ "$durable_mode" == active || "$durable_mode" == maintenance ]] \
    || fail "development release-router mode is invalid"
  if [[ "$expect_development_live_uncommitted" == true ]]; then
    [[ "$allow_development_router_maintenance" == false ]] \
      || fail "development router verification flags are ambiguous"
    [[ "$durable_mode" == maintenance ]] \
      || fail "development live-uncommitted verification requires durable maintenance mode"
    printf 'active'
  elif [[ "$durable_mode" == maintenance ]]; then
    [[ "$allow_development_router_maintenance" == true ]] \
      || fail "development maintenance was not explicitly allowed"
    printf 'maintenance'
  else
    printf 'active'
  fi
}

verify_central_edge() {
  local container inspection bindings expected_bindings network
  container="$(container_for_service "$central_project" "$central_service")"
  inspection="$(docker inspect "$container")" || fail "could not inspect the central edge"
  jq -e --arg id "$container" --arg name "/$central_container_name" \
    --arg project "$central_project" --arg service "$central_service" \
    --arg owner "$central_owner" --arg contract "$central_contract" '
    length == 1 and .[0].Id == $id and .[0].Name == $name and
    .[0].Config.Labels["com.docker.compose.project"] == $project and
    .[0].Config.Labels["com.docker.compose.service"] == $service and
    .[0].Config.Labels["com.finlynq.edge-owner"] == $owner and
    .[0].Config.Labels["com.finlynq.edge-contract"] == $contract and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy"
  ' <<<"$inspection" >/dev/null \
    || fail "the central edge does not expose the contract-v1 runtime identity"

  bindings="$(jq -r '.[0].HostConfig.PortBindings | to_entries[] as $entry |
    $entry.value[] | "\(.HostIp)|\(.HostPort)|\($entry.key)"' <<<"$inspection" | sort)" \
    || fail "central edge bindings could not be read"
  expected_bindings="$(printf '%s\n' \
    "$public_ipv4|80|80/tcp" "$public_ipv4|443|443/tcp" "$public_ipv4|443|443/udp" | sort)"
  [[ "$bindings" == "$expected_bindings" ]] \
    || fail "central edge public bindings differ from shared-edge contract v1"

  for network in "$@"; do
    jq -e --arg network "$network" '.[0].NetworkSettings.Networks | has($network)' \
      <<<"$inspection" >/dev/null \
      || fail "central edge is not attached to required Business network $network"
  done
  printf '%s' "$container"
}

verify_security_headers() {
  local hostname="$1" headers="$2" contents
  contents="$(<"$headers")"
  header_value_is_exact "$contents" strict-transport-security \
    'max-age=31536000; includeSubDomains' \
    || fail "$hostname does not return the reviewed HSTS policy"
  header_value_is_exact "$contents" x-content-type-options nosniff \
    || fail "$hostname is missing X-Content-Type-Options"
  header_value_is_exact "$contents" x-frame-options DENY \
    || fail "$hostname is missing the reviewed frame policy"
  header_value_is_exact "$contents" referrer-policy strict-origin-when-cross-origin \
    || fail "$hostname is missing the reviewed referrer policy"
  ! grep -Eiq '^server:' "$headers" || fail "$hostname exposed the edge server header"
}

tls_is_valid() {
  local hostname="$1"
  timeout 25s openssl s_client -connect "$public_ipv4:443" -servername "$hostname" \
    </dev/null 2>/dev/null | openssl x509 -checkend "$minimum_tls_seconds" -noout >/dev/null \
    || fail "$hostname TLS certificate is invalid or expires within 21 days"
}

http_redirect_is_exact() {
  local hostname="$1" headers status
  headers="$(mktemp)"; temporary_files+=("$headers")
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:80:$public_ipv4" --dump-header "$headers" --output /dev/null \
    --write-out '%{http_code}' "http://$hostname/api/live")" \
    || fail "$hostname HTTP redirect could not be checked"
  [[ "$status" == 308 ]] || fail "$hostname must use the permanent HTTPS redirect"
  header_value_is_exact "$(<"$headers")" location "https://$hostname/api/live" \
    || fail "$hostname redirected to an unexpected location"
}

wait_for_public_liveness() {
  local hostname="$1" headers="$2" body="$3" attempt_limit="$4"
  local attempt status curl_exit
  for (( attempt = 1; attempt <= attempt_limit; attempt++ )); do
    : >"$headers"; : >"$body"
    if status="$(curl --disable --noproxy '*' --silent --show-error \
      --max-time "$public_warmup_request_timeout_seconds" \
      --resolve "$hostname:443:$public_ipv4" --dump-header "$headers" --output "$body" \
      --write-out '%{http_code}' "https://$hostname/api/live")"; then
      case "$status" in 200) return 0 ;; 502|503) ;; *) fail "$hostname liveness returned HTTP $status" ;; esac
    else
      curl_exit=$?
      case "$curl_exit" in 5|6|7|16|18|28|35|52|55|56|92|95) ;; *) fail "$hostname liveness failed with curl status $curl_exit" ;; esac
    fi
    (( attempt < attempt_limit )) || fail "$hostname liveness did not become available"
    sleep "$public_warmup_retry_seconds"
  done
}

verify_public_liveness_contract() {
  local hostname="$1" headers="$2" body="$3" attempt_limit="$4"
  wait_for_public_liveness "$hostname" "$headers" "$body" "$attempt_limit"
  jq -e 'type == "object" and keys == ["status"] and .status == "live"' "$body" >/dev/null \
    || fail "$hostname returned an unexpected liveness response"
  cache_control_is_safe_no_store "$(<"$headers")" \
    || fail "$hostname liveness response is missing no-store"
  verify_security_headers "$hostname" "$headers"
}

public_contract_is_valid() {
  local hostname="$1" warmup="$2" minimal_health="${3:-false}"
  local headers body status request_id metrics_status attempt_limit=1
  headers="$(mktemp)"; body="$(mktemp)"; temporary_files+=("$headers" "$body")
  [[ "$warmup" == true ]] && attempt_limit="$public_warmup_attempts"
  verify_public_liveness_contract "$hostname" "$headers" "$body" "$attempt_limit"
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$public_ipv4" \
    -H 'X-Business-Finlynq-Internal-Health: detailed' \
    -H 'X-Business-Finlynq-Internal-Metrics: detailed' \
    -H 'X-Request-Id: untrusted-public-request-id' \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    "https://$hostname/api/health")" || fail "$hostname readiness route is unavailable"
  [[ "$status" == 200 ]] || fail "$hostname readiness route returned HTTP $status"
  jq -e 'type == "object" and keys == ["status"] and .status == "ready"' "$body" >/dev/null \
    || fail "$hostname exposed a non-minimal public readiness response"
  cache_control_is_safe_no_store "$(<"$headers")" \
    || fail "$hostname readiness response is missing no-store"
  verify_security_headers "$hostname" "$headers"
  request_id="$(awk -F: 'BEGIN { cr = sprintf("%c", 13) }
    tolower($1) == "x-request-id" {
      sub(/^[^:]*:[ \t]*/, "")
      if (substr($0, length($0), 1) == cr) $0 = substr($0, 1, length($0) - 1)
      print
    }' "$headers")"
  [[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
    && "$request_id" != untrusted-public-request-id ]] \
    || fail "$hostname did not replace the untrusted public request ID"
  metrics_status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$public_ipv4" --output /dev/null --write-out '%{http_code}' \
    "https://$hostname/api/metrics")" || fail "$hostname metrics boundary could not be checked"
  [[ "$metrics_status" == 404 ]] || fail "$hostname exposed the internal metrics route"
  http_redirect_is_exact "$hostname"
  tls_is_valid "$hostname"
}

public_maintenance_contract_is_valid() {
  local hostname="$1" warmup="$2" headers body status request_id attempt_limit=1
  headers="$(mktemp)"; body="$(mktemp)"; temporary_files+=("$headers" "$body")
  [[ "$warmup" == true ]] && attempt_limit="$public_warmup_attempts"
  verify_public_liveness_contract "$hostname" "$headers" "$body" "$attempt_limit"
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$hostname:443:$public_ipv4" -H 'X-Request-Id: untrusted-public-request-id' \
    --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    "https://$hostname/api/health")" || fail "$hostname maintenance route is unavailable"
  [[ "$status" == 503 ]] || fail "$hostname maintenance readiness must return HTTP 503"
  jq -e 'type == "object" and keys == ["status"] and .status == "unavailable"' "$body" >/dev/null \
    || fail "$hostname readiness body is not deterministic maintenance"
  header_value_is_exact "$(<"$headers")" retry-after 5 \
    || fail "$hostname maintenance readiness is missing Retry-After"
  header_value_is_exact "$(<"$headers")" content-type 'application/json; charset=utf-8' \
    || fail "$hostname maintenance readiness has an unexpected content type"
  verify_security_headers "$hostname" "$headers"
  request_id="$(awk -F: 'BEGIN { cr = sprintf("%c", 13) }
    tolower($1) == "x-request-id" {
      sub(/^[^:]*:[ \t]*/, "")
      if (substr($0, length($0), 1) == cr) $0 = substr($0, 1, length($0) - 1)
      print
    }' "$headers")"
  [[ "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "$hostname returned an invalid maintenance request ID"
  http_redirect_is_exact "$hostname"
  tls_is_valid "$hostname"
}

while (( $# > 0 )); do
  case "$1" in
    --scope) (( $# >= 2 )) || fail "--scope requires a value"; scope="$2"; shift 2 ;;
    --warmup-host) (( $# >= 2 )) || fail "--warmup-host requires a value"; warmup_host="$2"; shift 2 ;;
    --expected-production-revision) (( $# >= 2 )) || fail "--expected-production-revision requires a SHA"; expected_production_revision="$2"; shift 2 ;;
    --allow-f8485-minimal-production-health) allow_legacy_minimal_production_health="true"; shift ;;
    --allow-pre-router-production) allow_pre_router_production="true"; shift ;;
    --allow-production-router-maintenance) allow_production_router_maintenance="true"; shift ;;
    --allow-development-router-maintenance) allow_development_router_maintenance="true"; shift ;;
    --expect-development-live-uncommitted) expect_development_live_uncommitted="true"; shift ;;
    --allow-first-router-forward-repair)
      (( $# >= 2 )) || fail "--allow-first-router-forward-repair requires a digest"
      allow_first_router_forward_repair="true"; first_router_forward_repair_journal_sha256="$2"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$scope" == preflight || "$scope" == development || "$scope" == production || "$scope" == full ]] \
  || fail "--scope must be preflight, development, production, or full"
[[ "$warmup_host" == none || "$warmup_host" == production || "$warmup_host" == development ]] \
  || fail "--warmup-host must be production or development"
[[ -z "$expected_production_revision" || "$expected_production_revision" =~ ^[a-f0-9]{40}$ ]] \
  || fail "expected production revision must be a full Git SHA"
[[ -z "$first_router_forward_repair_journal_sha256" || "$first_router_forward_repair_journal_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "first-router repair digest must be SHA-256"
[[ -z "$expected_production_revision" || "$scope" == production ]] \
  || fail "an expected production revision is valid only for production scope"
if [[ "$allow_legacy_minimal_production_health" == true ]]; then
  [[ "$scope" == production \
    && "$expected_production_revision" == "$legacy_f8485_revision" \
    && "${ROLLBACK_COMPATIBILITY_ACK:-}" == f8485-one-release-only ]] \
    || fail "minimal production health is restricted to the acknowledged exact f8485 rollback"
fi
if [[ "$allow_pre_router_production" == true ]]; then
  [[ "$scope" == production && -n "$expected_production_revision" ]] \
    || fail "pre-router production verification requires an exact production revision"
fi
if [[ "$expect_development_live_uncommitted" == true ]]; then
  [[ "$scope" == development && "$warmup_host" == development \
    && "$allow_development_router_maintenance" == false ]] \
    || fail "live-uncommitted verification is restricted to the development deployment boundary"
fi
[[ "$(id -u)" == 0 ]] || fail "run this command as root"
for command_name in awk curl docker env grep jq mktemp openssl rm sleep sort timeout; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

required_networks=()
[[ "$scope" == preflight || "$scope" == production || "$scope" == full ]] \
  && required_networks+=("$production_network")
[[ "$scope" == development || "$scope" == full ]] && required_networks+=("$development_network")
edge_container="$(verify_central_edge "${required_networks[@]}")"

production_mode=""
development_mode=""
production_revision=""
development_revision=""
if [[ "$scope" == preflight ]]; then
  project_query="$(docker ps --all --filter "label=com.docker.compose.project=$production_project" --format '{{.ID}}')"
  [[ -z "$project_query" ]] || fail "production preflight requires an empty Business Compose project"
elif [[ "$scope" == production || "$scope" == full ]]; then
  [[ -f "$production_environment" && ! -L "$production_environment" ]] \
    || fail "the production Compose environment is unavailable"
  [[ "$(read_environment_value "$production_environment" BUSINESS_FINLYNQ_EDGE_MODE)" == external ]] \
    || fail "production must use the central shared edge"
  [[ "$(read_environment_value "$production_environment" BUSINESS_FINLYNQ_EDGE_NETWORK)" \
    == "$production_network" \
    && "$(read_environment_value "$production_environment" BUSINESS_FINLYNQ_APP_NETWORK_ALIAS)" \
      == "$production_alias" \
    && "$(read_environment_value "$production_environment" BUSINESS_FINLYNQ_APP_PORT)" \
      == "$production_loopback_port" ]] \
    || fail "production network alias or loopback port differs from its contract"
  production_revision="${expected_production_revision:-$(read_environment_value \
    "$production_environment" BUSINESS_FINLYNQ_IMAGE_REVISION)}"
  [[ "$production_revision" =~ ^[a-f0-9]{40}$ && ! "$production_revision" =~ ^0+$ ]] \
    || fail "production revision metadata is invalid"
  production_mode="$(verify_business_runtime "$production_project" "$production_network" \
    "$production_alias" "$production_loopback_port" "$production_revision" \
    "$allow_pre_router_production" "$allow_legacy_minimal_production_health" false)"
fi
if [[ "$scope" == development || "$scope" == full ]]; then
  [[ -f "$development_environment" && ! -L "$development_environment" ]] \
    || fail "the development Compose environment is unavailable"
  [[ "$(read_environment_value "$development_environment" BUSINESS_FINLYNQ_EDGE_MODE)" == external ]] \
    || fail "development must use the central shared edge"
  [[ "$(read_environment_value "$development_environment" BUSINESS_FINLYNQ_EDGE_NETWORK)" \
    == "$development_network" \
    && "$(read_environment_value "$development_environment" BUSINESS_FINLYNQ_APP_NETWORK_ALIAS)" \
      == "$development_alias" \
    && "$(read_environment_value "$development_environment" BUSINESS_FINLYNQ_APP_PORT)" \
      == "$development_loopback_port" ]] \
    || fail "development network alias or loopback port differs from its contract"
  development_revision="$(read_environment_value \
    "$development_environment" BUSINESS_FINLYNQ_IMAGE_REVISION)"
  [[ "$development_revision" =~ ^[a-f0-9]{40}$ && ! "$development_revision" =~ ^0+$ ]] \
    || fail "development revision metadata is invalid"
  development_mode="$(verify_business_runtime "$development_project" "$development_network" \
    "$development_alias" "$development_loopback_port" "$development_revision" false false \
    "$expect_development_live_uncommitted")"
fi

if [[ "$scope" == preflight ]]; then
  headers="$(mktemp)"; temporary_files+=("$headers")
  status="$(curl --disable --noproxy '*' --silent --show-error --max-time 20 \
    --resolve "$production_hostname:443:$public_ipv4" --dump-header "$headers" \
    --output /dev/null --write-out '%{http_code}' "https://$production_hostname/api/live")" \
    || fail "production preflight route could not be checked"
  [[ "$status" == 502 || "$status" == 503 ]] \
    || fail "production preflight must expose an unavailable backend"
  verify_security_headers "$production_hostname" "$headers"
  http_redirect_is_exact "$production_hostname"
  tls_is_valid "$production_hostname"
fi
if [[ "$scope" == production || "$scope" == full ]]; then
  production_warmup=false; [[ "$warmup_host" == production ]] && production_warmup=true
  if [[ "$production_mode" == maintenance ]]; then
    [[ "$allow_production_router_maintenance" == true || "$allow_first_router_forward_repair" == true ]] \
      || fail "production maintenance was not explicitly allowed"
    public_maintenance_contract_is_valid "$production_hostname" "$production_warmup"
  else
    public_contract_is_valid "$production_hostname" "$production_warmup" \
      "$allow_legacy_minimal_production_health"
  fi
fi
if [[ "$scope" == development || "$scope" == full ]]; then
  development_warmup=false; [[ "$warmup_host" == development ]] && development_warmup=true
  development_public_contract="$(resolve_development_public_contract "$development_mode")"
  case "$development_public_contract" in
    active) public_contract_is_valid "$development_hostname" "$development_warmup" ;;
    maintenance) public_maintenance_contract_is_valid "$development_hostname" "$development_warmup" ;;
    *) fail "development public contract resolution is invalid" ;;
  esac
fi

printf 'Shared-edge contract v1 accepted: container=%s networks=%s\n' \
  "$edge_container" "${required_networks[*]}"
