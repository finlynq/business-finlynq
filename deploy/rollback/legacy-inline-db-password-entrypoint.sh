#!/bin/sh
set -eu

umask 077

fail() {
  echo "Legacy rollback adapter refused: $*" >&2
  exit 1
}

expected_revision="f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107"
[ "${ROLLBACK_COMPATIBILITY_ACK:-}" = "f8485-one-release-only" ] || fail "explicit one-release acknowledgement is missing"
[ "${BUSINESS_FINLYNQ_IMAGE_REVISION:-}" = "$expected_revision" ] || fail "adapter is restricted to the reviewed f8485 rollback artifact"
[ "$#" -eq 2 ] && [ "$1" = "node" ] && [ "$2" = "server.js" ] || fail "adapter may launch only node server.js"

password_file="${BUSINESS_FINLYNQ_DB_PASSWORD_FILE:-}"
[ -n "$password_file" ] || fail "BUSINESS_FINLYNQ_DB_PASSWORD_FILE is required"
[ -r "$password_file" ] || fail "application database password file is not readable"
[ -z "${BUSINESS_FINLYNQ_DB_PASSWORD:-}" ] || fail "inline application database password must not be supplied by Compose"

password_line_count="$(awk 'END { print NR }' "$password_file")"
[ "$password_line_count" -eq 1 ] || fail "application database password file must contain exactly one line"
BUSINESS_FINLYNQ_DB_PASSWORD=""
IFS= read -r BUSINESS_FINLYNQ_DB_PASSWORD < "$password_file" || [ -n "$BUSINESS_FINLYNQ_DB_PASSWORD" ]
carriage_return="$(printf '\r')"
case "$BUSINESS_FINLYNQ_DB_PASSWORD" in
  *'
'*|*"$carriage_return"*) fail "application database password must be a single line" ;;
esac
password_length=${#BUSINESS_FINLYNQ_DB_PASSWORD}
[ "$password_length" -ge 24 ] && [ "$password_length" -le 1024 ] || fail "application database password must contain 24 to 1024 characters"

export BUSINESS_FINLYNQ_DB_PASSWORD
unset BUSINESS_FINLYNQ_DB_PASSWORD_FILE password_file
exec "$@"
