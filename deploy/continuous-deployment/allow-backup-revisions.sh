#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly allowed_revisions="/etc/business-finlynq/backup-receiver-allowed-revisions"
readonly receiver_config="/etc/business-finlynq/backup-receiver.conf"
readonly revision_lock="/run/lock/business-finlynq-receiver-revisions.lock"

fail() {
  printf 'Business Finlynq receiver allowlist update refused: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" == 0 ]] || fail "run this command as root"
[[ "$#" == 2 ]] || fail "expected the deployed source and candidate revisions"
source_revision="$1"
candidate_revision="$2"
for revision in "$source_revision" "$candidate_revision"; do
  [[ "$revision" =~ ^[a-f0-9]{40}$ && ! "$revision" =~ ^0+$ ]] \
    || fail "each revision must be a non-zero full 40-character Git SHA"
done

for command_name in chmod chown flock grep mktemp mv rm sort stat sync; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

[[ -f "$receiver_config" && ! -L "$receiver_config" \
  && "$(stat -c '%u:%g:%a' -- "$receiver_config")" == 0:0:644 ]] \
  || fail "the receiver configuration is unavailable or unsafe"
grep -Fxq "RECEIVER_ALLOWED_REVISIONS_FILE=$allowed_revisions" "$receiver_config" \
  || fail "the receiver configuration identifies a different allowlist"
[[ -f "$allowed_revisions" && ! -L "$allowed_revisions" \
  && "$(stat -c '%u:%g:%a' -- "$allowed_revisions")" == 0:0:644 ]] \
  || fail "the installed receiver allowlist is unavailable or unsafe"
awk 'NF && ($1 !~ /^([a-f0-9]{40}|[a-f0-9]{64})$/ || NF != 1 || $1 ~ /^0+$/) {exit 1}' \
  "$allowed_revisions" \
  || fail "the installed receiver allowlist contains an invalid record"
grep -Fxq "$source_revision" "$allowed_revisions" \
  || fail "the currently deployed source revision is not already trusted"

[[ ! -L "$revision_lock" ]] || fail "the receiver revision lock is symbolic"
exec 9>"$revision_lock"
chmod 0600 "$revision_lock"
flock --exclusive --nonblock 9 || fail "another receiver allowlist update is active"

temporary="$(mktemp /etc/business-finlynq/.backup-receiver-revisions.XXXXXX)"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT INT TERM
printf '%s\n%s\n' "$source_revision" "$candidate_revision" | sort -u >"$temporary"
chmod 0644 "$temporary"
chown root:root "$temporary"
mv -f -- "$temporary" "$allowed_revisions"
temporary=""
sync -f -- "$allowed_revisions"
sync -f -- "${allowed_revisions%/*}"
trap - EXIT INT TERM

printf 'Allowed backup revisions %s and %s.\n' "$source_revision" "$candidate_revision"
