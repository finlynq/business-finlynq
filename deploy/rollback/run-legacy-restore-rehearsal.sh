#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

: "${ROLLBACK_COMPATIBILITY_ACK:?set ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only}"
[[ "$ROLLBACK_COMPATIBILITY_ACK" == "f8485-one-release-only" ]] || {
  printf '%s\n' "Rollback rehearsal acknowledgement is invalid" >&2
  exit 1
}

compose=(docker compose -f docker-compose.yml -f deploy/rollback/docker-compose.restore-rehearsal.yml --profile restore-drill)

cleanup() {
  "${compose[@]}" rm --stop --force \
    restore_database restore_verify restore_migrate restore_runtime_grants \
    restore_auth_worker_grants restore_key_verify restore_app \
    restore_runtime_verify rollback_rehearsal_app rollback_rehearsal_verify \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cleanup
"${compose[@]}" up --detach --wait --no-deps restore_database
"${compose[@]}" run --rm --no-deps restore_verify
"${compose[@]}" run --rm --no-deps restore_migrate
"${compose[@]}" run --rm --no-deps restore_runtime_grants
"${compose[@]}" run --rm --no-deps restore_auth_worker_grants
"${compose[@]}" run --rm --no-deps restore_key_verify
"${compose[@]}" up --detach --wait --no-deps rollback_rehearsal_app
"${compose[@]}" run --rm --no-deps rollback_rehearsal_verify

printf '%s\n' "Hard-pinned f8485 image passed the post-0010 isolated restore rehearsal"
