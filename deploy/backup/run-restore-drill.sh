#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

for command_name in awk basename cat chmod date docker find flock git grep jq mktemp openssl readlink rm sha256sum stat tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required restore-drill command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done

# A recovery drill must never inherit caller-selected Docker daemons, contexts,
# projects, or Compose files. The wrapper uses the local daemon and the two
# explicit repository/immutable-image files below.
for forbidden_container_control in DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE \
  COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR; do
  if [[ -n "${!forbidden_container_control+x}" ]]; then
    printf 'Unset ambient container-routing variable before recovery: %s\n' \
      "$forbidden_container_control" >&2
    exit 2
  fi
done

: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
[[ "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ \
  && ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]] || {
  printf '%s\n' "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full Git revision" >&2
  exit 2
}

RESTORE_RPO_SECONDS="${RESTORE_RPO_SECONDS:-21600}"
RESTORE_RTO_SECONDS="${RESTORE_RTO_SECONDS:-14400}"
RESTORE_REQUIRE_OFFSITE_EVIDENCE="${RESTORE_REQUIRE_OFFSITE_EVIDENCE:-true}"
RESTORE_ALLOW_EMPTY_SECRET_FIXTURES="${RESTORE_ALLOW_EMPTY_SECRET_FIXTURES:-false}"
[[ "$RESTORE_RPO_SECONDS" =~ ^[1-9][0-9]*$ \
  && ${#RESTORE_RPO_SECONDS} -le 5 ]] \
  && (( RESTORE_RPO_SECONDS <= 21600 )) || {
  printf '%s\n' "RESTORE_RPO_SECONDS must be positive and cannot exceed 21600" >&2
  exit 2
}
[[ "$RESTORE_RTO_SECONDS" =~ ^[1-9][0-9]*$ \
  && ${#RESTORE_RTO_SECONDS} -le 5 ]] \
  && (( RESTORE_RTO_SECONDS <= 14400 )) || {
  printf '%s\n' "RESTORE_RTO_SECONDS must be positive and cannot exceed 14400" >&2
  exit 2
}
[[ "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "true" || "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "false" ]] || {
  printf '%s\n' "RESTORE_REQUIRE_OFFSITE_EVIDENCE must be true or false" >&2
  exit 2
}
[[ "$RESTORE_ALLOW_EMPTY_SECRET_FIXTURES" == "true" \
  || "$RESTORE_ALLOW_EMPTY_SECRET_FIXTURES" == "false" ]] || {
  printf '%s\n' "RESTORE_ALLOW_EMPTY_SECRET_FIXTURES must be true or false" >&2
  exit 2
}
if [[ "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "true" ]]; then
  : "${BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE:?BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE is required for production recovery evidence}"
  : "${BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256:?BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256 is required for production recovery evidence}"
  [[ -f "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" \
    && ! -L "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" \
    && -r "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" ]] || {
    printf '%s\n' "Pinned receiver receipt public key is missing or unsafe" >&2
    exit 2
  }
  [[ "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" =~ ^[a-f0-9]{64}$ \
    && ! "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" =~ ^0+$ ]] || {
    printf '%s\n' "Pinned receiver receipt public-key fingerprint is invalid" >&2
    exit 2
  }
  openssl pkey -pubin -in "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" -pubcheck -noout >/dev/null 2>&1 \
    && openssl pkey -pubin -in "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" -text_pub -noout 2>/dev/null \
      | grep -Fqi 'ED25519' || {
    printf '%s\n' "Pinned receiver receipt public key is not valid Ed25519 material" >&2
    exit 2
  }
  [[ "$(sha256sum "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE" | awk '{print $1}')" \
    == "$BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256" ]] || {
    printf '%s\n' "Receiver receipt public key does not match its pinned fingerprint" >&2
    exit 2
  }
fi
export RESTORE_RPO_SECONDS RESTORE_RTO_SECONDS RESTORE_REQUIRE_OFFSITE_EVIDENCE
export RESTORE_ALLOW_EMPTY_SECRET_FIXTURES

BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-./.backups}"
[[ -d "$BACKUP_LOCAL_DIR" && ! -L "$BACKUP_LOCAL_DIR" ]] || {
  printf '%s\n' "BACKUP_LOCAL_DIR must be an existing non-symbolic-link directory" >&2
  exit 2
}
BACKUP_LOCAL_DIR="$(cd -- "$BACKUP_LOCAL_DIR" && pwd -P)"
[[ "$BACKUP_LOCAL_DIR" != "/" ]] || {
  printf '%s\n' "Refusing to use the filesystem root as BACKUP_LOCAL_DIR" >&2
  exit 2
}
export BACKUP_LOCAL_DIR

RESTORE_DRILL_LOCK_FILE="${RESTORE_DRILL_LOCK_FILE:-/var/lib/business-finlynq/restore-drill.lock}"
RESTORE_DRILL_LOCK_WAIT_SECONDS="${RESTORE_DRILL_LOCK_WAIT_SECONDS:-0}"
[[ "$RESTORE_DRILL_LOCK_FILE" == /* && "$RESTORE_DRILL_LOCK_FILE" != "/" ]] || {
  printf '%s\n' "RESTORE_DRILL_LOCK_FILE must be an absolute non-root path" >&2
  exit 2
}
[[ "$RESTORE_DRILL_LOCK_WAIT_SECONDS" =~ ^[0-9]+$ \
  && ${#RESTORE_DRILL_LOCK_WAIT_SECONDS} -le 4 ]] || {
  printf '%s\n' "RESTORE_DRILL_LOCK_WAIT_SECONDS must be 0 to 9999" >&2
  exit 2
}
restore_lock_directory="${RESTORE_DRILL_LOCK_FILE%/*}"
restore_lock_name="$(basename -- "$RESTORE_DRILL_LOCK_FILE")"
[[ -d "$restore_lock_directory" && ! -L "$restore_lock_directory" \
  && "$restore_lock_name" != "." && "$restore_lock_name" != ".." ]] || {
  printf '%s\n' "Restore-drill lock directory is missing, symbolic, or unsafe" >&2
  exit 2
}
restore_lock_directory="$(cd -- "$restore_lock_directory" && pwd -P)"
RESTORE_DRILL_LOCK_FILE="$restore_lock_directory/$restore_lock_name"
[[ ! -e "$RESTORE_DRILL_LOCK_FILE" \
  || ( -f "$RESTORE_DRILL_LOCK_FILE" && ! -L "$RESTORE_DRILL_LOCK_FILE" ) ]] || {
  printf '%s\n' "Restore-drill lock file is not a regular non-symbolic file" >&2
  exit 2
}
exec 8>>"$RESTORE_DRILL_LOCK_FILE"
chmod 0600 -- "$RESTORE_DRILL_LOCK_FILE"
flock --exclusive --wait "$RESTORE_DRILL_LOCK_WAIT_SECONDS" 8 || {
  printf '%s\n' "Another host restore drill holds the exclusive lock" >&2
  exit 75
}

# Never let a release, checkout, or editor change the Compose model after the
# reviewed revision has been selected. The live checkout is only a source of
# Git objects: every Compose file and relative bind source used below comes
# from this private archive of the exact reviewed commit.
repository_head="$(git -c safe.directory="$repository_root" -C "$repository_root" rev-parse --verify HEAD)" || {
  printf '%s\n' "Cannot resolve the recovery checkout HEAD" >&2
  exit 2
}
[[ "$repository_head" == "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]] || {
  printf '%s\n' "Recovery checkout HEAD does not match BUSINESS_FINLYNQ_IMAGE_REVISION" >&2
  exit 2
}
repository_status="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all)" || {
  printf '%s\n' "Cannot verify the recovery checkout state" >&2
  exit 2
}
[[ -z "$repository_status" ]] || {
  printf '%s\n' "Recovery checkout must be clean, including untracked files" >&2
  exit 2
}
unset repository_status

RESTORE_SOURCE_SNAPSHOT="$(mktemp -d "$restore_lock_directory/.restore-source.XXXXXX")"
[[ -d "$RESTORE_SOURCE_SNAPSHOT" && ! -L "$RESTORE_SOURCE_SNAPSHOT" ]] || {
  printf '%s\n' "Could not create a private recovery source snapshot" >&2
  exit 2
}
chmod 0700 -- "$RESTORE_SOURCE_SNAPSHOT"
RESTORE_IMAGE_OVERRIDE_FILE=""
cleanup_restore_workspace_only() {
  if [[ -n "$RESTORE_IMAGE_OVERRIDE_FILE" ]]; then
    rm -f -- "$RESTORE_IMAGE_OVERRIDE_FILE"
  fi
  case "$RESTORE_SOURCE_SNAPSHOT" in
    "$restore_lock_directory"/.restore-source.*)
      [[ ! -L "$RESTORE_SOURCE_SNAPSHOT" ]] && rm -rf -- "$RESTORE_SOURCE_SNAPSHOT"
      ;;
  esac
}
trap cleanup_restore_workspace_only EXIT INT TERM
git -c safe.directory="$repository_root" -C "$repository_root" \
  archive --format=tar "$BUSINESS_FINLYNQ_IMAGE_REVISION" \
  | tar --extract --file=- --directory "$RESTORE_SOURCE_SNAPSHOT" \
      --no-same-owner --same-permissions || {
    printf '%s\n' "Could not materialize the reviewed recovery source snapshot" >&2
    exit 2
  }
[[ -f "$RESTORE_SOURCE_SNAPSHOT/docker-compose.yml" \
  && ! -L "$RESTORE_SOURCE_SNAPSHOT/docker-compose.yml" ]] || {
  printf '%s\n' "Reviewed recovery snapshot has no safe Compose model" >&2
  exit 2
}

restore_base_compose() {
  docker compose \
    --project-directory "$RESTORE_SOURCE_SNAPSHOT" \
    --env-file /dev/null \
    --file "$RESTORE_SOURCE_SNAPSHOT/docker-compose.yml" \
    "$@"
}

# Recovery evidence is meaningful only when every application-owned drill
# service runs the already-reviewed commit image. Refuse a source rebuild or a
# mutable/mistagged local image before touching the disposable database.
rendered_compose="$(restore_base_compose --profile restore-drill config --format json)"
declare -A expected_restore_images=(
  [restore_verify]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_migrate]="business-finlynq-migrator:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_runtime_grants]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_auth_worker_grants]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_backup_grants]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_accounting_verify]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_demo_bootstrap]="business-finlynq-migrator:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_key_verify]="business-finlynq-migrator:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_app]="business-finlynq-app:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_runtime_verify]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
  [restore_evidence]="business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION"
)
for restore_service in "${!expected_restore_images[@]}"; do
  actual_restore_image="$(jq -r --arg service "$restore_service" '.services[$service].image // empty' <<<"$rendered_compose")"
  [[ "$actual_restore_image" == "${expected_restore_images[$restore_service]}" ]] || {
    printf 'Restore service %s is not bound to the reviewed commit image\n' "$restore_service" >&2
    exit 2
  }
done
[[ "$(jq -r '.services.restore_database.image // empty' <<<"$rendered_compose")" \
  == "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685" ]] || {
  printf '%s\n' "Restore database image is not digest-pinned" >&2
  exit 2
}
unset rendered_compose

verify_recovery_image() {
  local reference="$1"
  local image_id image_revision
  image_id="$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null)" || {
    printf 'Reviewed recovery image is unavailable locally: %s\n' "$reference" >&2
    exit 2
  }
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]] || {
    printf 'Recovery image identity does not match the reviewed revision: %s\n' "$reference" >&2
    exit 2
  }
  printf '%s' "$image_id"
}

RESTORE_APP_IMAGE_ID="$(verify_recovery_image "business-finlynq-app:$BUSINESS_FINLYNQ_IMAGE_REVISION")"
RESTORE_MIGRATOR_IMAGE_ID="$(verify_recovery_image "business-finlynq-migrator:$BUSINESS_FINLYNQ_IMAGE_REVISION")"
RESTORE_OPERATIONS_IMAGE_ID="$(verify_recovery_image "business-finlynq-operations:$BUSINESS_FINLYNQ_IMAGE_REVISION")"
export RESTORE_APP_IMAGE_ID RESTORE_MIGRATOR_IMAGE_ID RESTORE_OPERATIONS_IMAGE_ID

RESTORE_IMAGE_OVERRIDE_FILE="$(mktemp "$restore_lock_directory/.restore-images.XXXXXX.yml")"
chmod 0600 -- "$RESTORE_IMAGE_OVERRIDE_FILE"
cat >"$RESTORE_IMAGE_OVERRIDE_FILE" <<'YAML'
services:
  restore_verify:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_migrate:
    image: ${RESTORE_MIGRATOR_IMAGE_ID:?set RESTORE_MIGRATOR_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_runtime_grants:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_auth_worker_grants:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_backup_grants:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_accounting_verify:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_demo_bootstrap:
    image: ${RESTORE_MIGRATOR_IMAGE_ID:?set RESTORE_MIGRATOR_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_key_verify:
    image: ${RESTORE_MIGRATOR_IMAGE_ID:?set RESTORE_MIGRATOR_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_app:
    image: ${RESTORE_APP_IMAGE_ID:?set RESTORE_APP_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_runtime_verify:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
  restore_evidence:
    image: ${RESTORE_OPERATIONS_IMAGE_ID:?set RESTORE_OPERATIONS_IMAGE_ID}
    pull_policy: never
    build: !reset null
YAML

restore_compose() {
  docker compose \
    --project-directory "$RESTORE_SOURCE_SNAPSHOT" \
    --env-file /dev/null \
    --file "$RESTORE_SOURCE_SNAPSHOT/docker-compose.yml" \
    --file "$RESTORE_IMAGE_OVERRIDE_FILE" \
    "$@"
}

pinned_restore_compose="$(restore_compose --profile restore-drill config --format json)"
declare -A pinned_restore_images=(
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
)
for restore_service in "${!pinned_restore_images[@]}"; do
  [[ "$(jq -r --arg service "$restore_service" '.services[$service].image // empty' \
    <<<"$pinned_restore_compose")" == "${pinned_restore_images[$restore_service]}" ]] || {
    printf 'Immutable restore override did not pin service %s\n' "$restore_service" >&2
    rm -f -- "$RESTORE_IMAGE_OVERRIDE_FILE"
    exit 2
  }
done
unset pinned_restore_compose

if [[ -n "${RESTORE_BACKUP_MANIFEST:-}" ]]; then
  [[ "$RESTORE_BACKUP_MANIFEST" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\.manifest\.json$ ]] || {
    printf '%s\n' "RESTORE_BACKUP_MANIFEST must be one safe Business Finlynq manifest name" >&2
    exit 2
  }
else
  RESTORE_BACKUP_MANIFEST=""
  while IFS= read -r -d '' candidate; do
    candidate_name="$(basename -- "$candidate")"
    [[ "$candidate_name" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\.manifest\.json$ ]] || continue
    if [[ -z "$RESTORE_BACKUP_MANIFEST" || "$candidate_name" > "$RESTORE_BACKUP_MANIFEST" ]]; then
      RESTORE_BACKUP_MANIFEST="$candidate_name"
    fi
  done < <(find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'business_finlynq_*.manifest.json' -print0)
fi
[[ -n "$RESTORE_BACKUP_MANIFEST" ]] || {
  printf '%s\n' "No completed backup manifest is available for the restore drill" >&2
  exit 2
}
selected_manifest="$BACKUP_LOCAL_DIR/$RESTORE_BACKUP_MANIFEST"
[[ -f "$selected_manifest" && ! -L "$selected_manifest" ]] || {
  printf '%s\n' "Selected restore manifest is missing or is a symbolic link" >&2
  exit 2
}
selected_manifest="$(readlink -f -- "$selected_manifest")"
case "$selected_manifest" in
  "$BACKUP_LOCAL_DIR"/*) ;;
  *) printf '%s\n' "Selected restore manifest resolves outside BACKUP_LOCAL_DIR" >&2; exit 2 ;;
esac
RESTORE_SELECTED_SHA256="$(jq -r '.sha256 // empty' "$selected_manifest")"
[[ "$RESTORE_SELECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  printf '%s\n' "Selected restore manifest has an invalid SHA-256" >&2
  exit 2
}
RESTORE_SELECTED_ARCHIVE="$(jq -r '.encryptedArchive // empty' "$selected_manifest")"
[[ "$RESTORE_SELECTED_ARCHIVE" =~ ^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$ ]] || {
  printf '%s\n' "Selected restore manifest has an unsafe archive name" >&2
  exit 2
}

readonly restore_container_gid="70"
restore_operator_uid="$(stat -c '%u' "$BACKUP_LOCAL_DIR")"
[[ "$(stat -c '%g:%a' "$BACKUP_LOCAL_DIR")" == "$restore_container_gid:750" ]] || {
  printf '%s\n' "Recovery staging directory must be group 70 and mode 0750" >&2
  exit 2
}
restore_reports_directory="$BACKUP_LOCAL_DIR/restore-reports"
[[ -d "$restore_reports_directory" && ! -L "$restore_reports_directory" \
  && "$(stat -c '%u:%g:%a' "$restore_reports_directory")" \
    == "$restore_operator_uid:$restore_container_gid:770" ]] || {
  printf '%s\n' "Restore reports directory must be pre-created for operator ownership and UID/GID 70 group-write access" >&2
  exit 2
}
restore_prefix="${RESTORE_BACKUP_MANIFEST%.manifest.json}"
[[ "$RESTORE_SELECTED_ARCHIVE" == "$restore_prefix.dump.age" ]] || {
  printf '%s\n' "Selected restore archive does not match the manifest prefix" >&2
  exit 2
}
restore_artifacts=(
  "$selected_manifest"
  "$BACKUP_LOCAL_DIR/$restore_prefix.dump.age"
  "$BACKUP_LOCAL_DIR/$restore_prefix.sha256"
)
if [[ "$RESTORE_REQUIRE_OFFSITE_EVIDENCE" == "true" ]]; then
  restore_artifacts+=(
    "$BACKUP_LOCAL_DIR/$restore_prefix.receiver-receipt.json"
    "$BACKUP_LOCAL_DIR/$restore_prefix.receiver-receipt.json.sig"
  )
fi
for restore_artifact in "${restore_artifacts[@]}"; do
  [[ -f "$restore_artifact" && ! -L "$restore_artifact" \
    && "$(stat -c '%u:%g:%a:%h' "$restore_artifact")" \
      == "$restore_operator_uid:$restore_container_gid:440:1" ]] || {
    printf 'Recovery artifact is not a single-link operator-owned, group-70-readable mode-0440 file: %s\n' \
      "$restore_artifact" >&2
    exit 2
  }
  resolved_restore_artifact="$(readlink -f -- "$restore_artifact")"
  case "$resolved_restore_artifact" in
    "$BACKUP_LOCAL_DIR"/*) ;;
    *) printf '%s\n' "Recovery artifact resolves outside the staging directory" >&2; exit 2 ;;
  esac
done

RESTORE_DRILL_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_compact="${RESTORE_DRILL_STARTED_AT//-/}"
started_compact="${started_compact//:/}"
RESTORE_EVIDENCE_ID="${started_compact}_${RESTORE_SELECTED_SHA256:0:12}"
RESTORE_EVIDENCE_DIR="/backups/restore-reports"
export RESTORE_BACKUP_MANIFEST RESTORE_DRILL_STARTED_AT RESTORE_EVIDENCE_ID \
  RESTORE_EVIDENCE_DIR RESTORE_SELECTED_ARCHIVE RESTORE_SELECTED_SHA256

remove_restore_services() {
  restore_compose --profile restore-drill rm --stop --force \
    restore_database restore_verify restore_migrate restore_runtime_grants \
    restore_auth_worker_grants restore_backup_grants restore_accounting_verify \
    restore_demo_bootstrap \
    restore_key_verify restore_app \
    restore_runtime_verify restore_evidence >/dev/null 2>&1 || true
}
cleanup() {
  remove_restore_services
  cleanup_restore_workspace_only
}
trap cleanup EXIT INT TERM

# These services contain only a disposable, tmpfs-backed drill database. The
# production database and application services are never stopped or removed.
remove_restore_services
restore_compose --profile restore-drill up --detach --wait --no-deps --no-build restore_database
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_verify
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_migrate
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_runtime_grants
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_auth_worker_grants
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_backup_grants
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_accounting_verify
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_key_verify
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_demo_bootstrap
restore_compose --profile restore-drill up --detach --wait --no-deps --no-build restore_app
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_runtime_verify
RESTORE_DRILL_COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export RESTORE_DRILL_COMPLETED_AT
restore_compose --profile restore-drill run --rm --no-deps --no-build restore_evidence

printf '%s\n' "Restore drill, key recovery, migrations, all role reconciliations, audit/outbox integrity, runtime acceptance, and recovery-objective evidence completed successfully"
