#!/bin/sh
set -eu

umask 077

fail() {
  echo "Restore role reconciliation refused: $*" >&2
  exit 1
}

: "${PGHOST:?PGHOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${RESTORE_DATABASE_PASSWORD_FILE:?RESTORE_DATABASE_PASSWORD_FILE is required}"
: "${RESTORE_RECONCILIATION_TARGET:?RESTORE_RECONCILIATION_TARGET is required}"

[ "${RESTORE_CONFIRM_DISPOSABLE:-}" = "business-finlynq-restore-drill" ] || fail "confirmation phrase is missing"
[ "$PGHOST" = "restore_database" ] || fail "target host is not the isolated restore database"
[ "$POSTGRES_DB" = "business_finlynq_restore_drill" ] || fail "target database is not the fixed restore-drill database"
[ "$POSTGRES_USER" = "restore_drill_owner" ] || fail "target user is not the restore-drill owner"
[ -r "$RESTORE_DATABASE_PASSWORD_FILE" ] || fail "database password file is not readable"

password_line_count="$(awk 'END { print NR }' "$RESTORE_DATABASE_PASSWORD_FILE")"
[ "$password_line_count" -eq 1 ] || fail "database password file must contain exactly one line"
PGPASSWORD=""
IFS= read -r PGPASSWORD < "$RESTORE_DATABASE_PASSWORD_FILE" || [ -n "$PGPASSWORD" ]
carriage_return="$(printf '\r')"
case "$PGPASSWORD" in
  *'
'*|*"$carriage_return"*) fail "database password must be a single line" ;;
esac
password_length=${#PGPASSWORD}
[ "$password_length" -ge 24 ] && [ "$password_length" -le 1024 ] || fail "database password must contain 24 to 1024 characters"

export PGPASSWORD
trap 'unset PGPASSWORD' EXIT HUP INT TERM

case "$RESTORE_RECONCILIATION_TARGET" in
  runtime)
    exec /usr/local/bin/business-finlynq-reconcile-runtime-role
    ;;
  auth-worker)
    exec /usr/local/bin/business-finlynq-provision-auth-worker-role
    ;;
  backup)
    : "${BACKUP_DATABASE_PASSWORD_FILE:?BACKUP_DATABASE_PASSWORD_FILE is required for backup reconciliation}"
    exec /usr/local/bin/business-finlynq-provision-backup-role
    ;;
  *)
    fail "target must be runtime, auth-worker, or backup"
    ;;
esac
