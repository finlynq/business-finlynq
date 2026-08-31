#!/usr/bin/env bash
set -Eeuo pipefail

readonly maintenance_marker="/home/deploy/.local/state/business-finlynq/release-locks/scheduler-maintenance"
readonly repository_root="/home/deploy/business-finlynq"

[[ "${MONITOR_MAINTENANCE_SCHEDULER:-}" == "systemd" ]] || {
  printf '%s\n' "Business Finlynq systemd job skipped: canonical scheduler mode is not systemd" >&2
  exit 1
}
[[ ! -e "$maintenance_marker" && ! -L "$maintenance_marker" ]] || {
  printf '%s\n' "Business Finlynq systemd job skipped: release maintenance is active" >&2
  exit 1
}
[[ "${BUSINESS_FINLYNQ_IMAGE_REVISION:-}" =~ ^[a-f0-9]{40}$ \
  && ! "${BUSINESS_FINLYNQ_IMAGE_REVISION}" =~ ^0+$ ]] || {
  printf '%s\n' "Business Finlynq systemd job skipped: canonical release revision is invalid" >&2
  exit 1
}
if ! checkout_head="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  rev-parse HEAD 2>/dev/null)"; then
  printf '%s\n' "Business Finlynq systemd job skipped: canonical checkout revision could not be inspected" >&2
  exit 1
fi
[[ "$checkout_head" == "$BUSINESS_FINLYNQ_IMAGE_REVISION" ]] || {
  printf '%s\n' "Business Finlynq systemd job skipped: canonical checkout revision drifted" >&2
  exit 1
}
if ! checkout_status="$(git -c safe.directory="$repository_root" -C "$repository_root" \
  status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  printf '%s\n' "Business Finlynq systemd job skipped: canonical checkout status could not be inspected" >&2
  exit 1
fi
[[ -z "$checkout_status" ]] || {
  printf '%s\n' "Business Finlynq systemd job skipped: canonical checkout is not clean" >&2
  exit 1
}
