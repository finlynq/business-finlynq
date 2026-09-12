#!/usr/bin/env bash
set -Eeuo pipefail
set +x

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || {
  printf 'Business Finlynq shared-edge verification failed: could not resolve the script directory\n' >&2
  exit 1
}
readonly script_directory

# Compatibility entry point only. Shared-edge contract v1 forbids application
# repositories from reconciling, reloading, recreating, or repairing Caddy.
exec bash "$script_directory/verify-external-edge.sh" --scope production "$@"
