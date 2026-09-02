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
readonly clean_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf 'Business Finlynq continuous deployment refused: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" == 0 ]] || fail "run this command as root"

for command_name in awk bash chmod chown cmp curl date docker env flock git grep id install \
  jq mktemp mv readlink rm runuser sed sort ssh stat sync uniq; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

validate_revision() {
  [[ "$1" =~ ^[a-f0-9]{40}$ && ! "$1" =~ ^0+$ ]] \
    || fail "revision must be a non-zero full 40-character Git SHA"
}

if [[ "${1:-}" == "--clear-failure" ]]; then
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

[[ -d "$repository/.git" && ! -L "$repository" ]] \
  || fail "the canonical production checkout is unavailable"
[[ -d "${automation_lock%/*}" && ! -L "${automation_lock%/*}" ]] \
  || fail "the application state directory is unavailable"
[[ ! -L "$automation_lock" ]] || fail "the automation lock is symbolic"
exec 9>"$automation_lock"
chmod 0600 "$automation_lock"
flock --exclusive --nonblock 9 || fail "another continuous-deployment check is active"
[[ ! -L "$host_deployment_lock" ]] || fail "the host deployment lock is symbolic"
exec 8>"$host_deployment_lock"
chmod 0600 "$host_deployment_lock"
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

git_as_deploy fetch --prune --force --no-tags origin \
  '+refs/heads/main:refs/remotes/origin/main' \
  '+refs/tags/deploy-production-*:refs/tags/deploy-production-*'

source_revision="$(git_as_deploy rev-parse HEAD)"
candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/main)"
validate_revision "$source_revision"
validate_revision "$candidate_revision"
git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision" \
  || fail "origin/main is not a fast-forward descendant of the deployed revision"

release_is_accepted() {
  local app_container detailed_health
  local -a app_containers
  [[ -f "$boundary_file" && ! -L "$boundary_file" ]] || return 1
  jq -e --arg revision "$candidate_revision" '
    .schemaVersion == 1 and .product == "business-finlynq" and
    .boundaryVersion == 1 and .installedRevision == $revision and
    .scheduler == "systemd"
  ' "$boundary_file" >/dev/null || return 1
  mapfile -t app_containers < <(docker ps --no-trunc --quiet \
    --filter label=com.docker.compose.project=business-finlynq \
    --filter label=com.docker.compose.service=app)
  [[ "${#app_containers[@]}" == 1 ]] || return 1
  app_container="${app_containers[0]}"
  [[ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$app_container")" == "$candidate_revision" ]] || return 1
  detailed_health="$(curl --noproxy '*' --fail --silent --show-error --max-time 20 \
    --header 'X-Business-Finlynq-Internal-Health: 1' http://127.0.0.1:3100/api/health)" \
    || return 1
  jq -e --arg revision "$candidate_revision" \
    '.status == "ready" and .revision == $revision' <<<"$detailed_health" >/dev/null
}

if [[ "$source_revision" == "$candidate_revision" ]]; then
  release_is_accepted \
    || fail "main is checked out but the matching release is not accepted; automatic retry is unsafe"
  printf 'Production already runs accepted main revision %s.\n' "$candidate_revision"
  exit 0
fi

signal_tag="deploy-production-$candidate_revision"
signal_revision="$(git_as_deploy rev-parse "refs/tags/$signal_tag^{commit}" 2>/dev/null || true)"
[[ "$signal_revision" == "$candidate_revision" ]] \
  || fail "the successful quality gate has not published the immutable deployment signal"

mapfile -t retained_app_containers < <(docker ps --all --no-trunc --quiet \
  --filter label=com.docker.compose.project=business-finlynq \
  --filter label=com.docker.compose.service=app)
[[ "${#retained_app_containers[@]}" == 1 ]] \
  || fail "exactly one retained application container is required for backup trust"
retained_app_container="${retained_app_containers[0]}"
backup_source_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$retained_app_container")"
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
cleanup() {
  local status="$?" temporary latch_temporary
  for temporary in "${temporary_files[@]}"; do
    [[ -n "$temporary" ]] && rm -f -- "$temporary"
  done
  if [[ "$status" != 0 && "$mutated" == true ]]; then
    latch_temporary="$(mktemp "${failure_latch}.XXXXXX")"
    printf 'sourceRevision=%s\ncandidateRevision=%s\nfailedAt=%s\n' \
      "$source_revision" "$candidate_revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$latch_temporary"
    chmod 0600 "$latch_temporary"
    chown root:root "$latch_temporary"
    mv -f -- "$latch_temporary" "$failure_latch"
    sync -f -- "${failure_latch%/*}"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

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
bash "$repository/deploy/release/run-release.sh" \
  --mode release \
  --revision "$candidate_revision" \
  --environment "$compose_environment" \
  --operations-environment "$operations_environment" \
  --evidence-root "$evidence_root" \
  --run-id "$run_id" \
  --scheduler systemd

release_is_accepted || fail "the release runner returned without an accepted live revision"
mutated="false"
trap - EXIT INT TERM
printf 'Production deployment accepted for main revision %s.\n' "$candidate_revision"
