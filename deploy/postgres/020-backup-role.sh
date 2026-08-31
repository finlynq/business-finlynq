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
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS
  CONNECTION LIMIT 2 VALID UNTIL 'infinity';
ALTER ROLE business_finlynq_backup SET default_transaction_read_only = on;
ALTER ROLE business_finlynq_backup SET lock_timeout = '30s';

-- Reconcile from a deny-by-default baseline. This removes stale direct grants
-- or memberships if the role existed before this reviewed contract.
SELECT format('REVOKE %I FROM business_finlynq_backup', granted_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname = 'business_finlynq_backup'
\gexec

SELECT format('REVOKE business_finlynq_backup FROM %I', member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE granted_role.rolname = 'business_finlynq_backup'
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM business_finlynq_backup', :'database_name')
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA %I FROM business_finlynq_backup', nspname)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL PRIVILEGES ON TABLES FROM business_finlynq_backup',
  :'owner_role',
  nspname
)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL PRIVILEGES ON SEQUENCES FROM business_finlynq_backup',
  :'owner_role',
  nspname
)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL PRIVILEGES ON ROUTINES FROM business_finlynq_backup',
  :'owner_role',
  nspname
)
FROM pg_namespace
WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
\gexec

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

-- Audit-hash verification recomputes the canonical SHA-256 material while
-- connected as this read-only role. Keep that capability narrower than the
-- application API surface: one immutable pgcrypto digest overload, granted
-- directly and never through PUBLIC.
REVOKE EXECUTE ON FUNCTION public.digest(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.digest(text, text) TO business_finlynq_backup;

DO $$
DECLARE
  selected_role oid;
BEGIN
  SELECT oid INTO selected_role
    FROM pg_roles
    WHERE rolname = 'business_finlynq_backup'
      AND rolcanlogin
      AND rolbypassrls
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolinherit
      AND rolconnlimit = 2
      AND (rolvaliduntil IS NULL OR rolvaliduntil = 'infinity'::timestamptz);
  IF selected_role IS NULL THEN
    RAISE EXCEPTION 'backup role attributes are unsafe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = selected_role OR roleid = selected_role
  ) THEN
    RAISE EXCEPTION 'backup role must have no inbound or outbound role memberships';
  END IF;
  IF NOT has_database_privilege('business_finlynq_backup', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'backup role is missing database CONNECT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname <> 'information_schema' AND schema.nspname !~ '^pg_'
      AND schema.nspname NOT IN ('public', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ) THEN
    RAISE EXCEPTION 'an unreviewed application data schema requires an explicit backup policy';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname IN ('public', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT has_table_privilege('business_finlynq_backup', relation.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'backup role is missing SELECT on a reviewed relation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname IN ('public', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        has_table_privilege('business_finlynq_backup', relation.oid, 'INSERT')
        OR has_table_privilege('business_finlynq_backup', relation.oid, 'UPDATE')
        OR has_table_privilege('business_finlynq_backup', relation.oid, 'DELETE')
        OR has_table_privilege('business_finlynq_backup', relation.oid, 'TRUNCATE')
        OR has_table_privilege('business_finlynq_backup', relation.oid, 'REFERENCES')
        OR has_table_privilege('business_finlynq_backup', relation.oid, 'TRIGGER')
      )
  ) THEN
    RAISE EXCEPTION 'backup role has a write-capable relation privilege';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class sequence
    JOIN pg_namespace schema ON schema.oid = sequence.relnamespace
    WHERE schema.nspname IN ('public', 'drizzle')
      AND sequence.relkind = 'S'
      AND (
        NOT has_sequence_privilege('business_finlynq_backup', sequence.oid, 'SELECT')
        OR has_sequence_privilege('business_finlynq_backup', sequence.oid, 'USAGE')
        OR has_sequence_privilege('business_finlynq_backup', sequence.oid, 'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'backup role sequence privileges are unsafe';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    JOIN pg_namespace schema ON schema.oid = routine.pronamespace
    WHERE schema.nspname <> 'information_schema' AND schema.nspname !~ '^pg_'
      AND routine.oid <> to_regprocedure('public.digest(text,text)')
      AND has_function_privilege('business_finlynq_backup', routine.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'backup role has executable application routine privileges';
  END IF;
  IF NOT has_function_privilege(
    'business_finlynq_backup',
    'public.digest(text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'backup role is missing the audit digest capability';
  END IF;
END
$$;
SQL

echo "Provisioned the read-only Business Finlynq backup role"
