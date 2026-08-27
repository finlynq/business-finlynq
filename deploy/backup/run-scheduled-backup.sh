#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

if [[ -z "${BUSINESS_FINLYNQ_IMAGE_REVISION:-}" ]]; then
  BUSINESS_FINLYNQ_IMAGE_REVISION="$(git rev-parse --verify HEAD 2>/dev/null || printf unknown)"
  export BUSINESS_FINLYNQ_IMAGE_REVISION
fi

docker compose --profile operations run --rm provision_backup
docker compose --profile operations run --rm --no-deps backup
