#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Backup verification failed: %s\n' "$1" >&2
  exit 1
}

for command_name in awk basename date find flock jq readlink sha256sum stat tr wc; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/backups}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-8}"
BACKUP_MAX_ACTIVE_SECONDS="${BACKUP_MAX_ACTIVE_SECONDS:-7200}"
BACKUP_REQUIRE_OFFSITE_MARKER="${BACKUP_REQUIRE_OFFSITE_MARKER:-true}"

[[ "$BACKUP_MAX_AGE_HOURS" =~ ^[0-9]+$ ]] \
  || fail "BACKUP_MAX_AGE_HOURS must be a non-negative integer"
[[ "$BACKUP_MAX_ACTIVE_SECONDS" =~ ^[0-9]+$ ]] \
  || fail "BACKUP_MAX_ACTIVE_SECONDS must be a non-negative integer"
[[ "$BACKUP_REQUIRE_OFFSITE_MARKER" == "true" || "$BACKUP_REQUIRE_OFFSITE_MARKER" == "false" ]] \
  || fail "BACKUP_REQUIRE_OFFSITE_MARKER must be true or false"

[[ -d "$BACKUP_OUTPUT_DIR" ]] || fail "backup directory is missing"
BACKUP_OUTPUT_DIR="$(cd -- "$BACKUP_OUTPUT_DIR" && pwd -P)"
[[ "$BACKUP_OUTPUT_DIR" != "/" ]] || fail "refusing to inspect the filesystem root"

backup_lock="$BACKUP_OUTPUT_DIR/.backup.lock"
[[ -f "$backup_lock" && ! -L "$backup_lock" ]] \
  || fail "backup lock is missing or is not a regular file"
exec 9<"$backup_lock"
if ! flock --shared --nonblock 9; then
  current_epoch="$(date +%s)"
  lock_epoch="$(stat -c '%Y' -- "$backup_lock")"
  [[ "$lock_epoch" =~ ^[0-9]+$ && "$lock_epoch" -le "$current_epoch" ]] \
    || fail "active backup lock has an invalid modification time"
  active_seconds=$((current_epoch - lock_epoch))
  (( active_seconds <= BACKUP_MAX_ACTIVE_SECONDS )) \
    || fail "backup has held its lock longer than the allowed active window"
  printf '%s\n' "Backup verification deferred while an encrypted backup is active"
  exit 75
fi
latest_manifest=""
latest_manifest_name=""
while IFS= read -r -d '' candidate; do
  candidate_name="$(basename -- "$candidate")"
  [[ "$candidate_name" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\.manifest\.json$ ]] \
    || continue
  if [[ -z "$latest_manifest_name" || "$candidate_name" > "$latest_manifest_name" ]]; then
    latest_manifest="$candidate"
    latest_manifest_name="$candidate_name"
  fi
done < <(find "$BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'business_finlynq_*.manifest.json' -print0)

[[ -n "$latest_manifest" && -f "$latest_manifest" && ! -L "$latest_manifest" ]] \
  || fail "no completed backup manifest exists"
latest_manifest="$(readlink -f -- "$latest_manifest")"
case "$latest_manifest" in
  "$BACKUP_OUTPUT_DIR"/*) ;;
  *) fail "backup manifest resolves outside the backup directory" ;;
esac

manifest_name="$(basename -- "$latest_manifest")"
[[ "$manifest_name" =~ ^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\.manifest\.json$ ]] \
  || fail "newest backup manifest has an unexpected name"
backup_prefix="${manifest_name%.manifest.json}"
filename_payload="${backup_prefix#business_finlynq_}"
filename_timestamp="${filename_payload%%_*}"
archive_name="${backup_prefix}.dump.age"
checksum_name="${backup_prefix}.sha256"
uploaded_name="${backup_prefix}.uploaded"

schema_version="$(jq -r '.schemaVersion // empty' "$latest_manifest")"
product="$(jq -r '.product // empty' "$latest_manifest")"
manifest_archive="$(jq -r '.encryptedArchive // empty' "$latest_manifest")"
manifest_sha256="$(jq -r '.sha256 // empty' "$latest_manifest")"
manifest_bytes="$(jq -r '.encryptedBytes // empty' "$latest_manifest")"
manifest_created_at="$(jq -r '.createdAt // empty' "$latest_manifest")"
manifest_revision="$(jq -r '.applicationRevision // empty' "$latest_manifest")"

[[ "$schema_version" == "1" && "$product" == "business-finlynq" ]] \
  || fail "newest backup manifest has an invalid schema or product"
[[ "$manifest_archive" == "$archive_name" ]] \
  || fail "newest backup manifest references an unexpected archive"
[[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || fail "newest backup manifest has an invalid SHA-256"
[[ "$manifest_bytes" =~ ^[1-9][0-9]*$ ]] \
  || fail "newest backup manifest has an invalid encrypted byte count"
[[ "$manifest_created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "newest backup manifest has an invalid creation timestamp"
compact_created_at="${manifest_created_at//-/}"
compact_created_at="${compact_created_at//:/}"
[[ "$compact_created_at" == "$filename_timestamp" ]] \
  || fail "newest backup creation timestamp does not match its filename"
[[ "$manifest_revision" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$manifest_revision" =~ ^0+$ ]] \
  || fail "newest backup manifest has an invalid application revision"

current_epoch="$(date +%s)"
created_epoch=""
created_epoch="$(date -u --date="$manifest_created_at" +%s 2>/dev/null)" \
  || fail "newest backup creation timestamp is not a real UTC date"
[[ "$created_epoch" =~ ^[0-9]+$ && "$created_epoch" -le "$current_epoch" ]] \
  || fail "newest backup creation timestamp is in the future"
age_seconds=$((current_epoch - created_epoch))
(( age_seconds <= BACKUP_MAX_AGE_HOURS * 3600 )) \
  || fail "newest backup exceeds the maximum allowed age"

archive_path="$BACKUP_OUTPUT_DIR/$archive_name"
checksum_path="$BACKUP_OUTPUT_DIR/$checksum_name"
uploaded_path="$BACKUP_OUTPUT_DIR/$uploaded_name"
for artifact in "$archive_path" "$checksum_path"; do
  [[ -f "$artifact" && ! -L "$artifact" && -s "$artifact" ]] \
    || fail "newest backup set is incomplete or contains a symbolic link"
  resolved_artifact="$(readlink -f -- "$artifact")"
  case "$resolved_artifact" in
    "$BACKUP_OUTPUT_DIR"/*) ;;
    *) fail "backup artifact resolves outside the backup directory" ;;
  esac
done

checksum_lines="$(wc -l <"$checksum_path" | tr -d '[:space:]')"
checksum_record="$(<"$checksum_path")"
[[ "$checksum_lines" == "1" && "$checksum_record" == "$manifest_sha256  $archive_name" ]] \
  || fail "newest backup checksum file is invalid or inconsistent"
actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$manifest_sha256" ]] \
  || fail "newest encrypted backup checksum does not match"
actual_bytes="$(stat -c '%s' -- "$archive_path")"
[[ "$actual_bytes" == "$manifest_bytes" ]] \
  || fail "newest encrypted backup size does not match its manifest"

if [[ "$BACKUP_REQUIRE_OFFSITE_MARKER" == "true" ]]; then
  [[ -f "$uploaded_path" && ! -L "$uploaded_path" && -s "$uploaded_path" ]] \
    || fail "newest backup has no verified off-site upload marker"
  uploaded_record="$(<"$uploaded_path")"
  [[ "$uploaded_record" == "$manifest_created_at remote="* \
    && "$uploaded_record" != "$manifest_created_at remote=" ]] \
    || fail "newest backup off-site upload marker is invalid"
fi

printf '%s\n' "Business Finlynq encrypted backup verification passed"
