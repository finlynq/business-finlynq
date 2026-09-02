#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

fail() {
  printf 'Business Finlynq receiver deployment gateway refused the request.\n' >&2
  exit 1
}

[[ "$#" == 0 ]] || fail
[[ -n "${SSH_ORIGINAL_COMMAND:-}" ]] || fail

IFS=' ' read -r action source_revision candidate_revision extra <<<"$SSH_ORIGINAL_COMMAND"
[[ "$action" == allow && -z "${extra:-}" ]] || fail
for revision in "$source_revision" "$candidate_revision"; do
  [[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] || fail
done

exec sudo -n /usr/local/sbin/business-finlynq-allow-backup-revisions \
  "$source_revision" "$candidate_revision"
