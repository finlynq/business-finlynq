#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly repository="/home/deploy/business-finlynq"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly compose_environment="/etc/business-finlynq/compose.env"
readonly operations_environment="/etc/business-finlynq/operations.env"
readonly repository_environment="$repository/.env"
readonly evidence_root="/var/lib/business-finlynq/release-evidence"
readonly boundary_file="/home/deploy/.local/state/business-finlynq/release-locks/scheduler-boundary.json"
readonly automation_lock="/var/lib/business-finlynq/continuous-deployment.lock"
readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly failure_latch="/var/lib/business-finlynq/continuous-deployment-failed"
readonly release_router_reference="business-finlynq-release-router:v1"
readonly release_router_revision="release-router-v1"
readonly release_router_contract="v1"
readonly legacy_f8485_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
readonly release_recovery_state_directory="/var/lib/business-finlynq/release-recovery"
readonly first_router_recovery_journal="$release_recovery_state_directory/first-router-pre-cutover.json"
readonly active_finalization_marker="$release_recovery_state_directory/active-finalization.json"
readonly active_finalization_max_authorization_age_seconds="3600"
readonly production_signal_repository="finlynq/business-finlynq"
readonly production_signal_certificate_identity="https://github.com/finlynq/business-finlynq/.github/workflows/signal-production-deployment.yml@refs/heads/main"
readonly production_signal_cache_directory="/var/cache/business-finlynq/github-attestations"
readonly production_signal_workflow_path=".github/workflows/signal-production-deployment.yml"
readonly production_signal_workflow_sha256="36326ed7f59c4aab5310d4ca58dd86ef0539d653bbf3723a74f53e83fa7df071"
readonly quality_gate_workflow_path=".github/workflows/ci.yml"
readonly quality_gate_workflow_sha256="2a61d709888f590a6ac5cf22612224cd31fe4236b7aa3aaeb1f8d9cbb0e2228f"
readonly github_cli="/usr/bin/gh"
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'Business Finlynq continuous deployment refused: %s\n' "$*" >&2
  exit 1
}

command -v id >/dev/null 2>&1 || fail "required command is unavailable: id"
[[ "$(id -u)" == 0 ]] || fail "run this command as root"

validate_revision() {
  [[ "$1" =~ ^[a-f0-9]{40}$ && ! "$1" =~ ^0+$ ]] \
    || fail "revision must be a non-zero full 40-character Git SHA"
}

if [[ "${1:-}" == "--clear-failure" ]]; then
  for command_name in grep rm sync; do
    command -v "$command_name" >/dev/null 2>&1 \
      || fail "required latch-clear command is unavailable: $command_name"
  done
  [[ "$#" == 2 ]] || fail "--clear-failure requires the failed candidate revision"
  validate_revision "$2"
  [[ "${CONTINUOUS_DEPLOYMENT_FAILURE_ACK:-}" == "clear:$2" ]] \
    || fail "CONTINUOUS_DEPLOYMENT_FAILURE_ACK must acknowledge the exact failed revision"
  [[ -f "$failure_latch" && ! -L "$failure_latch" ]] \
    || fail "the protected failure latch is unavailable"
  grep -Fxq "candidateRevision=$2" "$failure_latch" \
    || fail "the failure latch does not identify the acknowledged revision"
  rm -- "$failure_latch"
  sync -f -- "${failure_latch%/*}"
  printf 'Continuous-deployment failure latch cleared for %s.\n' "$2"
  exit 0
fi
[[ "$#" == 0 ]] || fail "this command accepts no deployment arguments"

for command_name in awk bash chmod chown cmp curl date docker env find flock git grep install \
  jq mkdir mktemp mv openssl readlink rm runuser sed sha256sum sort ssh stat sync systemctl \
  timeout uniq wc; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
[[ -f "$github_cli" && ! -L "$github_cli" \
  && "$(stat -c '%u:%g:%a' -- "$github_cli")" == 0:0:755 ]] \
  || fail "GitHub CLI must be the root-owned executable /usr/bin/gh"

require_secure_github_cli() {
  local attestation_flag gh_version gh_help gh_major gh_minor gh_patch
  gh_version="$("$github_cli" --version | awk 'NR == 1 { print $3 }')" || return 1
  [[ "$gh_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || return 1
  IFS=. read -r gh_major gh_minor gh_patch <<<"$gh_version" || return 1
  [[ "$gh_major" =~ ^[0-9]+$ && "$gh_minor" =~ ^[0-9]+$ \
    && "$gh_patch" =~ ^[0-9]+$ ]] || return 1
  (( gh_major > 2 || (gh_major == 2 && gh_minor >= 100) )) || return 1
  gh_help="$("$github_cli" attestation verify --help)" || return 1
  for attestation_flag in --cert-identity --cert-oidc-issuer \
    --deny-self-hosted-runners --predicate-type --signer-digest --source-digest \
    --source-ref --bundle; do
    grep -F -- "$attestation_flag" <<<"$gh_help" >/dev/null || return 1
  done
}
require_secure_github_cli \
  || fail "GitHub CLI 2.100.0 or newer with complete attestation policy support is required"
[[ -d "$production_signal_cache_directory" \
  && ! -L "/var/cache/business-finlynq" \
  && ! -L "$production_signal_cache_directory" \
  && "$(readlink -f -- "$production_signal_cache_directory")" \
    == "$production_signal_cache_directory" \
  && "$(stat -c '%u:%g:%a' -- "/var/cache/business-finlynq")" == 0:0:700 \
  && "$(stat -c '%u:%g:%a' -- "$production_signal_cache_directory")" == 0:0:700 ]] \
  || fail "the protected GitHub attestation cache is unavailable or unsafe"

[[ -d "$repository/.git" && ! -L "$repository" ]] \
  || fail "the canonical production checkout is unavailable"
[[ -d "${automation_lock%/*}" && ! -L "${automation_lock%/*}" ]] \
  || fail "the application state directory is unavailable"
[[ ! -L "$automation_lock" ]] || fail "the automation lock is symbolic"
exec 9>"$automation_lock"
chmod 0600 "$automation_lock"
flock --exclusive --nonblock 9 || fail "another continuous-deployment check is active"
deploy_gid="$(id -g deploy 2>/dev/null)" \
  || fail "host deployment coordination requires the deploy account"
[[ "$(stat -c '%u:%g:%a' -- "${host_deployment_lock%/*}")" == "0:$deploy_gid:775" ]] \
  || fail "shared deployment state directory must be root:deploy mode 0775"
[[ ! -L "$host_deployment_lock" ]] || fail "the host deployment lock is symbolic"
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

[[ ! -e "$failure_latch" && ! -L "$failure_latch" ]] \
  || fail "a previous automatic release failed; inspect its evidence and clear the protected latch explicitly"

git_as_deploy() {
  runuser -u deploy -- /usr/bin/env -i \
    HOME=/home/deploy USER=deploy LOGNAME=deploy SHELL=/bin/bash \
    PATH="$clean_path" LC_ALL=C LANG=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git --no-optional-locks -c safe.directory="$repository" -c core.hooksPath=/dev/null \
      -C "$repository" "$@"
}

[[ "$(git_as_deploy rev-parse --show-toplevel)" == "$repository" ]] \
  || fail "the canonical repository root changed"
[[ "$(git_as_deploy symbolic-ref --short HEAD)" == main ]] \
  || fail "the production checkout is not on main"
[[ "$(git_as_deploy remote get-url origin)" == "$expected_origin" ]] \
  || fail "the production origin is not the reviewed repository"
[[ -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the production checkout is not clean"

source_revision="$(git_as_deploy rev-parse HEAD)"
validate_revision "$source_revision"

evidence_inventory_is_valid() {
  local directory="$1" inventory="$1/SHA256SUMS" line digest relative extra target
  local listed_count=0 actual_count symlink_query
  [[ -d "$directory" && ! -L "$directory" \
    && "$(stat -c '%u:%a' -- "$directory")" == 0:700 \
    && -f "$inventory" && ! -L "$inventory" \
    && "$(stat -c '%u:%a:%h' -- "$inventory")" == 0:600:1 ]] || return 1
  symlink_query="$(find "$directory" -mindepth 1 -maxdepth 1 -type l -print -quit)" \
    || return 1
  [[ -z "$symlink_query" ]] || return 1
  while IFS= read -r line; do
    read -r digest relative extra <<<"$line"
    [[ -z "$extra" && "$digest" =~ ^[a-f0-9]{64}$ \
      && "$relative" =~ ^[.]/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
    target="$directory/${relative#./}"
    [[ -f "$target" && ! -L "$target" \
      && "$(stat -c '%u:%a:%h' -- "$target")" == 0:600:1 ]] || return 1
    (( listed_count += 1 ))
  done <"$inventory"
  (( listed_count > 0 )) || return 1
  actual_count="$(find "$directory" -mindepth 1 -maxdepth 1 -type f \
    ! -name SHA256SUMS | wc -l)" || return 1
  [[ "$actual_count" =~ ^[0-9]+$ && "$actual_count" == "$listed_count" ]] || return 1
  ( cd -- "$directory" && sha256sum --check --strict --quiet SHA256SUMS ) || return 1
}

accepted_terminal_evidence_exists() {
  local expected_app_image="$1" expected_router_image="$2"
  local expected_revision="${3:-$candidate_revision}"
  local expected_run_id="${4:-}"
  local revision_directory="$evidence_root/$expected_revision" query terminal directory run_id
  local browser_log browser_log_inventory_count browser_log_inventory_sha256
  local browser_log_actual_output browser_log_actual_sha256
  [[ "$expected_app_image" =~ ^sha256:[a-f0-9]{64}$ \
    && "$expected_router_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ -d "$revision_directory" && ! -L "$revision_directory" \
    && "$(stat -c '%u:%a' -- "$revision_directory")" == 0:700 ]] || return 1
  query="$(find "$revision_directory" -mindepth 2 -maxdepth 2 -type f \
    -name 90-release-complete.json -print)" || return 1
  [[ -n "$query" ]] || return 1
  while IFS= read -r terminal; do
    [[ -n "$terminal" && -f "$terminal" && ! -L "$terminal" ]] || continue
    directory="${terminal%/*}"
    run_id="${directory##*/}"
    [[ "$run_id" =~ ^[a-z0-9][a-z0-9._-]{2,30}$ ]] || continue
    [[ -z "$expected_run_id" || "$run_id" == "$expected_run_id" ]] || continue
    evidence_inventory_is_valid "$directory" || continue
    browser_log="$directory/70-browser-acceptance.log"
    [[ -f "$browser_log" && ! -L "$browser_log" \
      && "$(stat -c '%u:%a:%h' -- "$browser_log")" == 0:600:1 ]] || continue
    browser_log_inventory_count="$(grep -Ec \
      '^[a-f0-9]{64}[[:space:]]+[.]/70-browser-acceptance[.]log$' \
      "$directory/SHA256SUMS")" || continue
    [[ "$browser_log_inventory_count" == 1 ]] || continue
    browser_log_inventory_sha256="$(awk \
      '$2 == "./70-browser-acceptance.log" { print $1 }' \
      "$directory/SHA256SUMS")" || continue
    browser_log_actual_output="$(sha256sum -- "$browser_log")" || continue
    browser_log_actual_sha256="${browser_log_actual_output%% *}"
    [[ "$browser_log_inventory_sha256" =~ ^[a-f0-9]{64}$ \
      && "$browser_log_actual_sha256" == "$browser_log_inventory_sha256" ]] || continue
    if jq -e --arg revision "$expected_revision" --arg runId "$run_id" \
      --arg appImage "$expected_app_image" --arg routerImage "$expected_router_image" \
      --arg browserLogSha256 "$browser_log_inventory_sha256" '
        type == "object" and
        keys == ([
          "browserAcceptancePassed", "browserLogSha256", "candidateAppImageId",
          "completedAt", "containedInitial", "databaseRollback",
          "localEncryptedBackupVerified", "maintenanceConfirmedBeforeSchemaMigration",
          "mode", "offsiteBackupDeferred", "postBootstrapAccountingEvidenceVerified",
          "preTrafficDatabaseContractVerified", "previousAppImageId", "product",
          "releaseRouterConfigSha256", "releaseRouterImageId", "revision", "runId",
          "schedulerActivationDeferred", "schemaVersion", "status"
        ] | sort) and
        .schemaVersion == 1 and
        .product == "business-finlynq" and .status == "accepted" and
        .mode == "release" and .revision == $revision and .runId == $runId and
        .candidateAppImageId == $appImage and .releaseRouterImageId == $routerImage and
        (.completedAt | type == "string" and
          test("^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$")) and
        (.releaseRouterConfigSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.previousAppImageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
        .maintenanceConfirmedBeforeSchemaMigration == true and
        .preTrafficDatabaseContractVerified == true and
        .postBootstrapAccountingEvidenceVerified == true and
        .browserAcceptancePassed == true and
        .browserLogSha256 == $browserLogSha256 and
        .databaseRollback == "forward-repair-only" and
        .containedInitial == false and .localEncryptedBackupVerified == false and
        .offsiteBackupDeferred == false and .schedulerActivationDeferred == false
      ' "$terminal" >/dev/null; then
      return 0
    fi
  done <<<"$query"
  return 1
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

release_runtime_matches_accepted_evidence() {
  local expected_router_mode="$1"
  local expected_revision="${2:-$candidate_revision}"
  local expected_run_id="${3:-}"
  local expected_app_image="${4:-}"
  local expected_router_image="${5:-}"
  local app_container router_container detailed_health router_mode app_image router_image
  local tagged_router_image
  local -a app_containers router_containers
  [[ "$expected_router_mode" == active || "$expected_router_mode" == maintenance ]] \
    || return 1
  [[ -f "$boundary_file" && ! -L "$boundary_file" ]] || return 1
  jq -e --arg revision "$expected_revision" '
    .schemaVersion == 1 and .product == "business-finlynq" and
    .boundaryVersion == 1 and .installedRevision == $revision and
    .scheduler == "systemd"
  ' "$boundary_file" >/dev/null || return 1
  mapfile -t app_containers < <(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=app)
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  [[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$app_container")" == "$expected_revision" ]] || return 1
  app_image="$(docker inspect --format '{{.Image}}' "$app_container")" || return 1
  [[ "$app_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ -z "$expected_app_image" || "$app_image" == "$expected_app_image" ]] || return 1
  mapfile -t router_containers < <(docker ps --all --no-trunc --quiet \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)
  [[ "${#router_containers[@]}" == 1 ]] || return 1
  router_container="${router_containers[0]}"
  tagged_router_image="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" || return 1
  [[ "$tagged_router_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  docker inspect "$router_container" | jq -e \
    --arg reference "$release_router_reference" \
    --arg imageId "$tagged_router_image" \
    --arg revision "$release_router_revision" --arg contract "$release_router_contract" '
      length == 1 and .[0].Image == $imageId and
      (.[0].Config.Image == $reference or .[0].Config.Image == $imageId) and
      .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
      .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
      .[0].State.Running == true and .[0].State.Health.Status == "healthy"
    ' >/dev/null || return 1
  router_image="$(docker inspect --format '{{.Image}}' "$router_container")" || return 1
  [[ "$router_image" =~ ^sha256:[a-f0-9]{64}$ \
    && "$router_image" == "$tagged_router_image" ]] \
    || return 1
  [[ -z "$expected_router_image" || "$router_image" == "$expected_router_image" ]] \
    || return 1
  router_mode="$(docker exec "$router_container" sh -ec '
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
    cat /state/mode
  ')" || return 1
  [[ "$router_mode" == "$expected_router_mode" ]] || return 1
  network_alias_has_exact_owner \
    business_finlynq_edge production-app "$router_container" || return 1
  network_alias_has_exact_owner \
    business_finlynq_private-frontend release-app "$app_container" || return 1
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3100/api/health)" \
    || return 1
  jq -e --arg revision "$expected_revision" \
    '.status == "ready" and .revision == $revision' <<<"$detailed_health" >/dev/null \
    && accepted_terminal_evidence_exists "$app_image" "$router_image" \
      "$expected_revision" "$expected_run_id"
}

live_release_router_is_active() {
  local public_health
  # The maintenance configuration deliberately forwards marked internal health
  # for recovery diagnostics. A request-ID readiness probe is instead forwarded
  # only by the active configuration, so its app-backed response proves that the
  # live process is active without changing or reloading it.
  public_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Request-Id: continuous-deployment-active-finalizer' \
    http://127.0.0.1:3100/api/health)" || return 1
  jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
    <<<"$public_health" >/dev/null
}

active_finalization_marker_loaded="false"
active_finalization_phase=""
active_finalization_authorized_at=""
active_finalization_revision=""
active_finalization_run_id=""
active_finalization_app_container_id=""
active_finalization_app_image_id=""
active_finalization_router_container_id=""
active_finalization_router_image_id=""
active_finalization_terminal_evidence_sha256=""
active_finalization_marker_sha256=""

load_active_finalization_marker() {
  local digest_output expected_revision
  active_finalization_marker_loaded="false"
  expected_revision="$(git_as_deploy rev-parse HEAD)" || return 1
  validate_revision "$expected_revision"
  [[ -d "$release_recovery_state_directory" \
    && ! -L "$release_recovery_state_directory" \
    && "$(readlink -f -- "$release_recovery_state_directory")" \
      == "$release_recovery_state_directory" \
    && "$(stat -c '%u:%g:%a' -- "$release_recovery_state_directory")" == 0:0:700 \
    && -f "$active_finalization_marker" \
    && ! -L "$active_finalization_marker" \
    && "$(readlink -f -- "$active_finalization_marker")" \
      == "$active_finalization_marker" \
    && "$(stat -c '%u:%g:%a:%h' -- "$active_finalization_marker")" \
      == 0:0:600:1 ]] || return 1
  jq -e --arg revision "$expected_revision" '
    type == "object" and
    ((.phase == "terminal-evidence-pending" and
      keys == (["app", "createdAt", "kind", "phase", "product", "revision",
        "router", "runId", "schemaVersion"] | sort)) or
     (.phase == "active-commit-authorized" and
      keys == (["app", "authorizedAt", "createdAt", "kind", "phase", "product",
        "revision", "router", "runId", "schemaVersion",
        "terminalEvidenceSha256"] | sort))) and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .kind == "active-finalization" and
    .revision == $revision and
    (.runId | type == "string" and test("^[a-z0-9][a-z0-9._-]{2,30}$")) and
    (.createdAt | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (if .phase == "active-commit-authorized" then
      (.authorizedAt | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.terminalEvidenceSha256 | type == "string" and test("^[a-f0-9]{64}$"))
    else true end) and
    (.app | type == "object" and keys == ["containerId", "imageId"] and
      (.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
      (.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$"))) and
    (.router | type == "object" and keys == ["containerId", "imageId"] and
      (.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
      (.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")))
  ' "$active_finalization_marker" >/dev/null || return 1
  active_finalization_phase="$(jq -er '.phase' "$active_finalization_marker")" \
    || return 1
  active_finalization_authorized_at="$(jq -r '.authorizedAt // ""' \
    "$active_finalization_marker")" || return 1
  active_finalization_revision="$(jq -er '.revision' "$active_finalization_marker")" \
    || return 1
  active_finalization_run_id="$(jq -er '.runId' "$active_finalization_marker")" \
    || return 1
  active_finalization_app_container_id="$(jq -er '.app.containerId' \
    "$active_finalization_marker")" || return 1
  active_finalization_app_image_id="$(jq -er '.app.imageId' \
    "$active_finalization_marker")" || return 1
  active_finalization_router_container_id="$(jq -er '.router.containerId' \
    "$active_finalization_marker")" || return 1
  active_finalization_router_image_id="$(jq -er '.router.imageId' \
    "$active_finalization_marker")" || return 1
  active_finalization_terminal_evidence_sha256="$(jq -r \
    '.terminalEvidenceSha256 // ""' "$active_finalization_marker")" || return 1
  digest_output="$(sha256sum -- "$active_finalization_marker")" || return 1
  active_finalization_marker_sha256="${digest_output%% *}"
  [[ "$active_finalization_marker_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  active_finalization_marker_loaded="true"
}

active_finalization_authorization_is_current() {
  local authorized_epoch current_epoch terminal_evidence digest_output actual_digest
  [[ "$active_finalization_marker_loaded" == true \
    && "$active_finalization_phase" == "active-commit-authorized" \
    && "$active_finalization_authorized_at" =~ \
      ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ \
    && "$active_finalization_terminal_evidence_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || return 1
  authorized_epoch="$(date -u -d "$active_finalization_authorized_at" +%s)" \
    || return 1
  current_epoch="$(date -u +%s)" || return 1
  [[ "$authorized_epoch" =~ ^[0-9]+$ && "$current_epoch" =~ ^[0-9]+$ ]] \
    || return 1
  (( authorized_epoch <= current_epoch + 300 \
    && current_epoch - authorized_epoch <= active_finalization_max_authorization_age_seconds )) \
    || return 1
  terminal_evidence="$evidence_root/$active_finalization_revision/$active_finalization_run_id/90-release-complete.json"
  [[ -f "$terminal_evidence" && ! -L "$terminal_evidence" \
    && "$(stat -c '%u:%a:%h' -- "$terminal_evidence")" == 0:600:1 ]] \
    || return 1
  digest_output="$(sha256sum -- "$terminal_evidence")" || return 1
  actual_digest="${digest_output%% *}"
  [[ "$actual_digest" == "$active_finalization_terminal_evidence_sha256" ]]
}

clear_loaded_active_finalization_marker() {
  local digest_output current_digest
  [[ "$active_finalization_marker_loaded" == true \
    && -f "$active_finalization_marker" && ! -L "$active_finalization_marker" \
    && "$(stat -c '%u:%g:%a:%h' -- "$active_finalization_marker")" \
      == 0:0:600:1 ]] || return 1
  digest_output="$(sha256sum -- "$active_finalization_marker")" || return 1
  current_digest="${digest_output%% *}"
  [[ "$current_digest" == "$active_finalization_marker_sha256" ]] || return 1
  rm -- "$active_finalization_marker" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  active_finalization_marker_loaded="false"
}

release_is_accepted() {
  local expected_revision="${1:-${candidate_revision:-$source_revision}}"
  release_runtime_matches_accepted_evidence active "$expected_revision" \
    && live_release_router_is_active \
    && production_schedulers_are_active
}

production_schedulers_are_active() {
  local timer enabled_state
  [[ ! -e /home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance \
    && ! -L /home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance ]] \
    || return 1
  for timer in business-finlynq-backup.timer business-finlynq-monitor.timer \
    business-finlynq-accounting-evidence.timer business-finlynq-demo-reconcile.timer; do
    systemctl is-active --quiet "$timer" || return 1
    enabled_state="$(systemctl is-enabled "$timer" 2>/dev/null)" || return 1
    [[ "$enabled_state" == enabled ]] || return 1
  done
}

interrupted_acceptance_is_finalizable() {
  load_active_finalization_marker \
    && active_finalization_authorization_is_current \
    && active_finalization_container_ids_match \
    && release_runtime_matches_accepted_evidence maintenance \
      "$active_finalization_revision" "$active_finalization_run_id" \
      "$active_finalization_app_image_id" "$active_finalization_router_image_id" \
    && production_schedulers_are_active
}

active_finalization_container_ids_match() {
  local app_query router_query
  [[ "$active_finalization_marker_loaded" == true ]] || return 1
  app_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=app)" || return 1
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" || return 1
  [[ "$app_query" == "$active_finalization_app_container_id" \
    && "$router_query" == "$active_finalization_router_container_id" ]]
}

source_release_is_safely_active() {
  release_runtime_matches_accepted_evidence active "$source_revision" \
    && live_release_router_is_active
}

pre_router_runtime_is_safely_active() {
  local expected_revision="$1" expected_container="${2:-}"
  local app_container app_inspection app_image tagged_image detailed_health router_query
  local -a app_containers
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" || return 1
  [[ -z "$router_query" ]] || return 1
  mapfile -t app_containers < <(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=app)
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  [[ -z "$expected_container" || "$app_container" == "$expected_container" ]] || return 1
  app_inspection="$(docker inspect "$app_container")" || return 1
  jq -e --arg revision "$expected_revision" --arg legacyRevision "$legacy_f8485_revision" '
    length == 1 and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "app" and
    (if $revision == $legacyRevision then
       ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
     else
       .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
     end) and
    .[0].HostConfig.ReadonlyRootfs == true and
    (if $revision == $legacyRevision then
       (.[0].HostConfig.Init == false or .[0].HostConfig.Init == null)
     else .[0].HostConfig.Init == true end) and
    .[0].HostConfig.Privileged == false and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    .[0].State.Running == true and .[0].State.Health.Status == "healthy" and
    .[0].HostConfig.PortBindings["3000/tcp"] ==
      [{"HostIp":"127.0.0.1", "HostPort":"3100"}] and
    (if $revision == $legacyRevision then
       ((.[0].NetworkSettings.Networks | keys | sort) ==
         (["business_finlynq_edge", "business_finlynq_egress", "business_finlynq_private"] | sort))
     else
       ((.[0].NetworkSettings.Networks | keys | sort) ==
         (["business_finlynq_edge", "business_finlynq_egress",
           "business_finlynq_evidence", "business_finlynq_private"] | sort))
     end) and
    any(.[0].NetworkSettings.Networks.business_finlynq_edge.Aliases[]?;
      . == "production-app")
  ' <<<"$app_inspection" >/dev/null || return 1
  app_image="$(jq -er '.[0].Image' <<<"$app_inspection")" || return 1
  [[ "$app_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
    [[ "$app_image" == "$legacy_f8485_image_id" ]] || return 1
  else
    tagged_image="$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-app:$expected_revision" 2>/dev/null)" || return 1
    [[ "$app_image" == "$tagged_image" ]] || return 1
  fi
  network_alias_has_exact_owner \
    business_finlynq_edge production-app "$app_container" || return 1
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' \
    http://127.0.0.1:3100/api/health)" || return 1
  if [[ "$expected_revision" == "$legacy_f8485_revision" ]]; then
    jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
      <<<"$detailed_health" >/dev/null
  else
    jq -e --arg revision "$expected_revision" \
      '.status == "ready" and .revision == $revision' <<<"$detailed_health" >/dev/null
  fi
}

source_pre_router_runtime_is_safely_active() {
  pre_router_runtime_is_safely_active "$source_revision"
}

installed_release_is_safely_active() {
  local installed_revision router_query
  [[ -f "$boundary_file" && ! -L "$boundary_file" ]] || return 1
  installed_revision="$(jq -er '
    if type == "object" and .schemaVersion == 1 and
      .product == "business-finlynq" and .boundaryVersion == 1 and
      (.installedRevision | type == "string" and test("^[a-f0-9]{40}$")) and
      .scheduler == "systemd"
    then .installedRevision else error("invalid installed release boundary") end
  ' "$boundary_file")" || return 1
  validate_revision "$installed_revision"
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -n "$router_query" ]]; then
    release_runtime_matches_accepted_evidence active "$installed_revision" \
      && live_release_router_is_active
  else
    pre_router_runtime_is_safely_active "$installed_revision"
  fi
}

atomically_reload_router_active_and_persist() {
  local router_container="$1"
  local token
  [[ "$router_container" =~ ^[a-f0-9]{64}$ ]] || return 1
  token="$(openssl rand -hex 32)" || return 1
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || return 1
  docker exec --env "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$token" \
    "$router_container" sh -ec '
    set -eu
    temporary=""
    armed=true
    fail_closed() {
      recovery="/state/.mode.recovery.$$"
      rm -f -- "$recovery"
      printf "maintenance\n" >"$recovery"
      chmod 0600 "$recovery"
      mv -f "$recovery" /state/mode
      sync /state/mode 2>/dev/null || sync
      sync -f /state 2>/dev/null || sync
      caddy reload --config /etc/caddy/Caddyfile.maintenance \
        --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1
    }
    cleanup() {
      status=$?
      trap - EXIT HUP INT TERM
      if [[ "$armed" == true ]]; then
        fail_closed || status=1
      fi
      [[ -z "$temporary" ]] || rm -f -- "$temporary"
      exit "$status"
    }
    trap cleanup EXIT
    trap '\''exit 129'\'' HUP
    trap '\''exit 130'\'' INT
    trap '\''exit 143'\'' TERM
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    [[ -f /state/mode && ! -L /state/mode \
      && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 \
      && "$(cat /state/mode)" == maintenance ]]
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
      --address unix//tmp/caddy-admin.sock
    temporary="/state/.mode.$$"
    printf "active\n" >"$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" /state/mode
    temporary=""
    sync /state/mode 2>/dev/null || sync
    sync -f /state 2>/dev/null || sync
    armed=false
    trap - EXIT HUP INT TERM
  ' >/dev/null
}

persist_interrupted_acceptance_active() {
  interrupted_acceptance_is_finalizable || return 1
  [[ "$active_finalization_revision" == "$source_revision" ]] || return 1
  atomically_reload_router_active_and_persist \
    "$active_finalization_router_container_id"
}

marked_terminal_acceptance_is_preservable() {
  [[ -e "$active_finalization_marker" || -L "$active_finalization_marker" ]] \
    || return 1
  load_active_finalization_marker \
    && active_finalization_authorization_is_current \
    && active_finalization_container_ids_match \
    && production_schedulers_are_active \
    && {
      release_runtime_matches_accepted_evidence maintenance \
        "$active_finalization_revision" "$active_finalization_run_id" \
        "$active_finalization_app_image_id" "$active_finalization_router_image_id" \
      || {
        release_runtime_matches_accepted_evidence active \
          "$active_finalization_revision" "$active_finalization_run_id" \
          "$active_finalization_app_image_id" "$active_finalization_router_image_id" \
        && live_release_router_is_active
      }
    }
}

release_transition_journal_loaded="false"
release_transition_journal_sha256=""
release_transition_phase=""
release_transition_source_revision=""
release_transition_candidate_revision=""
release_transition_app_container_id=""
release_transition_app_image_id=""
release_transition_worker_was_running="false"
release_transition_worker_container_id=""
release_transition_worker_image_id=""
release_transition_worker_revision=""
release_transition_router_was_preexisting="false"
release_transition_router_container_id=""
release_transition_router_image_id=""
release_forward_repair_pending="false"

load_release_transition_journal() {
  local digest_output expected_candidate_revision
  release_transition_journal_loaded="false"
  expected_candidate_revision="$(git_as_deploy rev-parse HEAD)" || return 1
  validate_revision "$expected_candidate_revision"
  [[ -d "$release_recovery_state_directory" \
    && ! -L "$release_recovery_state_directory" \
    && "$(readlink -f -- "$release_recovery_state_directory")" \
      == "$release_recovery_state_directory" \
    && "$(stat -c '%u:%g:%a' -- "$release_recovery_state_directory")" == 0:0:700 \
    && -f "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" \
    && "$(readlink -f -- "$first_router_recovery_journal")" \
      == "$first_router_recovery_journal" \
    && "$(stat -c '%u:%g:%a:%h' -- "$first_router_recovery_journal")" \
      == 0:0:600:1 ]] || return 1
  jq -e --arg candidateRevision "$expected_candidate_revision" '
    type == "object" and
    (keys == (["app", "authWorker", "candidateRevision", "createdAt",
      "databaseMutationStarted", "kind", "phase", "product", "router",
      "routerWasPreexisting", "runId", "schemaVersion", "sourceRevision"] | sort) or
     keys == (["app", "authWorker", "candidateRevision", "createdAt",
      "databaseMutationStarted", "kind", "mutationArmedAt", "phase", "product",
      "router", "routerWasPreexisting", "runId", "schemaVersion", "sourceRevision"] | sort)) and
    .schemaVersion == 1 and .product == "business-finlynq" and
    .kind == "first-router-pre-cutover" and
    ((.phase == "pre-router-maintenance" and .databaseMutationStarted == false and
      (has("mutationArmedAt") | not)) or
     (.phase == "forward-repair-required" and .databaseMutationStarted == true and
      (.mutationArmedAt | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))) and
    .candidateRevision == $candidateRevision and
    (.sourceRevision | type == "string" and test("^[a-f0-9]{40}$")) and
    (.runId | type == "string" and test("^[a-z0-9][a-z0-9._-]{2,30}$")) and
    (.createdAt | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.app.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
    (.app.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
    (.authWorker.wasRunning | type == "boolean") and
    (if .authWorker.wasRunning then
      (.authWorker.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
      (.authWorker.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$")) and
      .authWorker.revision == .sourceRevision
    else
      .authWorker == {wasRunning: false, containerId: null, imageId: null, revision: null}
    end) and
    (.routerWasPreexisting | type == "boolean") and
    (if .routerWasPreexisting then
      (.router.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
      (.router.imageId | type == "string" and test("^sha256:[a-f0-9]{64}$"))
    else .router == {containerId: null, imageId: null} end)
  ' "$first_router_recovery_journal" >/dev/null || return 1
  release_transition_phase="$(jq -er '.phase' "$first_router_recovery_journal")" \
    || return 1
  release_transition_source_revision="$(jq -er '.sourceRevision' \
    "$first_router_recovery_journal")" || return 1
  release_transition_candidate_revision="$(jq -er '.candidateRevision' \
    "$first_router_recovery_journal")" || return 1
  release_transition_app_container_id="$(jq -er '.app.containerId' \
    "$first_router_recovery_journal")" || return 1
  release_transition_app_image_id="$(jq -er '.app.imageId' \
    "$first_router_recovery_journal")" || return 1
  release_transition_worker_was_running="$(jq -r '.authWorker.wasRunning | tostring' \
    "$first_router_recovery_journal")" || return 1
  release_transition_worker_container_id="$(jq -r '.authWorker.containerId // ""' \
    "$first_router_recovery_journal")" || return 1
  release_transition_worker_image_id="$(jq -r '.authWorker.imageId // ""' \
    "$first_router_recovery_journal")" || return 1
  release_transition_worker_revision="$(jq -r '.authWorker.revision // ""' \
    "$first_router_recovery_journal")" || return 1
  release_transition_router_was_preexisting="$(jq -r '.routerWasPreexisting | tostring' \
    "$first_router_recovery_journal")" || return 1
  release_transition_router_container_id="$(jq -r '.router.containerId // ""' \
    "$first_router_recovery_journal")" || return 1
  release_transition_router_image_id="$(jq -r '.router.imageId // ""' \
    "$first_router_recovery_journal")" || return 1
  digest_output="$(sha256sum -- "$first_router_recovery_journal")" || return 1
  release_transition_journal_sha256="${digest_output%% *}"
  [[ "$release_transition_journal_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  git_as_deploy cat-file -e "$release_transition_source_revision^{commit}" \
    || return 1
  [[ "$(docker image inspect --format '{{.Id}}' \
    "$release_transition_app_image_id" 2>/dev/null)" \
      == "$release_transition_app_image_id" ]] || return 1
  if [[ "$release_transition_source_revision" == "$legacy_f8485_revision" ]]; then
    [[ "$release_transition_app_image_id" == "$legacy_f8485_image_id" ]] || return 1
  else
    [[ "$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-app:$release_transition_source_revision" 2>/dev/null)" \
        == "$release_transition_app_image_id" ]] || return 1
  fi
  release_transition_journal_loaded="true"
}

clear_loaded_release_transition_journal() {
  local digest_output current_digest
  [[ "$release_transition_journal_loaded" == true \
    && -f "$first_router_recovery_journal" \
    && ! -L "$first_router_recovery_journal" \
    && "$(stat -c '%u:%g:%a:%h' -- "$first_router_recovery_journal")" \
      == 0:0:600:1 ]] || return 1
  digest_output="$(sha256sum -- "$first_router_recovery_journal")" || return 1
  current_digest="${digest_output%% *}"
  [[ "$current_digest" == "$release_transition_journal_sha256" ]] || return 1
  rm -- "$first_router_recovery_journal" || return 1
  sync -f -- "$release_recovery_state_directory" || return 1
  release_transition_journal_loaded="false"
}

pause_release_schedulers_before_fetch() {
  [[ -f "$repository/deploy/release/pause-schedulers.sh" \
    && ! -L "$repository/deploy/release/pause-schedulers.sh" ]] || return 1
  if bash "$repository/deploy/release/pause-schedulers.sh" \
    systemd --allow-already-paused >/dev/null 2>&1; then
    return 0
  fi
  # The pause contract deliberately returns failure after stopping a detected
  # orphan so an ordinary operator-driven call cannot silently continue. A
  # durable release-recovery marker authenticates this automated path: prove
  # every known helper quiescent, then repeat the complete pause proof.
  stop_incomplete_release_transients_before_fetch || return 1
  bash "$repository/deploy/release/pause-schedulers.sh" \
    systemd --allow-already-paused >/dev/null 2>&1
}

stop_incomplete_release_write_surfaces_before_fetch() {
  local service query container contract running
  for service in auth_email_worker app; do
    query="$(docker ps --all --quiet --no-trunc \
      --filter label=com.docker.compose.project=business-finlynq \
      --filter "label=com.docker.compose.service=$service")" || return 1
    [[ -z "$query" || ( "$query" =~ ^[a-f0-9]{64}$ && "$query" != *$'\n'* ) ]] \
      || return 1
    [[ -n "$query" ]] || continue
    container="$query"
    contract="$(docker inspect --format \
      '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{.State.Running}}' \
      "$container" 2>/dev/null)" || return 1
    [[ "$contract" == "business-finlynq|$service|true" \
      || "$contract" == "business-finlynq|$service|false" ]] || return 1
    running="${contract##*|}"
    if [[ "$running" == true ]]; then
      docker stop --time 30 "$container" >/dev/null 2>&1 || return 1
    fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
      == false ]] || return 1
  done
}

stop_incomplete_release_transients_before_fetch() {
  local service query container contract running result=0
  local -a transient_services=(
    provision_auth_worker_role migrate reconcile_runtime_grants
    reconcile_auth_worker_grants reconcile_backup_grants verify_database_contract
    bootstrap_demo verify_accounting_evidence reconcile_demo_sandboxes
    provision_backup backup verify_latest_backup release_acceptance
  )
  for service in "${transient_services[@]}"; do
    query="$(docker ps --all --quiet --no-trunc \
      --filter label=com.docker.compose.project=business-finlynq \
      --filter "label=com.docker.compose.service=$service")" || return 1
    while IFS= read -r container; do
      [[ -n "$container" ]] || continue
      [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
      contract="$(docker inspect --format \
        '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{.State.Running}}' \
        "$container" 2>/dev/null)" || return 1
      [[ "$contract" == "business-finlynq|$service|true" \
        || "$contract" == "business-finlynq|$service|false" ]] || return 1
      running="${contract##*|}"
      if [[ "$running" == true ]]; then
        docker stop --time 30 "$container" >/dev/null 2>&1 || result=1
      fi
      [[ "$(docker inspect --format '{{.State.Running}}' \
        "$container" 2>/dev/null)" == false ]] || result=1
    done <<<"$query"
  done
  [[ "$result" == 0 ]]
}

stable_release_router_is_exact() {
  local router_container="$1" expected_container="${2:-}" expected_image="${3:-}"
  local inspection tagged_image_id
  [[ "$router_container" =~ ^[a-f0-9]{64}$ ]] || return 1
  inspection="$(docker inspect "$router_container")" || return 1
  tagged_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" || return 1
  [[ -z "$expected_container" || "$router_container" == "$expected_container" ]] \
    || return 1
  [[ -z "$expected_image" || "$tagged_image_id" == "$expected_image" ]] || return 1
  jq -e --arg containerId "$router_container" \
    --arg imageId "$tagged_image_id" --arg reference "$release_router_reference" \
    --arg revision "$release_router_revision" --arg contract "$release_router_contract" '
      length == 1 and .[0].Id == $containerId and .[0].Image == $imageId and
      (.[0].Config.Image == $reference or .[0].Config.Image == $imageId) and
      .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
      .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
      .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
      .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
      .[0].Config.User == "10001:10001" and .[0].HostConfig.ReadonlyRootfs == true and
      .[0].HostConfig.Privileged == false and .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
      ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
      ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
      (.[0].Mounts | length) == 1 and .[0].Mounts[0].Type == "volume" and
      .[0].Mounts[0].Name == "business_finlynq_private-release-router-state-v1" and
      .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
      ((.[0].NetworkSettings.Networks | keys | sort) ==
        (["business_finlynq_edge", "business_finlynq_private-frontend"] | sort)) and
      any(.[0].NetworkSettings.Networks.business_finlynq_edge.Aliases[]?;
        . == "production-app") and
      .[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"] and
      .[0].Config.Cmd == ["serve"] and
      (.[0].State.Status == "running" or .[0].State.Status == "exited" or
        .[0].State.Status == "created")
    ' <<<"$inspection" >/dev/null
}

ensure_stable_release_router_maintenance_before_fetch() (
  local router_container="$1" expected_container="${2:-}" expected_image="${3:-}"
  local running image_id token status body attempt health cleanup_status
  local fail_closed_armed="false"
  cleanup_router_maintenance_failure() {
    cleanup_status=$?
    trap - EXIT HUP INT TERM
    if (( cleanup_status != 0 )) && [[ "$fail_closed_armed" == true ]]; then
      docker stop --time 30 "$router_container" >/dev/null 2>&1 || cleanup_status=1
      [[ "$(docker inspect --format '{{.State.Running}}' \
        "$router_container" 2>/dev/null)" == false ]] || cleanup_status=1
    fi
    exit "$cleanup_status"
  }
  trap cleanup_router_maintenance_failure EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stable_release_router_is_exact "$router_container" \
    "$expected_container" "$expected_image" || return 1
  fail_closed_armed="true"
  image_id="$(docker inspect --format '{{.Image}}' "$router_container")" || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$router_container")" || return 1
  if [[ "$running" != true ]]; then
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
      --volumes-from "$router_container" --entrypoint sh "$image_id" -ec '
        set -eu
        [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
        temporary="/state/.mode.$$"
        trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
        printf "maintenance\n" >"$temporary"
        chmod 0600 "$temporary"
        mv -f "$temporary" /state/mode
        sync /state/mode 2>/dev/null || sync
        sync -f /state 2>/dev/null || sync
        trap - EXIT INT TERM
      ' >/dev/null 2>&1 || return 1
    docker start "$router_container" >/dev/null 2>&1 || return 1
    for attempt in {1..30}; do
      health="$(docker inspect --format \
        '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$router_container" 2>/dev/null)" || return 1
      [[ "$health" == true\|healthy ]] && break
      sleep 1
    done
    [[ "$health" == true\|healthy ]] || return 1
  else
    docker exec "$router_container" sh -ec '
      set -eu
      [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
      temporary="/state/.mode.$$"
      trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
      printf "maintenance\n" >"$temporary"
      chmod 0600 "$temporary"
      mv -f "$temporary" /state/mode
      sync /state/mode 2>/dev/null || sync
      sync -f /state 2>/dev/null || sync
      trap - EXIT INT TERM
    ' >/dev/null 2>&1 || return 1
  fi
  token="$(openssl rand -hex 32)" || return 1
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || return 1
  docker exec --env "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$token" \
    "$router_container" caddy reload --config /etc/caddy/Caddyfile.maintenance \
    --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 \
    || return 1
  status="$(curl --noproxy '*' --silent --show-error --max-time 5 \
    --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:3100/api/health 2>/dev/null)" || return 1
  [[ "$status" == 503 ]] || return 1
  body="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:3100/_business-finlynq/release-router/live 2>/dev/null)" \
    || return 1
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$body" >/dev/null || return 1
  network_alias_has_exact_owner \
    business_finlynq_edge production-app "$router_container"
)

network_alias_has_no_owner() {
  local network="$1" alias="$2" network_query container networks
  network_query="$(docker ps --all --no-trunc --filter "network=$network" \
    --format '{{.ID}}')" || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || return 1
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container")" || return 1
    if jq -e --arg network "$network" --arg alias "$alias" '
      has($network) and any(.[$network].Aliases[]?; . == $alias)
    ' <<<"$networks" >/dev/null; then
      return 1
    fi
  done <<<"$network_query"
}

restore_release_transition_before_database_mutation() {
  local app_inspection app_revision running worker_contract router_query app_health public_health
  local attempt
  [[ "$release_transition_phase" == pre-router-maintenance ]] || return 1
  pause_release_schedulers_before_fetch || return 1
  stop_incomplete_release_transients_before_fetch || return 1
  app_inspection="$(docker inspect "$release_transition_app_container_id")" || return 1
  jq -e --arg containerId "$release_transition_app_container_id" \
    --arg imageId "$release_transition_app_image_id" \
    --arg revision "$release_transition_source_revision" \
    --arg legacyRevision "$legacy_f8485_revision" '
      length == 1 and .[0].Id == $containerId and .[0].Image == $imageId and
      .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
      .[0].Config.Labels["com.docker.compose.service"] == "app" and
      (if $revision == $legacyRevision then
        ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
       else .[0].Config.Labels["org.opencontainers.image.revision"] == $revision end) and
      .[0].HostConfig.ReadonlyRootfs == true and .[0].HostConfig.Privileged == false and
      .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
      ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
      ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
      (.[0].State.Status == "running" or .[0].State.Status == "exited")
    ' <<<"$app_inspection" >/dev/null || return 1
  if [[ "$release_transition_router_was_preexisting" == true ]]; then
    router_query="$(docker ps --all --quiet --no-trunc \
      --filter label=com.docker.compose.project=business-finlynq \
      --filter label=com.docker.compose.service=release_router)" || return 1
    [[ "$router_query" == "$release_transition_router_container_id" ]] || return 1
    ensure_stable_release_router_maintenance_before_fetch "$router_query" \
      "$release_transition_router_container_id" \
      "$release_transition_router_image_id" || return 1
    network_alias_has_exact_owner business_finlynq_private-frontend release-app \
      "$release_transition_app_container_id" || return 1
  else
    router_query="$(docker ps --all --quiet --no-trunc \
      --filter label=com.docker.compose.project=business-finlynq \
      --filter label=com.docker.compose.service=release_router)" || return 1
    if [[ -n "$router_query" ]]; then
      [[ "$router_query" =~ ^[a-f0-9]{64}$ && "$router_query" != *$'\n'* ]] \
        || return 1
      stable_release_router_is_exact "$router_query" || return 1
      if [[ "$(docker inspect --format '{{.State.Running}}' "$router_query")" == true ]]; then
        if ! ensure_stable_release_router_maintenance_before_fetch "$router_query"; then
          docker stop --time 30 "$router_query" >/dev/null 2>&1 || return 1
          [[ "$(docker inspect --format '{{.State.Running}}' \
            "$router_query" 2>/dev/null)" == false ]] || return 1
        fi
      fi
      docker rm --force "$router_query" >/dev/null 2>&1 || return 1
    fi
    if network_alias_has_exact_owner business_finlynq_edge production-app \
      "$release_transition_app_container_id"; then
      :
    else
      network_alias_has_no_owner business_finlynq_edge production-app || return 1
      [[ "$(docker inspect --format \
        '{{if index .NetworkSettings.Networks "business_finlynq_edge"}}attached{{end}}' \
        "$release_transition_app_container_id")" == "" ]] || return 1
      docker network connect --alias production-app business_finlynq_edge \
        "$release_transition_app_container_id" >/dev/null 2>&1 || return 1
    fi
    network_alias_has_exact_owner business_finlynq_edge production-app \
      "$release_transition_app_container_id" || return 1
  fi
  if [[ "$release_transition_worker_was_running" == true ]]; then
    worker_contract="$(docker inspect --format \
      '{{.Id}}|{{.Image}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
      "$release_transition_worker_container_id" 2>/dev/null)" || return 1
    [[ "$worker_contract" \
      == "$release_transition_worker_container_id|$release_transition_worker_image_id|business-finlynq|auth_email_worker|$release_transition_worker_revision" ]] \
      || return 1
    docker start "$release_transition_worker_container_id" >/dev/null 2>&1 || return 1
  fi
  docker start "$release_transition_app_container_id" >/dev/null 2>&1 || return 1
  for attempt in {1..60}; do
    app_health="$(docker inspect --format \
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$release_transition_app_container_id" 2>/dev/null)" || return 1
    [[ "$app_health" == true\|healthy ]] && break
    sleep 2
  done
  [[ "$app_health" == true\|healthy ]] || return 1
  if [[ "$release_transition_router_was_preexisting" == true ]]; then
    release_runtime_matches_accepted_evidence maintenance \
      "$release_transition_source_revision" || return 1
    atomically_reload_router_active_and_persist "$release_transition_router_container_id" \
      || return 1
    release_runtime_matches_accepted_evidence active \
      "$release_transition_source_revision" \
      && live_release_router_is_active || return 1
  else
    pre_router_runtime_is_safely_active "$release_transition_source_revision" \
      "$release_transition_app_container_id" || return 1
  fi
  public_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    http://127.0.0.1:3100/api/health)" || return 1
  jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
    <<<"$public_health" >/dev/null || return 1
  clear_loaded_release_transition_journal
}

contain_forward_repair_transition_before_fetch() {
  local router_query
  [[ "$release_transition_phase" == forward-repair-required ]] || return 1
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" || return 1
  [[ "$router_query" =~ ^[a-f0-9]{64}$ && "$router_query" != *$'\n'* ]] \
    || return 1
  if [[ "$release_transition_router_was_preexisting" == true ]]; then
    ensure_stable_release_router_maintenance_before_fetch "$router_query" \
      "$release_transition_router_container_id" \
      "$release_transition_router_image_id" || return 1
  else
    ensure_stable_release_router_maintenance_before_fetch "$router_query" || return 1
  fi
  pause_release_schedulers_before_fetch || return 1
  stop_incomplete_release_transients_before_fetch || return 1
  stop_incomplete_release_write_surfaces_before_fetch || return 1
  release_forward_repair_pending="true"
}

recover_or_contain_release_transition_before_fetch() {
  [[ -e "$first_router_recovery_journal" || -L "$first_router_recovery_journal" ]] \
    || return 0
  load_release_transition_journal || return 1
  if [[ "$release_transition_phase" == forward-repair-required ]] \
    && release_is_accepted; then
    clear_loaded_release_transition_journal
    return
  fi
  case "$release_transition_phase" in
    pre-router-maintenance)
      restore_release_transition_before_database_mutation
      ;;
    forward-repair-required)
      contain_forward_repair_transition_before_fetch
      ;;
    *) return 1 ;;
  esac
}

contain_unaccepted_live_router_before_fetch() {
  local router_query durable_mode running marker_present="false"
  [[ -e "$active_finalization_marker" || -L "$active_finalization_marker" ]] \
    && marker_present="true"
  router_query="$(docker ps --all --quiet --no-trunc \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=release_router)" || return 1
  if [[ -z "$router_query" ]]; then
    [[ "$marker_present" == false ]]
    return
  fi
  [[ "$router_query" =~ ^[a-f0-9]{64}$ && "$router_query" != *$'\n'* ]] || return 1
  stable_release_router_is_exact "$router_query" || return 1
  network_alias_has_exact_owner \
    business_finlynq_edge production-app "$router_query" || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$router_query")" || return 1
  if [[ "$running" == true ]]; then
    durable_mode="$(docker exec "$router_query" sh -ec '
      [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
      [[ -f /state/mode && ! -L /state/mode && "$(stat -c "%u:%g:%a" /state/mode)" == 10001:10001:600 ]]
      cat /state/mode
    ')" || return 1
  else
    ensure_stable_release_router_maintenance_before_fetch "$router_query" || return 1
    durable_mode=maintenance
  fi
  [[ "$durable_mode" == active || "$durable_mode" == maintenance ]] || return 1

  if [[ "$marker_present" == true ]]; then
    if ! load_active_finalization_marker; then
      if ! ensure_stable_release_router_maintenance_before_fetch "$router_query"; then
        docker stop --time 30 "$router_query" >/dev/null 2>&1 || return 1
        [[ "$(docker inspect --format '{{.State.Running}}' \
          "$router_query" 2>/dev/null)" == false ]] || return 1
      fi
      pause_release_schedulers_before_fetch || return 1
      stop_incomplete_release_transients_before_fetch || return 1
      stop_incomplete_release_write_surfaces_before_fetch || return 1
      return 1
    fi
    if active_finalization_authorization_is_current \
      && active_finalization_container_ids_match \
      && release_runtime_matches_accepted_evidence active \
        "$active_finalization_revision" "$active_finalization_run_id" \
        "$active_finalization_app_image_id" "$active_finalization_router_image_id" \
      && live_release_router_is_active \
      && production_schedulers_are_active; then
      clear_loaded_active_finalization_marker
      return
    fi
    if interrupted_acceptance_is_finalizable; then
      if ! persist_interrupted_acceptance_active; then
        ensure_stable_release_router_maintenance_before_fetch "$router_query" \
          >/dev/null 2>&1 || true
        return 1
      fi
      active_finalization_container_ids_match \
        && release_runtime_matches_accepted_evidence active \
          "$active_finalization_revision" "$active_finalization_run_id" \
          "$active_finalization_app_image_id" "$active_finalization_router_image_id" \
        && live_release_router_is_active || return 1
      clear_loaded_active_finalization_marker
      return
    fi
    ensure_stable_release_router_maintenance_before_fetch "$router_query" || return 1
    pause_release_schedulers_before_fetch || return 1
    stop_incomplete_release_transients_before_fetch || return 1
    stop_incomplete_release_write_surfaces_before_fetch || return 1
    # A valid but non-finalizable marker is no longer an authorization to
    # restore traffic. Once maintenance and every write surface are proven,
    # retire that exact inode so the same revision can repeat all release gates
    # (or its first-router journal can drive the narrower recovery path).
    clear_loaded_active_finalization_marker || return 1
    return 0
  fi

  if release_is_accepted || installed_release_is_safely_active; then
    return 0
  fi
  ensure_stable_release_router_maintenance_before_fetch "$router_query" || return 1
  pause_release_schedulers_before_fetch || return 1
  stop_incomplete_release_transients_before_fetch || return 1
  stop_incomplete_release_write_surfaces_before_fetch
}

if [[ -e "$active_finalization_marker" || -L "$active_finalization_marker" ]]; then
  contain_unaccepted_live_router_before_fetch \
    || fail "could not prove the marked production router fail-closed before network access"
  recover_or_contain_release_transition_before_fetch \
    || fail "could not recover or contain the durable release transition before network access"
else
  recover_or_contain_release_transition_before_fetch \
    || fail "could not recover or contain the durable release transition before network access"
  contain_unaccepted_live_router_before_fetch \
    || fail "could not prove the local production router fail-closed before network access"
fi

git_as_deploy fetch --prune --force --no-tags origin \
  '+refs/heads/main:refs/remotes/origin/main'

remote_main_revision="$(git_as_deploy rev-parse refs/remotes/origin/main)"
validate_revision "$remote_main_revision"
candidate_revision="$remote_main_revision"
if [[ "$release_forward_repair_pending" == true ]]; then
  [[ "$source_revision" == "$release_transition_candidate_revision" ]] \
    || fail "forward repair is not running from its exact journaled candidate checkout"
  git_as_deploy merge-base --is-ancestor \
    "$release_transition_candidate_revision" "$remote_main_revision" \
    || fail "origin/main no longer contains the journaled forward-repair candidate"
  candidate_revision="$release_transition_candidate_revision"
fi
validate_revision "$candidate_revision"
git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision" \
  || fail "origin/main is not a fast-forward descendant of the deployed revision"

if [[ "$source_revision" == "$candidate_revision" ]]; then
  if release_is_accepted; then
    bash "$repository/deploy/edge/reconcile-shared-edge.sh"
    printf 'Production already runs accepted main revision %s.\n' "$candidate_revision"
    exit 0
  fi
  if interrupted_acceptance_is_finalizable; then
    persist_interrupted_acceptance_active \
      || fail "accepted live release durable active finalization failed"
    release_is_accepted \
      || fail "accepted live release did not pass strict verification after durable active finalization"
    bash "$repository/deploy/edge/reconcile-shared-edge.sh"
    printf 'Production durable active state finalized for accepted main revision %s.\n' \
      "$candidate_revision"
    exit 0
  fi
  printf 'Main revision %s has no complete active acceptance; safely rerunning its release gates.\n' \
    "$candidate_revision"
fi

verify_ci_approved_production_signal() (
  set -Eeuo pipefail
  local bundle_file bundle_size signal_asset signal_directory signal_file
  cleanup_production_signal() {
    local cleanup_status=$?
    trap - EXIT HUP INT TERM
    [[ -z "${signal_directory:-}" ]] || rm -rf -- "$signal_directory"
    exit "$cleanup_status"
  }
  signal_directory="$(mktemp -d /tmp/business-finlynq-production-signal.XXXXXX)"
  trap cleanup_production_signal EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -m 0700 -- "$signal_directory/home" "$signal_directory/config"
  signal_file="$signal_directory/business-finlynq-production-deployment-v1.txt"
  printf '%s\nrepository=%s\nrevision=%s\n' \
    'business-finlynq-production-deployment-v1' \
    "$production_signal_repository" \
    "$candidate_revision" >"$signal_file"
  chmod 0600 -- "$signal_file"
  signal_asset="business-finlynq-production-deployment-$candidate_revision.attestation.json"
  bundle_file="$signal_directory/$signal_asset"
  env -i PATH="$clean_path" LC_ALL=C LANG=C \
    timeout --signal=TERM --kill-after=10 45 \
      curl --disable --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --fail --silent --show-error \
        --location --max-redirs 3 --connect-timeout 10 --max-time 30 \
        --retry 2 --retry-delay 1 --retry-connrefused \
        --max-filesize 16777216 \
        "https://github.com/$production_signal_repository/releases/download/production-deployment-signals/$signal_asset" \
        --output "$bundle_file"
  chmod 0600 -- "$bundle_file"
  bundle_size="$(stat -c '%s' -- "$bundle_file")" || return 1
  [[ "$bundle_size" =~ ^[0-9]+$ \
    && "$bundle_size" -ge 1 && "$bundle_size" -le 16777216 \
    && "$(stat -c '%u:%g:%a:%h' -- "$bundle_file")" == 0:0:600:1 ]] \
    || return 1
  jq -e '
    type == "object" and
    .mediaType == "application/vnd.dev.sigstore.bundle.v0.3+json" and
    (.verificationMaterial | type == "object") and
    (.dsseEnvelope | type == "object") and
    .dsseEnvelope.payloadType == "application/vnd.in-toto+json" and
    (.dsseEnvelope.payload | type == "string" and length > 0) and
    (.dsseEnvelope.signatures | type == "array" and length >= 1 and
      all(.[]; type == "object" and (.sig | type == "string" and length > 0)))
  ' "$bundle_file" >/dev/null
  env -i \
    HOME="$signal_directory/home" \
    GH_CONFIG_DIR="$signal_directory/config" \
    XDG_CACHE_HOME="$production_signal_cache_directory" \
    GH_PROMPT_DISABLED=1 NO_COLOR=1 PATH="$clean_path" LC_ALL=C LANG=C \
    timeout --signal=TERM --kill-after=15 90 \
      "$github_cli" attestation verify "$signal_file" \
        --repo "$production_signal_repository" \
        --bundle "$bundle_file" \
        --cert-identity "$production_signal_certificate_identity" \
        --cert-oidc-issuer https://token.actions.githubusercontent.com \
        --signer-digest "$candidate_revision" \
        --source-digest "$candidate_revision" \
        --source-ref refs/heads/main \
        --deny-self-hosted-runners \
        --predicate-type https://slsa.dev/provenance/v1 >/dev/null
)

candidate_uses_trusted_production_workflows() {
  local digest expected path remainder workflow_spec
  for workflow_spec in \
    "$production_signal_workflow_path:$production_signal_workflow_sha256" \
    "$quality_gate_workflow_path:$quality_gate_workflow_sha256"; do
    path="${workflow_spec%%:*}"
    expected="${workflow_spec#*:}"
    read -r digest remainder < <(
      git_as_deploy cat-file blob "$candidate_revision:$path" | sha256sum
    ) || return 1
    [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$remainder" \
      && "$digest" == "$expected" ]] || return 1
  done
}

candidate_uses_trusted_production_workflows \
  || fail "candidate changes the root-approved production or quality-gate workflow"
verify_ci_approved_production_signal \
  || fail "origin/main lacks an exact GitHub-hosted quality-gate attestation"

mapfile -t retained_app_containers < <(docker ps --all --no-trunc --quiet \
  --filter label=com.docker.compose.project=business-finlynq \
  --filter label=com.docker.compose.service=app)
if [[ "$release_forward_repair_pending" == true ]]; then
  [[ "${#retained_app_containers[@]}" -le 1 ]] \
    || fail "forward repair found an ambiguous retained application inventory"
  backup_source_revision="$release_transition_source_revision"
  retained_app_image_id="$release_transition_app_image_id"
  if [[ "${#retained_app_containers[@]}" == 1 ]]; then
    retained_app_container="${retained_app_containers[0]}"
    retained_candidate_image_id="$(docker image inspect --format '{{.Id}}' \
      "business-finlynq-app:$candidate_revision" 2>/dev/null)" \
      || fail "forward repair lost the exact candidate application image"
    docker inspect "$retained_app_container" | jq -e \
      --arg sourceRevision "$backup_source_revision" \
      --arg sourceImage "$retained_app_image_id" \
      --arg candidateRevision "$candidate_revision" \
      --arg candidateImage "$retained_candidate_image_id" \
      --arg legacyRevision "$legacy_f8485_revision" '
        length == 1 and
        .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
        .[0].Config.Labels["com.docker.compose.service"] == "app" and
        .[0].State.Running == false and .[0].HostConfig.ReadonlyRootfs == true and
        .[0].HostConfig.Privileged == false and
        .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
        ((.[0].HostConfig.CapDrop // []) | sort) == ["ALL"] and
        ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
        ((.[0].Image == $sourceImage and
          (if $sourceRevision == $legacyRevision then
             ((.[0].Config.Labels["org.opencontainers.image.revision"] // "") == "")
           else
             .[0].Config.Labels["org.opencontainers.image.revision"] == $sourceRevision
           end)) or
         (.[0].Image == $candidateImage and
          .[0].Config.Labels["org.opencontainers.image.revision"] == $candidateRevision))
      ' >/dev/null \
      || fail "forward repair retained an unexpected application container"
    current_retained_app_image="$(docker inspect --format '{{.Image}}' \
      "$retained_app_container")" \
      || fail "forward repair application image could not be inspected"
    if [[ "$release_transition_router_was_preexisting" == true \
      || "$current_retained_app_image" == "$retained_candidate_image_id" ]]; then
      network_alias_has_exact_owner business_finlynq_private-frontend release-app \
        "$retained_app_container" \
        || fail "forward repair application is not the unique private upstream"
    else
      [[ "$current_retained_app_image" == "$retained_app_image_id" \
        && "$(docker inspect --format \
          '{{if index .NetworkSettings.Networks "business_finlynq_edge"}}attached{{end}}' \
          "$retained_app_container")" == "" ]] \
        || fail "forward repair legacy source application retained the public edge"
    fi
  fi
else
  [[ "${#retained_app_containers[@]}" == 1 ]] \
    || fail "exactly one retained application container is required for backup trust"
  retained_app_container="${retained_app_containers[0]}"
  backup_source_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$retained_app_container")"
  retained_app_image_id="$(docker inspect --format '{{.Image}}' "$retained_app_container")" \
    || fail "the retained application image identity could not be inspected"
fi
if [[ -z "$backup_source_revision" || "$backup_source_revision" == "<no value>" ]]; then
  [[ "$retained_app_image_id" == "$legacy_f8485_image_id" ]] \
    || fail "the retained application has no full OCI revision and is not the exact legacy compatibility image"
  backup_source_revision="$legacy_f8485_revision"
fi
if [[ "$backup_source_revision" == "$legacy_f8485_revision" ]]; then
  [[ "$retained_app_image_id" == "$legacy_f8485_image_id" ]] \
    || fail "the retained legacy application image differs from the exact compatibility artifact"
  export ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only
fi
validate_revision "$backup_source_revision"
git_as_deploy cat-file -e "$backup_source_revision^{commit}" \
  || fail "the retained application revision is not a local Git commit"
git_as_deploy merge-base --is-ancestor "$backup_source_revision" "$candidate_revision" \
  || fail "the retained application revision is not an ancestor of the candidate"

[[ "${BACKUP_RECEIVER_HOST:-}" =~ ^[A-Za-z0-9.-]+$ ]] \
  || fail "BACKUP_RECEIVER_HOST is missing or invalid"
[[ "${BACKUP_RECEIVER_USER:-}" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || fail "BACKUP_RECEIVER_USER is missing or invalid"
[[ -f "${BACKUP_RECEIVER_KEY_FILE:-}" && ! -L "${BACKUP_RECEIVER_KEY_FILE:-}" \
  && "$(stat -c '%u:%a' -- "$BACKUP_RECEIVER_KEY_FILE")" == 0:400 ]] \
  || fail "the receiver deployment key must be root-owned mode 0400"
[[ -f "${BACKUP_RECEIVER_KNOWN_HOSTS_FILE:-}" \
  && ! -L "${BACKUP_RECEIVER_KNOWN_HOSTS_FILE:-}" \
  && "$(stat -c '%u:%a' -- "$BACKUP_RECEIVER_KNOWN_HOSTS_FILE")" == 0:400 ]] \
  || fail "the receiver known-hosts file must be root-owned mode 0400"

ssh_output="$(ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o ConnectTimeout=15 -o ConnectionAttempts=1 \
  -o "UserKnownHostsFile=$BACKUP_RECEIVER_KNOWN_HOSTS_FILE" \
  -i "$BACKUP_RECEIVER_KEY_FILE" \
  "$BACKUP_RECEIVER_USER@$BACKUP_RECEIVER_HOST" \
  "allow $backup_source_revision $candidate_revision")" \
  || fail "the off-server backup receiver refused the source/candidate allowlist"
[[ "$ssh_output" == "Allowed backup revisions $backup_source_revision and $candidate_revision." ]] \
  || fail "the off-server backup receiver returned an unexpected acknowledgement"

temporary_files=()
mutated="false"
release_child_containment_armed="false"

force_parent_release_router_maintenance() {
  local query inspection tagged_image_id lifecycle token status body
  query="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq' \
    --filter 'label=com.docker.compose.service=release_router')" \
    || return 1
  [[ -n "$query" ]] || return 1
  [[ "$query" =~ ^[a-f0-9]{64}$ && "$query" != *$'\n'* ]] || return 1
  inspection="$(docker inspect "$query")" || return 1
  tagged_image_id="$(docker image inspect --format '{{.Id}}' \
    "$release_router_reference")" \
    || return 1
  [[ "$tagged_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  jq -e --arg imageId "$tagged_image_id" \
    --arg revision "$release_router_revision" \
    --arg contract "$release_router_contract" '
    length == 1 and .[0].Image == $imageId and
    .[0].Config.Labels["com.docker.compose.project"] == "business-finlynq" and
    .[0].Config.Labels["com.docker.compose.service"] == "release_router" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["com.business-finlynq.release-router.contract"] == $contract and
    .[0].Config.User == "10001:10001" and
    .[0].HostConfig.ReadonlyRootfs == true and
    (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
    (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true")) != null and
    (.[0].Mounts | length) == 1 and .[0].Mounts[0].Type == "volume" and
    .[0].Mounts[0].Name == "business_finlynq_private-release-router-state-v1" and
    .[0].Mounts[0].Destination == "/state" and .[0].Mounts[0].RW == true and
    ((.[0].NetworkSettings.Networks | keys | sort) ==
      (["business_finlynq_edge", "business_finlynq_private-frontend"] | sort)) and
    any(.[0].NetworkSettings.Networks.business_finlynq_edge.Aliases[]?;
      . == "production-app") and
    all(.[0].NetworkSettings.Networks["business_finlynq_private-frontend"].Aliases[]?;
      . != "production-app") and
    (.[0].State.Status == "running" or .[0].State.Status == "exited")
  ' <<<"$inspection" >/dev/null || return 1
  lifecycle="$(jq -er '.[0].State.Status' <<<"$inspection")" || return 1
  if [[ "$lifecycle" == exited ]]; then
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --pids-limit 32 --memory 32m --cpus 0.25 \
      --volumes-from "$query" --entrypoint sh "$tagged_image_id" -ec '
        set -eu
        [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
        temporary="/state/.mode.$$"
        trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
        printf "maintenance\n" >"$temporary"
        chmod 0600 "$temporary"
        mv -f "$temporary" /state/mode
        sync /state/mode 2>/dev/null || sync
        sync -f /state 2>/dev/null || sync
        trap - EXIT INT TERM
      ' >/dev/null 2>&1
    network_alias_has_exact_owner \
      business_finlynq_edge production-app "$query"
    return
  fi
  docker exec "$query" sh -ec '
    set -eu
    [[ -d /state && ! -L /state && "$(stat -c "%u:%g:%a" /state)" == 10001:10001:700 ]]
    temporary="/state/.mode.$$"
    trap '\''rm -f -- "$temporary"'\'' EXIT INT TERM
    printf "maintenance\n" >"$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" /state/mode
    sync /state/mode 2>/dev/null || sync
    sync -f /state 2>/dev/null || sync
    trap - EXIT INT TERM
  ' >/dev/null 2>&1 || return 1
  token="$(openssl rand -hex 32)" || return 1
  [[ "$token" =~ ^[a-f0-9]{64}$ ]] || return 1
  docker exec --env "BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$token" \
    "$query" caddy reload --config /etc/caddy/Caddyfile.maintenance \
    --adapter caddyfile --address unix//tmp/caddy-admin.sock >/dev/null 2>&1 \
    || return 1
  status="$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' http://127.0.0.1:3100/api/health 2>/dev/null)" \
    || return 1
  [[ "$status" == 503 ]] || return 1
  body="$(curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:3100/_business-finlynq/release-router/live 2>/dev/null)" \
    || return 1
  jq -e 'type == "object" and keys == ["status"] and .status == "release-router-live"' \
    <<<"$body" >/dev/null || return 1
  network_alias_has_exact_owner \
    business_finlynq_edge production-app "$query"
}

stop_parent_release_service() {
  local service="$1" query container running result=0
  query="$(docker ps --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=business-finlynq' \
    --filter "label=com.docker.compose.service=$service" 2>/dev/null)" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    if [[ ! "$container" =~ ^[a-f0-9]{64}$ ]]; then
      result=1
      continue
    fi
    docker stop --time 30 "$container" >/dev/null 2>&1 || true
    running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
      || running=removed
    [[ "$running" == false || "$running" == removed ]] || result=1
  done <<<"$query"
  return "$result"
}

stop_parent_public_alias_owners() {
  local network_query container networks running remaining_query owner_count=0 result=0
  local identity project service
  network_query="$(docker ps --all --no-trunc \
    --filter network=business_finlynq_edge --format '{{.ID}}' 2>/dev/null)" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[a-f0-9]{64}$ ]] || { result=1; continue; }
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container" 2>/dev/null)" || { result=1; continue; }
    if jq -e '
      has("business_finlynq_edge") and
      any(.business_finlynq_edge.Aliases[]?; . == "production-app")
    ' <<<"$networks" >/dev/null; then
      identity="$(docker inspect --format \
        '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
        "$container" 2>/dev/null)" || { result=1; continue; }
      IFS='|' read -r project service <<<"$identity"
      if [[ "$project" != business-finlynq \
        || ( "$service" != app && "$service" != release_router ) ]]; then
        result=1
        continue
      fi
      running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
        || { result=1; continue; }
      if [[ "$running" == true ]]; then
        docker stop --time 30 "$container" >/dev/null 2>&1 || true
        running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" \
          || { result=1; continue; }
      fi
      [[ "$running" == false ]] || result=1
    fi
  done <<<"$network_query"
  remaining_query="$(docker ps --no-trunc \
    --filter network=business_finlynq_edge --format '{{.ID}}' 2>/dev/null)" \
    || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' \
      "$container" 2>/dev/null)" || return 1
    if jq -e '
      has("business_finlynq_edge") and
      any(.business_finlynq_edge.Aliases[]?; . == "production-app")
    ' <<<"$networks" >/dev/null; then
      (( owner_count += 1 ))
    fi
  done <<<"$remaining_query"
  [[ "$result" == 0 && "$owner_count" == 0 ]]
}

terminal_acceptance_recovery_pending="false"
contain_parent_release_failure() {
  local containment_failed=false
  if release_is_accepted || marked_terminal_acceptance_is_preservable; then
    terminal_acceptance_recovery_pending="true"
    return 0
  fi
  bash "$repository/deploy/release/pause-schedulers.sh" \
    systemd --allow-already-paused >/dev/null 2>&1 \
    || containment_failed=true
  # A normal child failure may already have restored the exact previously
  # accepted runtime. Keep that proven source revision available; only the
  # schedulers stay paused because their protected environment now names the
  # candidate revision. Missing acceptance proves an incomplete/killed child
  # and must drive the public surface back to maintenance.
  if [[ "$containment_failed" == false ]] \
    && ( source_release_is_safely_active \
      || source_pre_router_runtime_is_safely_active ); then
    return 0
  fi
  if ! force_parent_release_router_maintenance; then
    stop_parent_release_service release_router || containment_failed=true
    stop_parent_release_service app || containment_failed=true
    stop_parent_public_alias_owners || containment_failed=true
  fi
  stop_parent_release_service auth_email_worker || containment_failed=true
  [[ "$containment_failed" == false ]]
}

cleanup() {
  local status="$?" temporary latch_temporary containment_proven=true
  trap - EXIT
  trap '' HUP INT TERM
  for temporary in "${temporary_files[@]}"; do
    [[ -n "$temporary" ]] && rm -f -- "$temporary"
  done
  if [[ "$status" != 0 && "$mutated" == true ]]; then
    if [[ "$release_child_containment_armed" == true ]] \
      && ! contain_parent_release_failure; then
      containment_proven=false
      printf '%s\n' \
        'URGENT: parent release containment could not prove both router maintenance and scheduler pause.' >&2
    fi
    if [[ "$terminal_acceptance_recovery_pending" == true ]]; then
      printf '%s\n' \
        'Accepted terminal evidence is recoverable; leaving the durable marker for the next automatic finalization attempt.' >&2
    elif [[ "$containment_proven" == true \
      && ( "$status" == 129 || "$status" == 130 || "$status" == 143 ) ]]; then
      printf '%s\n' \
        'Deployment interruption was contained; leaving durable recovery state for the next automatic attempt.' >&2
    else
      latch_temporary="$(mktemp "${failure_latch}.XXXXXX")"
      printf 'sourceRevision=%s\ncandidateRevision=%s\nfailedAt=%s\ncontainmentProven=%s\n' \
        "$source_revision" "$candidate_revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$containment_proven" \
        >"$latch_temporary"
      chmod 0600 "$latch_temporary"
      chown root:root "$latch_temporary"
      mv -f -- "$latch_temporary" "$failure_latch"
      sync -f -- "${failure_latch%/*}"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

prepared_file=""
prepare_revision_file() {
  local target="$1" owner="$2" group="$3" mode="$4" temporary metadata
  [[ -f "$target" && ! -L "$target" ]] \
    || fail "protected environment file is missing or symbolic: $target"
  metadata="$(stat -c '%U:%G:%a' -- "$target")"
  [[ "$metadata" == "$owner:$group:$mode" ]] \
    || fail "protected environment metadata is unexpected: $target ($metadata)"
  [[ "$(grep -Fxc "BUSINESS_FINLYNQ_IMAGE_REVISION=$source_revision" "$target")" == 1 \
    && "$(grep -Fxc "MONITOR_EXPECT_REVISION=$source_revision" "$target")" == 1 ]] \
    || fail "protected environment does not identify the deployed source revision: $target"
  [[ -z "$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$target" | sort | uniq -d)" ]] \
    || fail "protected environment contains duplicate keys: $target"

  temporary="$(mktemp "${target}.continuous-deployment.XXXXXX")"
  temporary_files+=("$temporary")
  awk -v old="$source_revision" -v new="$candidate_revision" '
    $0 == "BUSINESS_FINLYNQ_IMAGE_REVISION=" old {
      print "BUSINESS_FINLYNQ_IMAGE_REVISION=" new
      image_count++
      next
    }
    $0 == "MONITOR_EXPECT_REVISION=" old {
      print "MONITOR_EXPECT_REVISION=" new
      monitor_count++
      next
    }
    { print }
    END { if (image_count != 1 || monitor_count != 1) exit 42 }
  ' "$target" >"$temporary" \
    || fail "could not prepare the candidate revision environment: $target"
  chown "$owner:$group" "$temporary"
  chmod "$mode" "$temporary"
  prepared_file="$temporary"
}

prepare_revision_file "$compose_environment" root deploy 600
compose_temporary="$prepared_file"
prepare_revision_file "$operations_environment" root deploy 600
operations_temporary="$prepared_file"
prepare_revision_file "$repository_environment" deploy deploy 600
repository_temporary="$prepared_file"
cmp -s -- "$compose_temporary" "$repository_temporary" \
  || fail "the candidate Compose and repository environments are not identical"

mutated="true"
git_as_deploy merge --ff-only "$candidate_revision"
[[ "$(git_as_deploy rev-parse HEAD)" == "$candidate_revision" \
  && -z "$(git_as_deploy status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the canonical checkout did not move cleanly to the candidate"

mv -f -- "$compose_temporary" "$compose_environment"
mv -f -- "$operations_temporary" "$operations_environment"
mv -f -- "$repository_temporary" "$repository_environment"
temporary_files=()
sync -f -- "$compose_environment"
sync -f -- "$operations_environment"
sync -f -- "$repository_environment"

run_id="auto-${candidate_revision:0:10}-$(date -u +%H%M%S)"
export RELEASE_EXECUTION_ACK="release:$candidate_revision:$run_id"
release_child_containment_armed="true"
bash "$repository/deploy/release/run-release.sh" \
  --mode release \
  --revision "$candidate_revision" \
  --environment "$compose_environment" \
  --operations-environment "$operations_environment" \
  --evidence-root "$evidence_root" \
  --run-id "$run_id" \
  --scheduler systemd \
  --host-lock-fd 8

release_is_accepted || fail "the release runner returned without an accepted live revision"
bash "$repository/deploy/edge/reconcile-shared-edge.sh"
release_child_containment_armed="false"
mutated="false"
trap - EXIT HUP INT TERM
printf 'Production deployment accepted for main revision %s.\n' "$candidate_revision"
