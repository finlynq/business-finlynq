#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DATABASE_PASSWORD" <<-'SQL'
CREATE ROLE business_finlynq_app
  LOGIN
  PASSWORD :'app_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS
  CONNECTION LIMIT 20;

REVOKE ALL ON DATABASE business_finlynq FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE business_finlynq TO business_finlynq_app;
GRANT USAGE ON SCHEMA public TO business_finlynq_app;

ALTER ROLE business_finlynq_app SET statement_timeout = '15s';
ALTER ROLE business_finlynq_app SET lock_timeout = '5s';
ALTER ROLE business_finlynq_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE business_finlynq_app SET search_path = public, app;

ALTER DEFAULT PRIVILEGES FOR ROLE business_finlynq_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO business_finlynq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE business_finlynq_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO business_finlynq_app;
SQL
