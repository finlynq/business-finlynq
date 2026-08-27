#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

cleanup() {
  docker compose --profile restore-drill rm --stop --force \
    restore_database restore_verify restore_migrate restore_runtime_grants \
    restore_auth_worker_grants restore_key_verify restore_app \
    restore_runtime_verify >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# These services contain only a disposable, tmpfs-backed drill database. The
# production database and application services are never stopped or removed.
cleanup
docker compose --profile restore-drill up --detach --wait --no-deps restore_database
docker compose --profile restore-drill run --rm --no-deps restore_verify
docker compose --profile restore-drill run --rm --no-deps restore_migrate
docker compose --profile restore-drill run --rm --no-deps restore_runtime_grants
docker compose --profile restore-drill run --rm --no-deps restore_auth_worker_grants
docker compose --profile restore-drill run --rm --no-deps restore_key_verify
docker compose --profile restore-drill up --detach --wait --no-deps restore_app
docker compose --profile restore-drill run --rm --no-deps restore_runtime_verify

printf '%s\n' "Restore drill, key recovery, migrations, role reconciliation, and runtime acceptance completed successfully"
