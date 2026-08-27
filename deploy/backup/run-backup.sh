#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

for command_name in age flock jq pg_dump rclone sha256sum; do
  require_command "$command_name"
done

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${BACKUP_DATABASE_PASSWORD_FILE:?BACKUP_DATABASE_PASSWORD_FILE is required}"
: "${BACKUP_AGE_RECIPIENT_FILE:?BACKUP_AGE_RECIPIENT_FILE is required}"
: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"

PGPORT="${PGPORT:-5432}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/backups}"
BACKUP_LOCAL_RETENTION_DAYS="${BACKUP_LOCAL_RETENTION_DAYS:-14}"
BACKUP_REQUIRE_OFFSITE="${BACKUP_REQUIRE_OFFSITE:-false}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_RCLONE_CONFIG_FILE="${BACKUP_RCLONE_CONFIG_FILE:-/run/secrets/business_finlynq_rclone_config}"
BACKUP_IMAGE_REVISION="$BUSINESS_FINLYNQ_IMAGE_REVISION"

[[ "$PGPORT" =~ ^[0-9]+$ ]] || fail "PGPORT must be numeric"
[[ "$BACKUP_LOCAL_RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_LOCAL_RETENTION_DAYS must be a non-negative integer"
[[ "$BACKUP_REQUIRE_OFFSITE" == "true" || "$BACKUP_REQUIRE_OFFSITE" == "false" ]] || fail "BACKUP_REQUIRE_OFFSITE must be true or false"
[[ "$BACKUP_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$BACKUP_IMAGE_REVISION" =~ ^0+$ ]] || fail "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full Git revision"

[[ -s "$BACKUP_DATABASE_PASSWORD_FILE" ]] || fail "Backup database password file is missing or empty"
[[ -s "$BACKUP_AGE_RECIPIENT_FILE" ]] || fail "Age recipient file is missing or empty"

if [[ "$BACKUP_REQUIRE_OFFSITE" == "true" && -z "$BACKUP_RCLONE_REMOTE" ]]; then
  fail "Off-site backup is required but BACKUP_RCLONE_REMOTE is empty"
fi
if [[ -n "$BACKUP_RCLONE_REMOTE" && ! -s "$BACKUP_RCLONE_CONFIG_FILE" ]]; then
  fail "An rclone remote is configured but its config file is missing or empty"
fi

mkdir -p -- "$BACKUP_OUTPUT_DIR"
BACKUP_OUTPUT_DIR="$(cd -- "$BACKUP_OUTPUT_DIR" && pwd -P)"
[[ "$BACKUP_OUTPUT_DIR" != "/" ]] || fail "Refusing to use the filesystem root as a backup directory"

exec 9>"$BACKUP_OUTPUT_DIR/.backup.lock"
flock -n 9 || fail "Another backup process already holds the backup lock"

IFS= read -r PGPASSWORD < "$BACKUP_DATABASE_PASSWORD_FILE" || true
[[ -n "${PGPASSWORD:-}" ]] || fail "Backup database password file does not contain a password"
[[ "$PGPASSWORD" != *$'\n'* && "$PGPASSWORD" != *$'\r'* ]] || fail "Backup database password must be one line"
export PGPASSWORD

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
safe_database="${PGDATABASE//[^A-Za-z0-9_.-]/_}"
prefix="business_finlynq_${timestamp}_${safe_database}"
archive_name="${prefix}.dump.age"
manifest_name="${prefix}.manifest.json"
checksum_name="${prefix}.sha256"
uploaded_name="${prefix}.uploaded"
archive_path="$BACKUP_OUTPUT_DIR/$archive_name"
manifest_path="$BACKUP_OUTPUT_DIR/$manifest_name"
checksum_path="$BACKUP_OUTPUT_DIR/$checksum_name"
uploaded_path="$BACKUP_OUTPUT_DIR/$uploaded_name"
partial_archive="$BACKUP_OUTPUT_DIR/.${archive_name}.partial.$$"
partial_manifest="$BACKUP_OUTPUT_DIR/.${manifest_name}.partial.$$"
partial_checksum="$BACKUP_OUTPUT_DIR/.${checksum_name}.partial.$$"

cleanup() {
  unset PGPASSWORD
  rm -f -- "$partial_archive" "$partial_manifest" "$partial_checksum"
}
trap cleanup EXIT INT TERM

for target in "$archive_path" "$manifest_path" "$checksum_path" "$uploaded_path"; do
  [[ ! -e "$target" ]] || fail "Refusing to overwrite an existing backup artifact: $(basename -- "$target")"
done

log "Creating a consistent encrypted PostgreSQL backup"
pg_dump \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$PGUSER" \
  --dbname "$PGDATABASE" \
  --format=custom \
  --compress=zstd:9 \
  --lock-wait-timeout=30s \
  --no-password \
  | age --recipients-file "$BACKUP_AGE_RECIPIENT_FILE" --output "$partial_archive"

[[ -s "$partial_archive" ]] || fail "Encrypted backup output is empty"
archive_sha256="$(sha256sum "$partial_archive" | awk '{print $1}')"
archive_bytes="$(wc -c < "$partial_archive" | tr -d '[:space:]')"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pg_dump_version="$(pg_dump --version)"

jq -n \
  --arg createdAt "$created_at" \
  --arg database "$PGDATABASE" \
  --arg host "$PGHOST" \
  --arg archive "$archive_name" \
  --arg sha256 "$archive_sha256" \
  --arg revision "$BACKUP_IMAGE_REVISION" \
  --arg pgDumpVersion "$pg_dump_version" \
  --argjson bytes "$archive_bytes" \
  --argjson localRetentionDays "$BACKUP_LOCAL_RETENTION_DAYS" \
  '{
    schemaVersion: 1,
    product: "business-finlynq",
    createdAt: $createdAt,
    database: $database,
    sourceHost: $host,
    applicationRevision: $revision,
    format: "postgres-custom",
    compression: "zstd:9",
    encryption: "age",
    pgDumpVersion: $pgDumpVersion,
    encryptedArchive: $archive,
    encryptedBytes: $bytes,
    sha256: $sha256,
    localRetentionDays: $localRetentionDays
  }' > "$partial_manifest"

printf '%s  %s\n' "$archive_sha256" "$archive_name" > "$partial_checksum"
mv -- "$partial_archive" "$archive_path"
mv -- "$partial_checksum" "$checksum_path"
mv -- "$partial_manifest" "$manifest_path"

if [[ -n "$BACKUP_RCLONE_REMOTE" ]]; then
  remote_root="${BACKUP_RCLONE_REMOTE%/}"
  log "Uploading the encrypted archive and checksum to the configured off-site remote"
  rclone --config "$BACKUP_RCLONE_CONFIG_FILE" copyto "$archive_path" "$remote_root/$archive_name" --immutable
  rclone --config "$BACKUP_RCLONE_CONFIG_FILE" copyto "$checksum_path" "$remote_root/$checksum_name" --immutable
  remote_sha256="$(rclone --config "$BACKUP_RCLONE_CONFIG_FILE" cat "$remote_root/$archive_name" | sha256sum | awk '{print $1}')"
  [[ "$remote_sha256" == "$archive_sha256" ]] || fail "Off-site archive checksum does not match the local encrypted archive"
  # The manifest is uploaded last and therefore acts as the completed-set marker.
  rclone --config "$BACKUP_RCLONE_CONFIG_FILE" copyto "$manifest_path" "$remote_root/$manifest_name" --immutable
  printf '%s remote=%s\n' "$created_at" "$remote_root" > "$uploaded_path"
  log "Off-site checksum verification completed"
else
  log "No off-site remote configured; the backup remains local only"
fi

prune_before_days="$BACKUP_LOCAL_RETENTION_DAYS"
while IFS= read -r -d '' old_manifest; do
  old_archive_name="$(jq -r '.encryptedArchive // empty' "$old_manifest")"
  [[ "$old_archive_name" =~ ^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$ ]] || {
    log "Skipping retention for a manifest with an unexpected archive name: $(basename -- "$old_manifest")"
    continue
  }
  old_prefix="${old_archive_name%.dump.age}"
  old_archive="$BACKUP_OUTPUT_DIR/$old_archive_name"
  old_checksum="$BACKUP_OUTPUT_DIR/${old_prefix}.sha256"
  old_uploaded="$BACKUP_OUTPUT_DIR/${old_prefix}.uploaded"
  if [[ -n "$BACKUP_RCLONE_REMOTE" && ! -f "$old_uploaded" ]]; then
    log "Keeping an old local backup because no successful off-site marker exists: $old_archive_name"
    continue
  fi
  log "Pruning an expired local backup set: $old_prefix"
  rm -f -- "$old_archive" "$old_checksum" "$old_uploaded" "$old_manifest"
done < <(find "$BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'business_finlynq_*.manifest.json' -mtime "+$prune_before_days" -print0)

log "Backup complete: $archive_name sha256=$archive_sha256 bytes=$archive_bytes"
