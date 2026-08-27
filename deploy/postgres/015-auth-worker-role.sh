#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${PGPASSWORD:?Owner PGPASSWORD is required}"
: "${AUTH_WORKER_DATABASE_PASSWORD_FILE:?AUTH_WORKER_DATABASE_PASSWORD_FILE is required}"

if [ ! -r "$AUTH_WORKER_DATABASE_PASSWORD_FILE" ]; then
  echo "Authentication worker database password file is not readable" >&2
  exit 1
fi

password_line_count="$(awk 'END { print NR }' "$AUTH_WORKER_DATABASE_PASSWORD_FILE")"
if [ "$password_line_count" -ne 1 ]; then
  echo "Authentication worker database password file must contain exactly one line" >&2
  exit 1
fi
worker_password=""
IFS= read -r worker_password < "$AUTH_WORKER_DATABASE_PASSWORD_FILE" || [ -n "$worker_password" ]
carriage_return="$(printf '\r')"
case "$worker_password" in
  *'
'*|*"$carriage_return"*)
    echo "Authentication worker database password must be a single line" >&2
    exit 1
    ;;
esac
password_length=${#worker_password}
if [ "$password_length" -lt 24 ] || [ "$password_length" -gt 1024 ]; then
  echo "Authentication worker database password must contain 24 to 1024 characters" >&2
  exit 1
fi

export PGPORT="${PGPORT:-5432}"
BUSINESS_FINLYNQ_AUTH_WORKER_RECONCILE_PASSWORD="$worker_password"
export BUSINESS_FINLYNQ_AUTH_WORKER_RECONCILE_PASSWORD
unset worker_password
trap 'unset BUSINESS_FINLYNQ_AUTH_WORKER_RECONCILE_PASSWORD' EXIT HUP INT TERM

psql \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --no-password \
  --set=ON_ERROR_STOP=1 \
  --set=database_name="$POSTGRES_DB" <<'SQL'
\getenv worker_password BUSINESS_FINLYNQ_AUTH_WORKER_RECONCILE_PASSWORD
DO $owner_check$
BEGIN
  IF current_user <> (
    SELECT pg_get_userbyid(database.datdba)
    FROM pg_database database
    WHERE database.datname = current_database()
  ) THEN
    RAISE EXCEPTION 'Authentication-worker grant reconciliation must run as the database owner';
  END IF;
END
$owner_check$;

SELECT format(
  'CREATE ROLE business_finlynq_auth_worker LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4',
  :'worker_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker')
\gexec

SELECT format('ALTER ROLE business_finlynq_auth_worker PASSWORD %L', :'worker_password')
\gexec

ALTER ROLE business_finlynq_auth_worker
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
ALTER ROLE business_finlynq_auth_worker SET statement_timeout = '20s';
ALTER ROLE business_finlynq_auth_worker SET lock_timeout = '5s';
ALTER ROLE business_finlynq_auth_worker SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE business_finlynq_auth_worker SET search_path = app, pg_catalog;

SELECT format('GRANT CONNECT ON DATABASE %I TO business_finlynq_auth_worker', :'database_name')
\gexec

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM business_finlynq_auth_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM business_finlynq_auth_worker;

DO $$
DECLARE
  function_signature text;
BEGIN
  IF to_regnamespace('app') IS NULL THEN RETURN; END IF;

  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM business_finlynq_auth_worker;
  GRANT USAGE ON SCHEMA app TO business_finlynq_auth_worker;

  FOREACH function_signature IN ARRAY ARRAY[
    'app.auth_email_worker_heartbeat(uuid)',
    'app.auth_claim_email_delivery(uuid)',
    'app.auth_complete_email_delivery(uuid,uuid,text)',
    'app.auth_fail_email_delivery(uuid,uuid,text,boolean)'
  ] LOOP
    IF to_regprocedure(function_signature) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO business_finlynq_auth_worker',
        function_signature
      );
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'business_finlynq_auth_worker'
      AND rolcanlogin
      AND NOT rolbypassrls
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND rolconnlimit = 4
  ) THEN
    RAISE EXCEPTION 'authentication worker role attributes are unsafe';
  END IF;
END
$$;
SQL

echo "Provisioned the least-privilege Business Finlynq authentication worker role"
