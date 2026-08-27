#!/bin/sh
set -eu

umask 077

fail() {
  echo "Restore migration refused: $*" >&2
  exit 1
}

: "${BUSINESS_FINLYNQ_MIGRATION_DB_HOST:?BUSINESS_FINLYNQ_MIGRATION_DB_HOST is required}"
: "${BUSINESS_FINLYNQ_MIGRATION_DB_NAME:?BUSINESS_FINLYNQ_MIGRATION_DB_NAME is required}"
: "${BUSINESS_FINLYNQ_MIGRATION_DB_USER:?BUSINESS_FINLYNQ_MIGRATION_DB_USER is required}"
: "${RESTORE_DATABASE_PASSWORD_FILE:?RESTORE_DATABASE_PASSWORD_FILE is required}"

[ "${RESTORE_CONFIRM_DISPOSABLE:-}" = "business-finlynq-restore-drill" ] || fail "confirmation phrase is missing"
[ "$BUSINESS_FINLYNQ_MIGRATION_DB_HOST" = "restore_database" ] || fail "target host is not the isolated restore database"
[ "$BUSINESS_FINLYNQ_MIGRATION_DB_NAME" = "business_finlynq_restore_drill" ] || fail "target database is not the fixed restore-drill database"
[ "$BUSINESS_FINLYNQ_MIGRATION_DB_USER" = "restore_drill_owner" ] || fail "target user is not the restore-drill owner"
[ -r "$RESTORE_DATABASE_PASSWORD_FILE" ] || fail "database password file is not readable"

password_line_count="$(awk 'END { print NR }' "$RESTORE_DATABASE_PASSWORD_FILE")"
[ "$password_line_count" -eq 1 ] || fail "database password file must contain exactly one line"
BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD=""
IFS= read -r BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD < "$RESTORE_DATABASE_PASSWORD_FILE" || [ -n "$BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD" ]
carriage_return="$(printf '\r')"
case "$BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD" in
  *'
'*|*"$carriage_return"*) fail "database password must be a single line" ;;
esac
password_length=${#BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD}
[ "$password_length" -ge 24 ] && [ "$password_length" -le 1024 ] || fail "database password must contain 24 to 1024 characters"

export BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD
trap 'unset BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD' EXIT HUP INT TERM
exec npm run db:migrate
