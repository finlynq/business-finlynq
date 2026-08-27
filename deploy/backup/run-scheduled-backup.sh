#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
[[ "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]] || {
  printf '%s\n' "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full Git revision" >&2
  exit 2
}

docker compose --profile operations run --rm provision_backup
docker compose --profile operations run --rm --no-deps backup
