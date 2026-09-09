#!/usr/bin/env bash
set -Eeuo pipefail
set +x

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
readonly protected_external_edge_verifier="/usr/local/libexec/business-finlynq/deploy/edge/verify-external-edge.sh"
readonly production_install_state="/etc/business-finlynq/initial-install-state.json"
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
for command_name in awk bash chmod chown curl date docker env flock git grep id install jq sha256sum \
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
  local edge_mode edge_mode_count
  local -a compose_files=(-f "$repository/docker-compose.yml")
  edge_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE could not be read"
  edge_mode_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE definitions could not be counted"
  [[ "$edge_mode_count" == 0 || "$edge_mode_count" == 1 ]] \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE must be defined at most once"
  edge_mode="${edge_mode:-compose}"
  case "$edge_mode" in
    compose) ;;
    external) compose_files+=(-f "$repository/deploy/edge/docker-compose.external.yml") ;;
    *) fail "BUSINESS_FINLYNQ_EDGE_MODE must be compose or external" ;;
  esac
  env -i PATH="$clean_path" docker compose \
    --project-name "$project" \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    "${compose_files[@]}" "$@"
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

verify_external_edge_if_selected() {
  local selected_mode selected_count verifier_record expected_sha observed_output observed_sha
  local observed_remainder expected_bytes observed_bytes
  selected_count="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { count++ } END { print count + 0 }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE definitions could not be counted"
  [[ "$selected_count" == 0 || "$selected_count" == 1 ]] \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE must be defined at most once"
  selected_mode="$(awk -F= '$1 == "BUSINESS_FINLYNQ_EDGE_MODE" { sub(/^[^=]*=/, ""); print }' \
    "$compose_environment")" \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE could not be read"
  selected_mode="${selected_mode:-compose}"
  [[ "$selected_mode" == compose || "$selected_mode" == external ]] \
    || fail "BUSINESS_FINLYNQ_EDGE_MODE must be compose or external"
  [[ "$selected_mode" == external ]] || return 0
  [[ -f "$production_install_state" && ! -L "$production_install_state" \
    && "$(readlink -f -- "$production_install_state")" == "$production_install_state" \
    && "$(stat -c '%u:%g:%a:%h' -- "$production_install_state")" == 0:0:600:1 ]] \
    || fail "the protected production install state is unavailable"
  verifier_record="$(jq -ce --arg path "$protected_external_edge_verifier" '
    if type == "object" and .schemaVersion == 1 and
      .product == "business-finlynq" and .phase == "configured" and
      (.revision | type == "string" and test("^[a-f0-9]{40}$")) and
      (.revision | test("^0+$") | not) and
      (.configurationFiles | type == "array")
    then . else error("invalid install state") end |
    [.configurationFiles[] | select(.path == $path)] |
    if length == 1 then .[0] else error("missing protected verifier") end
  ' "$production_install_state")" \
    || fail "the protected production install state does not bind exactly one edge verifier"
  jq -e '
    type == "object" and keys == ["bytes", "metadata", "path", "sha256"] and
    .metadata == "0:0:550" and (.sha256 | test("^[a-f0-9]{64}$")) and
    (.bytes | type == "number" and . == floor and . > 0)
  ' <<<"$verifier_record" >/dev/null \
    || fail "the protected external-edge verifier inventory record is invalid"
  [[ -f "$protected_external_edge_verifier" && ! -L "$protected_external_edge_verifier" \
    && "$(readlink -f -- "$protected_external_edge_verifier")" \
      == "$protected_external_edge_verifier" \
    && "$(stat -c '%u:%g:%a:%h' -- "$protected_external_edge_verifier")" \
      == 0:0:550:1 ]] \
    || fail "the protected external-edge verifier is unavailable or unsafe"
  expected_sha="$(jq -er '.sha256' <<<"$verifier_record")" \
    || fail "the protected external-edge verifier checksum could not be read"
  expected_bytes="$(jq -er '.bytes' <<<"$verifier_record")" \
    || fail "the protected external-edge verifier size could not be read"
  observed_output="$(sha256sum -- "$protected_external_edge_verifier")" \
    || fail "the protected external-edge verifier could not be hashed"
  read -r observed_sha observed_remainder <<<"$observed_output" \
    || fail "the protected external-edge verifier digest could not be parsed"
  observed_bytes="$(stat -c '%s' -- "$protected_external_edge_verifier")" \
    || fail "the protected external-edge verifier size could not be inspected"
  [[ "$observed_sha" =~ ^[a-f0-9]{64}$ && -n "$observed_remainder" \
    && "$observed_sha" == "$expected_sha" && "$observed_bytes" == "$expected_bytes" ]] \
    || fail "the protected external-edge verifier differs from the install-state inventory"
  "$protected_external_edge_verifier" --scope development --warmup-host development
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
  hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" \
    || fail "BUSINESS_FINLYNQ_HOSTNAME could not be read"
  [[ "$hostname" == dev.business.finlynq.com ]] \
    || fail "public acceptance requires the exact development hostname"
  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if public_health="$(curl --disable --noproxy '*' --connect-timeout 2 --max-time 5 --fail --silent \
      "https://$hostname/api/health" 2>/dev/null)" \
      && jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
        <<<"$public_health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  fail "public development route did not become ready before browser acceptance"
}

repository_root="$(git_as_deploy rev-parse --show-toplevel)" \
  || fail "the canonical development repository root could not be read"
[[ "$repository_root" == "$repository" ]] \
  || fail "the canonical development repository root changed"
repository_branch="$(git_as_deploy symbolic-ref --short HEAD)" \
  || fail "the development checkout branch could not be read"
[[ "$repository_branch" == dev ]] \
  || fail "the development checkout is not on dev"
repository_origin="$(git_as_deploy remote get-url origin)" \
  || fail "the development origin could not be read"
[[ "$repository_origin" == "$expected_origin" ]] \
  || fail "the development origin is not the reviewed repository"
repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" \
  || fail "the development checkout status could not be read"
[[ -z "$repository_status" ]] \
  || fail "the development checkout is not clean"

git_as_deploy fetch --prune --force --no-tags origin \
  '+refs/heads/dev:refs/remotes/origin/dev' \
  '+refs/tags/deploy-development-*:refs/tags/deploy-development-*'

source_revision="$(git_as_deploy rev-parse HEAD)" \
  || fail "the deployed development revision could not be read"
candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/dev)" \
  || fail "the fetched development revision could not be read"
validate_revision "$source_revision"
validate_revision "$candidate_revision"
git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision" \
  || fail "origin/dev is not a fast-forward descendant of the deployed revision"

signal_tag="deploy-development-$candidate_revision"
signal_revision="$(git_as_deploy rev-parse "refs/tags/$signal_tag^{commit}" 2>/dev/null)" \
  || fail "the immutable development deployment signal is unavailable"
[[ "$signal_revision" == "$candidate_revision" ]] \
  || fail "the successful quality gate has not published the immutable development deployment signal"

expected_resources=(
  "business_finlynq_development_pgdata"
  "business_finlynq_development_private"
  "business_finlynq_development_egress"
  "business_finlynq_development_edge"
)

verify_compose_boundary() {
  local rendered resource expected app_port app_origin app_alias found_resource_output
  local -a found_resources
  rendered="$(compose config --format json)" \
    || fail "development Compose configuration could not be rendered"
  app_port="$(jq -er '.services.app.ports[0].published' <<<"$rendered")" \
    || fail "development app port could not be read from Compose"
  app_origin="$(jq -er '.services.app.environment.APP_ORIGIN' <<<"$rendered")" \
    || fail "development APP_ORIGIN could not be read from Compose"
  app_alias="$(jq -er '.services.app.networks.business_finlynq_edge.aliases[0]' <<<"$rendered")" \
    || fail "development edge alias could not be read from Compose"
  [[ "$app_port" == 3200 ]] || fail "development app must bind loopback port 3200"
  [[ "$app_origin" == https://dev.business.finlynq.com ]] \
    || fail "development APP_ORIGIN must use the exact HTTPS development hostname"
  [[ "$app_alias" == development-app ]] \
    || fail "development app must expose only its dedicated edge alias"
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
    mounts expected_digest actual_digest provider_record
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
}

release_is_accepted() {
  local expected_revision="$1" app_container app_environment actual expected detailed_health \
    public_health rendered hostname require_public setting app_container_output app_revision
  local -a app_containers
  validate_revision "$expected_revision"
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
  rendered="$(compose config --format json)" || return 1
  document_provider_configuration_matches "$app_container" "$rendered" || return 1
  app_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$app_container")" || return 1
  for setting in DEMO_LOGIN_ENABLED DEMO_WRITES_ENABLED ACCOUNT_LOGIN_ENABLED \
    ACCOUNT_SIGNUP_ENABLED AUTH_EMAIL_DELIVERY_ENABLED AUTH_EMAIL_PROVIDER AUTH_EMAIL_FROM \
    AUTH_EMAIL_REPLY_TO SIGNUP_TURNSTILE_ENABLED SIGNUP_TURNSTILE_SITE_KEY \
    BUSINESS_WRITES_ENABLED BANK_FEEDS_ENABLED YAHOO_FX_ENABLED DOCUMENT_INBOX_MAX_DEPTH \
    DOCUMENT_INBOX_MAX_PROVIDER_CALLS; do
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
  if [[ "$require_public" == true ]]; then
    hostname="$(read_environment_value BUSINESS_FINLYNQ_HOSTNAME)" || return 1
    [[ "$hostname" == dev.business.finlynq.com ]] || return 1
    public_health="$(curl --disable --noproxy '*' --fail --silent --show-error --max-time 30 \
      "https://$hostname/api/health")" || return 1
    jq -e '.status == "ready" and (has("checks") | not) and (has("revision") | not)' \
      <<<"$public_health" >/dev/null || return 1
  fi
}

ensure_revision_runtime_images() {
  local revision="$1" reference image_revision needs_build=false account_login_enabled
  local -a services references
  validate_revision "$revision"
  services=(database app)
  references=("business-finlynq-database:$revision" "business-finlynq-app:$revision")
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
  local account_login_enabled
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

restore_accepted_revision() {
  local failed_revision="$1" recovery_revision="$2" current_head current_environment_revision \
    repository_status
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
  repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" || return 1
  [[ -z "$repository_status" ]] || return 1

  current_environment_revision="$(read_environment_value BUSINESS_FINLYNQ_IMAGE_REVISION)" \
    || return 1
  if [[ "$current_environment_revision" == "$failed_revision" ]]; then
    replace_environment_revision "$failed_revision" "$recovery_revision" || return 1
  elif [[ "$current_environment_revision" != "$recovery_revision" ]]; then
    return 1
  fi

  ( verify_compose_boundary ) || return 1
  ensure_revision_runtime_images "$recovery_revision" || return 1
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
    existing_app_container_output="$(docker ps --all --no-trunc --quiet \
      --filter label=com.docker.compose.project="$project" \
      --filter label=com.docker.compose.service=app)" \
      || fail "the existing development app container inventory could not be read"
    existing_app_containers=()
    if [[ -n "$existing_app_container_output" ]]; then
      mapfile -t existing_app_containers <<<"$existing_app_container_output" \
        || fail "the existing development app container inventory could not be parsed"
    fi
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

# Recovery must establish a healthy accepted source first. Once it has, verify
# strict external-edge prerequisites before processing the current quarantine
# or mutating a newer candidate.
if [[ "$source_revision" != "$candidate_revision" ]]; then
  require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
    || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
  [[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]] \
    || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
  if [[ "$require_public_acceptance" == true ]]; then
    verify_external_edge_if_selected
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
  if release_is_accepted "$candidate_revision"; then
    require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE could not be read"
    [[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]] \
      || fail "DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE must be true or false"
    if [[ "$require_public_acceptance" == true ]]; then
      run_public_acceptance || fail "same-revision development public acceptance failed twice"
      verify_external_edge_if_selected
    fi
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
checked_out_revision="$(git_as_deploy rev-parse HEAD)" \
  || fail "the post-merge development revision could not be read"
repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)" \
  || fail "the post-merge development checkout status could not be read"
[[ "$checked_out_revision" == "$candidate_revision" && -z "$repository_status" ]] \
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

# Compose detects client-ID and mount-path changes. A secret replaced at the
# same path can retain the old bind mount, so recreate only the app if needed.
document_app_container="$(compose ps --quiet app)" \
  || fail "the development app container could not be identified"
document_rendered="$(compose config --format json)" \
  || fail "the development Compose configuration could not be rendered after apply"
if ! document_provider_configuration_matches "$document_app_container" "$document_rendered"; then
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
  verify_external_edge_if_selected
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
