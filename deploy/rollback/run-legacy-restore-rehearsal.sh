#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

for command_name in cat chmod docker flock git grep jq mktemp openssl readlink rm sha256sum stat tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required legacy restore-rehearsal command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
for forbidden_container_control in DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE \
  COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR; do
  if [[ -n "${!forbidden_container_control+x}" ]]; then
    printf 'Unset ambient container-routing variable before rollback rehearsal: %s\n' \
      "$forbidden_container_control" >&2
    exit 2
  fi
done

: "${ROLLBACK_COMPATIBILITY_ACK:?set ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only}"
[[ "$ROLLBACK_COMPATIBILITY_ACK" == "f8485-one-release-only" ]] || {
  printf '%s\n' "Rollback rehearsal acknowledgement is invalid" >&2
  exit 1
}
: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
[[ "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ \
  && ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]] || {
  printf '%s\n' "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full reviewed revision" >&2
  exit 2
}

# The main recovery drill and this compatibility rehearsal use the same Compose
# project and restore service names. Hold the identical host-wide lock before
# any cleanup so they can never remove or mix each other's tmpfs containers.
RESTORE_DRILL_LOCK_FILE="${RESTORE_DRILL_LOCK_FILE:-/var/lib/business-finlynq/restore-drill.lock}"
RESTORE_DRILL_LOCK_WAIT_SECONDS="${RESTORE_DRILL_LOCK_WAIT_SECONDS:-0}"
[[ "$RESTORE_DRILL_LOCK_FILE" == /* && "$RESTORE_DRILL_LOCK_FILE" != "/" \
  && "$RESTORE_DRILL_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ \
  && ${#RESTORE_DRILL_LOCK_WAIT_SECONDS} -le 4 ]] || {
  printf '%s\n' "Legacy rehearsal restore lock configuration is invalid" >&2
  exit 2
}
restore_lock_directory="${RESTORE_DRILL_LOCK_FILE%/*}"
restore_lock_name="${RESTORE_DRILL_LOCK_FILE##*/}"
[[ -d "$restore_lock_directory" && ! -L "$restore_lock_directory" \
  && "$restore_lock_name" != "." && "$restore_lock_name" != ".." ]] || {
  printf '%s\n' "Legacy rehearsal restore lock directory is unavailable or unsafe" >&2
  exit 2
}
restore_lock_directory="$(cd -- "$restore_lock_directory" && pwd -P)"
RESTORE_DRILL_LOCK_FILE="$restore_lock_directory/$restore_lock_name"
[[ ! -e "$RESTORE_DRILL_LOCK_FILE" \
  || ( -f "$RESTORE_DRILL_LOCK_FILE" && ! -L "$RESTORE_DRILL_LOCK_FILE" ) ]] || {
  printf '%s\n' "Legacy rehearsal restore lock file is unsafe" >&2
  exit 2
}
exec 8>>"$RESTORE_DRILL_LOCK_FILE"
chmod 0600 -- "$RESTORE_DRILL_LOCK_FILE"
flock --exclusive --wait "$RESTORE_DRILL_LOCK_WAIT_SECONDS" 8 || {
  printf '%s\n' "Another host restore drill holds the exclusive lock" >&2
  exit 75
}

# Use only the exact reviewed Git tree for Compose resolution and relative bind
# sources. A clean/live checkout check prevents an operator from certifying a
# revision different from HEAD, while git archive makes a later retag,
# checkout, or file edit irrelevant for the lifetime of this rehearsal.
repository_head="$(git -c safe.directory="$repository_root" -C "$repository_root" rev-parse --verify HEAD)" || {
  printf '%s\n' "Cannot resolve the legacy rehearsal checkout HEAD" >&2
  exit 2
}
[[ "$repository_head" == "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]] || {
  printf '%s\n' "Legacy rehearsal checkout HEAD does not match BUSINESS_FINLYNQ_IMAGE_REVISION" >&2
  exit 2
}
repository_status="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all)" || {
  printf '%s\n' "Cannot verify the legacy rehearsal checkout state" >&2
  exit 2
}
[[ -z "$repository_status" ]] || {
  printf '%s\n' "Legacy rehearsal checkout must be clean, including untracked files" >&2
  exit 2
}
unset repository_status

restore_source_snapshot="$(mktemp -d "$restore_lock_directory/.legacy-restore-source.XXXXXX")"
[[ -d "$restore_source_snapshot" && ! -L "$restore_source_snapshot" ]] || {
  printf '%s\n' "Could not create a private legacy rehearsal source snapshot" >&2
  exit 2
}
chmod 0700 -- "$restore_source_snapshot"
immutable_override=""
cleanup_rehearsal_workspace_only() {
  if [[ -n "$immutable_override" ]]; then
    rm -f -- "$immutable_override"
  fi
  case "$restore_source_snapshot" in
    "$restore_lock_directory"/.legacy-restore-source.*)
      [[ ! -L "$restore_source_snapshot" ]] && rm -rf -- "$restore_source_snapshot"
      ;;
  esac
}
trap cleanup_rehearsal_workspace_only EXIT INT TERM
git -c safe.directory="$repository_root" -C "$repository_root" \
  archive --format=tar "$BUSINESS_FINLYNQ_IMAGE_REVISION" \
  | tar --extract --file=- --directory "$restore_source_snapshot" \
      --no-same-owner --same-permissions || {
    printf '%s\n' "Could not materialize the reviewed legacy rehearsal source snapshot" >&2
    exit 2
  }
for snapshot_compose_file in \
  "$restore_source_snapshot/docker-compose.yml" \
  "$restore_source_snapshot/deploy/rollback/docker-compose.restore-rehearsal.yml"; do
  [[ -f "$snapshot_compose_file" && ! -L "$snapshot_compose_file" ]] || {
    printf 'Reviewed legacy rehearsal snapshot has no safe Compose file: %s\n' \
      "$snapshot_compose_file" >&2
    exit 2
  }
done

verify_recovery_image() {
  local reference="$1" expected_revision="$2" image_id image_revision
  image_id="$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || {
    printf 'Reviewed recovery image is unavailable locally: %s\n' "$reference" >&2
    exit 2
  }
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$expected_revision" ]] || {
    printf 'Recovery image identity does not match the reviewed revision: %s\n' "$reference" >&2
    exit 2
  }
  printf '%s' "$image_id"
}

readonly legacy_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
readonly legacy_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"
RESTORE_APP_IMAGE_ID="$(verify_recovery_image "business-finlynq-app:$BUSINESS_FINLYNQ_IMAGE_REVISION" "$BUSINESS_FINLYNQ_IMAGE_REVISION")"
RESTORE_MIGRATOR_IMAGE_ID="$(verify_recovery_image "business-finlynq-migrator:$BUSINESS_FINLYNQ_IMAGE_REVISION" "$BUSINESS_FINLYNQ_IMAGE_REVISION")"
RESTORE_OPERATIONS_IMAGE_ID="$(verify_recovery_image "business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION" "$BUSINESS_FINLYNQ_IMAGE_REVISION")"
[[ "$(verify_recovery_image "$legacy_image_id" "$legacy_revision")" == "$legacy_image_id" ]] || {
  printf '%s\n' "Hard-pinned legacy application image identity changed" >&2
  exit 2
}
export RESTORE_APP_IMAGE_ID RESTORE_MIGRATOR_IMAGE_ID RESTORE_OPERATIONS_IMAGE_ID

immutable_override="$(mktemp "$restore_lock_directory/.legacy-restore-images.XXXXXX.yml")"
chmod 0600 -- "$immutable_override"
cat >"$immutable_override" <<YAML
services:
  restore_verify: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_migrate: { image: "$RESTORE_MIGRATOR_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_runtime_grants: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_auth_worker_grants: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_backup_grants: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_accounting_verify: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_demo_bootstrap: { image: "$RESTORE_MIGRATOR_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_key_verify: { image: "$RESTORE_MIGRATOR_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_app: { image: "$RESTORE_APP_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_runtime_verify: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  restore_evidence: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
  rollback_rehearsal_app: { image: "$legacy_image_id", pull_policy: never, build: !reset null }
  rollback_rehearsal_verify: { image: "$RESTORE_OPERATIONS_IMAGE_ID", pull_policy: never, build: !reset null }
YAML

compose=(
  docker compose
  --project-directory "$restore_source_snapshot"
  --env-file /dev/null
  --file "$restore_source_snapshot/docker-compose.yml"
  --file "$restore_source_snapshot/deploy/rollback/docker-compose.restore-rehearsal.yml"
  --file "$immutable_override"
  --profile restore-drill
)
rendered_compose="$("${compose[@]}" config --format json)"
declare -A expected_images=(
  [restore_verify]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_migrate]="$RESTORE_MIGRATOR_IMAGE_ID"
  [restore_runtime_grants]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_auth_worker_grants]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_backup_grants]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_accounting_verify]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_demo_bootstrap]="$RESTORE_MIGRATOR_IMAGE_ID"
  [restore_key_verify]="$RESTORE_MIGRATOR_IMAGE_ID"
  [restore_app]="$RESTORE_APP_IMAGE_ID"
  [restore_runtime_verify]="$RESTORE_OPERATIONS_IMAGE_ID"
  [restore_evidence]="$RESTORE_OPERATIONS_IMAGE_ID"
  [rollback_rehearsal_app]="$legacy_image_id"
  [rollback_rehearsal_verify]="$RESTORE_OPERATIONS_IMAGE_ID"
)
for service_name in "${!expected_images[@]}"; do
  [[ "$(jq -r --arg service "$service_name" '.services[$service].image // empty' \
    <<<"$rendered_compose")" == "${expected_images[$service_name]}" ]] || {
    printf 'Legacy rehearsal service is not pinned to its captured image ID: %s\n' "$service_name" >&2
    exit 2
  }
done
[[ "$(jq -r '.services.restore_database.image // empty' <<<"$rendered_compose")" \
  == "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685" ]] || {
  printf '%s\n' "Legacy rehearsal database image is not digest-pinned" >&2
  exit 2
}

remove_rehearsal_services() {
  "${compose[@]}" rm --stop --force \
    restore_database restore_verify restore_migrate restore_runtime_grants \
    restore_auth_worker_grants restore_backup_grants restore_accounting_verify \
    restore_demo_bootstrap restore_key_verify restore_app restore_runtime_verify \
    restore_evidence rollback_rehearsal_app rollback_rehearsal_verify \
    >/dev/null 2>&1 || true
}
cleanup() {
  remove_rehearsal_services
  cleanup_rehearsal_workspace_only
}
trap cleanup EXIT INT TERM

remove_rehearsal_services
"${compose[@]}" up --detach --wait --no-deps --no-build --pull never restore_database
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_verify
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_migrate
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_runtime_grants
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_auth_worker_grants
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_backup_grants
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_accounting_verify
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_key_verify
"${compose[@]}" run --rm --no-deps --no-build --pull never restore_demo_bootstrap
"${compose[@]}" up --detach --wait --no-deps --no-build --pull never rollback_rehearsal_app
"${compose[@]}" run --rm --no-deps --no-build --pull never rollback_rehearsal_verify

printf '%s\n' "Hard-pinned f8485 image passed the degraded current-schema availability rehearsal"
