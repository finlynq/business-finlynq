#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
cd -- "$repository_root"

SCHEDULED_BACKUP_TIMEOUT_SECONDS="${SCHEDULED_BACKUP_TIMEOUT_SECONDS:-5400}"
[[ "$SCHEDULED_BACKUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ \
  && ${#SCHEDULED_BACKUP_TIMEOUT_SECONDS} -le 4 \
  && "$SCHEDULED_BACKUP_TIMEOUT_SECONDS" -le 5400 ]] || {
  printf '%s\n' "SCHEDULED_BACKUP_TIMEOUT_SECONDS must be 1 to 5400" >&2
  exit 2
}

: "${BUSINESS_FINLYNQ_IMAGE_REVISION:?BUSINESS_FINLYNQ_IMAGE_REVISION is required}"
[[ "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$BUSINESS_FINLYNQ_IMAGE_REVISION" =~ ^0+$ ]] || {
  printf '%s\n' "BUSINESS_FINLYNQ_IMAGE_REVISION must be a full Git revision" >&2
  exit 2
}

command -v timeout >/dev/null 2>&1 || {
  printf '%s\n' "GNU timeout is required for scheduled backup execution" >&2
  exit 2
}
if (( $# == 0 )); then
  exec timeout --signal=TERM --kill-after=30 "${SCHEDULED_BACKUP_TIMEOUT_SECONDS}s" \
    /bin/bash "$script_dir/run-scheduled-backup.sh" --bounded-run
fi
[[ $# == 1 && "$1" == "--bounded-run" ]] || {
  printf '%s\n' "Scheduled backup wrapper received an invalid internal invocation" >&2
  exit 2
}

docker compose --profile operations run --rm provision_backup
docker compose --profile operations run --rm --no-deps backup
