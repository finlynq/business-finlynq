#!/bin/sh
set -eu

fail() {
  printf 'Business Finlynq database entrypoint failed: %s\n' "$1" >&2
  exit 1
}

source_file="${APP_DATABASE_PASSWORD_FILE:-}"
runtime_directory=/run/business-finlynq-init
runtime_file="$runtime_directory/app-db-password"
temporary_file="$runtime_directory/.app-db-password.$$"
pgdata_directory="${PGDATA:-/var/lib/postgresql/data}"

[ "$(id -u)" = 0 ] || fail "the credential handoff must begin as root"
if [ -s "$pgdata_directory/PG_VERSION" ]; then
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi
[ "$source_file" = /run/secrets/business_finlynq_app_db_password ] \
  || fail "the application database password source is not the reviewed secret mount"
[ -f "$source_file" ] && [ ! -L "$source_file" ] \
  || fail "the application database password source is not a regular file"
[ -d "$runtime_directory" ] && [ ! -L "$runtime_directory" ] \
  || fail "the credential handoff tmpfs is unavailable"
[ "$(stat -c '%u:%g:%a' "$runtime_directory")" = 70:70:700 ] \
  || fail "the credential handoff tmpfs has unsafe ownership or mode"
[ ! -e "$temporary_file" ] && [ ! -L "$temporary_file" ] \
  || fail "the temporary credential handoff target already exists"

cleanup() {
  rm -f -- "$temporary_file"
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cp -- "$source_file" "$temporary_file"
chown 70:70 -- "$temporary_file"
chmod 0400 -- "$temporary_file"
[ "$(stat -c '%u:%g:%a' "$temporary_file")" = 70:70:400 ] \
  || fail "the copied application database password has unsafe ownership or mode"
mv -f -- "$temporary_file" "$runtime_file"
[ -f "$runtime_file" ] && [ ! -L "$runtime_file" ] \
  || fail "the application database password handoff failed"

trap - EXIT HUP INT TERM
export APP_DATABASE_PASSWORD_FILE="$runtime_file"
exec /usr/local/bin/docker-entrypoint.sh "$@"
