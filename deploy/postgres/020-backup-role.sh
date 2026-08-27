#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${PGPASSWORD:?Owner PGPASSWORD is required}"
: "${BACKUP_DATABASE_PASSWORD_FILE:?BACKUP_DATABASE_PASSWORD_FILE is required}"

if [ ! -r "$BACKUP_DATABASE_PASSWORD_FILE" ]; then
  echo "Backup database password file is not readable" >&2
  exit 1
fi

password_line_count="$(awk 'END { print NR }' "$BACKUP_DATABASE_PASSWORD_FILE")"
if [ "$password_line_count" -ne 1 ]; then
  echo "Backup database password file must contain exactly one line" >&2
  exit 1
fi
backup_password=""
IFS= read -r backup_password < "$BACKUP_DATABASE_PASSWORD_FILE" || [ -n "$backup_password" ]
carriage_return="$(printf '\r')"
case "$backup_password" in
  *'
'*|*"$carriage_return"*)
    echo "Backup database password must be a single line" >&2
    exit 1
    ;;
esac
password_length=${#backup_password}
if [ "$password_length" -lt 24 ] || [ "$password_length" -gt 1024 ]; then
  echo "Backup database password must contain 24 to 1024 characters" >&2
  exit 1
fi

export PGPORT="${PGPORT:-5432}"
BUSINESS_FINLYNQ_BACKUP_RECONCILE_PASSWORD="$backup_password"
export BUSINESS_FINLYNQ_BACKUP_RECONCILE_PASSWORD
unset backup_password
trap 'unset BUSINESS_FINLYNQ_BACKUP_RECONCILE_PASSWORD' EXIT HUP INT TERM

psql \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --no-password \
  --set=ON_ERROR_STOP=1 \
  --set=database_name="$POSTGRES_DB" \
  --set=owner_role="$POSTGRES_USER" <<'SQL'
\getenv backup_password BUSINESS_FINLYNQ_BACKUP_RECONCILE_PASSWORD
DO $owner_check$
BEGIN
  IF current_user <> (
    SELECT pg_get_userbyid(database.datdba)
    FROM pg_database database
    WHERE database.datname = current_database()
  ) THEN
    RAISE EXCEPTION 'Backup-role reconciliation must run as the database owner';
  END IF;
END
$owner_check$;

SELECT format(
  'CREATE ROLE business_finlynq_backup LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
  :'backup_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_backup')
\gexec

SELECT format('ALTER ROLE business_finlynq_backup PASSWORD %L', :'backup_password')
\gexec

ALTER ROLE business_finlynq_backup
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
ALTER ROLE business_finlynq_backup SET default_transaction_read_only = on;
ALTER ROLE business_finlynq_backup SET lock_timeout = '30s';

SELECT format('GRANT CONNECT ON DATABASE %I TO business_finlynq_backup', :'database_name')
\gexec

SELECT format('GRANT USAGE ON SCHEMA %I TO business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
\gexec

SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
\gexec

SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO business_finlynq_backup',
  :'owner_role',
  nspname
)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON SEQUENCES TO business_finlynq_backup',
  :'owner_role',
  nspname
)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
\gexec

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'business_finlynq_backup'
      AND rolcanlogin
      AND rolbypassrls
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'backup role attributes are unsafe';
  END IF;
END
$$;
SQL

echo "Provisioned the read-only Business Finlynq backup role"
