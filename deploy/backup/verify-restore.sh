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

for command_name in age jq pg_restore psql sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${RESTORE_DATABASE_PASSWORD_FILE:?RESTORE_DATABASE_PASSWORD_FILE is required}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"

PGPORT="${PGPORT:-5432}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/backups}"
RESTORE_CONFIRM_DISPOSABLE="${RESTORE_CONFIRM_DISPOSABLE:-}"
RESTORE_ALLOWED_HOST="${RESTORE_ALLOWED_HOST:-restore_database}"
RESTORE_REPORT_DIR="${RESTORE_REPORT_DIR:-$BACKUP_OUTPUT_DIR/restore-reports}"

[[ "$RESTORE_CONFIRM_DISPOSABLE" == "business-finlynq-restore-drill" ]] || fail "Restore confirmation phrase is missing"
[[ "$PGHOST" == "$RESTORE_ALLOWED_HOST" ]] || fail "Restore target host is not the explicitly allowed disposable host"
[[ "$PGDATABASE" =~ ^business_finlynq_restore_drill(_[a-z0-9_]+)?$ ]] || fail "Restore target database name is not a restore-drill name"
[[ "$PGPORT" =~ ^[0-9]+$ ]] || fail "PGPORT must be numeric"
[[ -s "$RESTORE_DATABASE_PASSWORD_FILE" ]] || fail "Restore database password file is missing or empty"
[[ -s "$BACKUP_AGE_IDENTITY_FILE" ]] || fail "Age identity file is missing or empty"

BACKUP_OUTPUT_DIR="$(cd -- "$BACKUP_OUTPUT_DIR" && pwd -P)"
[[ "$BACKUP_OUTPUT_DIR" != "/" ]] || fail "Refusing to use the filesystem root as the backup directory"
mkdir -p -- "$RESTORE_REPORT_DIR"
RESTORE_REPORT_DIR="$(cd -- "$RESTORE_REPORT_DIR" && pwd -P)"

if [[ -n "${BACKUP_MANIFEST:-}" ]]; then
  if [[ "$BACKUP_MANIFEST" = /* ]]; then
    manifest_path="$BACKUP_MANIFEST"
  else
    manifest_path="$BACKUP_OUTPUT_DIR/$BACKUP_MANIFEST"
  fi
else
  manifest_path=""
  while IFS= read -r -d '' candidate; do
    if [[ -z "$manifest_path" || "$candidate" -nt "$manifest_path" ]]; then
      manifest_path="$candidate"
    fi
  done < <(find "$BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'business_finlynq_*.manifest.json' -print0)
fi

[[ -n "${manifest_path:-}" && -f "$manifest_path" ]] || fail "No backup manifest was selected"
manifest_path="$(readlink -f -- "$manifest_path")"
case "$manifest_path" in
  "$BACKUP_OUTPUT_DIR"/*) ;;
  *) fail "Backup manifest resolves outside the configured backup directory" ;;
esac

[[ "$(jq -r '.schemaVersion // empty' "$manifest_path")" == "1" ]] || fail "Unsupported or invalid backup manifest"
[[ "$(jq -r '.product // empty' "$manifest_path")" == "business-finlynq" ]] || fail "Manifest belongs to a different product"
archive_name="$(jq -r '.encryptedArchive // empty' "$manifest_path")"
expected_sha256="$(jq -r '.sha256 // empty' "$manifest_path")"
[[ "$archive_name" =~ ^business_finlynq_[A-Za-z0-9_.-]+\.dump\.age$ ]] || fail "Manifest archive name is unsafe"
[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]] || fail "Manifest checksum is invalid"
archive_path="$BACKUP_OUTPUT_DIR/$archive_name"
[[ -f "$archive_path" ]] || fail "Encrypted archive referenced by the manifest is missing"
archive_path="$(readlink -f -- "$archive_path")"
case "$archive_path" in
  "$BACKUP_OUTPUT_DIR"/*) ;;
  *) fail "Encrypted archive resolves outside the configured backup directory" ;;
esac

actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "Encrypted archive checksum does not match its manifest"

plain_archive="/tmp/business-finlynq-restore-$$.dump"
cleanup() {
  unset PGPASSWORD
  rm -f -- "$plain_archive"
}
trap cleanup EXIT INT TERM

log "Decrypting the selected archive into the container's temporary filesystem"
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$plain_archive" "$archive_path"
[[ -s "$plain_archive" ]] || fail "Decrypted PostgreSQL archive is empty"
pg_restore --list "$plain_archive" >/dev/null

IFS= read -r PGPASSWORD < "$RESTORE_DATABASE_PASSWORD_FILE" || true
[[ -n "${PGPASSWORD:-}" ]] || fail "Restore database password file does not contain a password"
[[ "$PGPASSWORD" != *$'\n'* && "$PGPASSWORD" != *$'\r'* ]] || fail "Restore database password must be one line"
export PGPASSWORD

existing_user_tables="$(psql --no-password --tuples-only --no-align --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema');")"
[[ "$existing_user_tables" == "0" ]] || fail "Disposable restore target is not empty"

log "Restoring into the isolated disposable database"
pg_restore \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$PGUSER" \
  --dbname "$PGDATABASE" \
  --no-password \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$plain_archive"

table_count="$(psql --no-password --tuples-only --no-align --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema');")"
[[ "$table_count" =~ ^[1-9][0-9]*$ ]] || fail "Restored database contains no application tables"
organizations_table="$(psql --no-password --tuples-only --no-align --command "SELECT to_regclass('public.organizations') IS NOT NULL;")"
[[ "$organizations_table" == "t" ]] || fail "Restored database is missing the organizations table"
migration_count="$(psql --no-password --tuples-only --no-align --command "SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 0 ELSE (SELECT count(*) FROM drizzle.__drizzle_migrations) END;")"
[[ "$migration_count" =~ ^[1-9][0-9]*$ ]] || fail "Restored database has no migration history"

verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report_name="restore_${verified_at//[:\-]/}_${expected_sha256:0:12}.json"
report_path="$RESTORE_REPORT_DIR/$report_name"
partial_report="$RESTORE_REPORT_DIR/.${report_name}.partial.$$"
jq -n \
  --arg verifiedAt "$verified_at" \
  --arg archive "$archive_name" \
  --arg sha256 "$expected_sha256" \
  --argjson tableCount "$table_count" \
  --argjson migrationCount "$migration_count" \
  '{
    schemaVersion: 1,
    product: "business-finlynq",
    result: "restored-and-verified",
    verifiedAt: $verifiedAt,
    encryptedArchive: $archive,
    sha256: $sha256,
    applicationTableCount: $tableCount,
    migrationCount: $migrationCount
  }' > "$partial_report"
mv -- "$partial_report" "$report_path"

log "Restore verification passed: tables=$table_count migrations=$migration_count report=$report_name"
