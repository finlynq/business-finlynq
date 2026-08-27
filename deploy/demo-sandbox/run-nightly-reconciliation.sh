#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
lock_file="${DEMO_RESET_LOCK_FILE:-/run/lock/business-finlynq-demo-reset.lock}"

command -v flock >/dev/null 2>&1 || {
  printf '%s\n' "flock is required for demo-sandbox maintenance" >&2
  exit 1
}

cd -- "$repository_root"
exec 9>"$lock_file"
if ! flock --wait 600 9; then
  printf '%s\n' "Timed out waiting for incremental demo-sandbox maintenance" >&2
  exit 1
fi

docker compose --profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes
