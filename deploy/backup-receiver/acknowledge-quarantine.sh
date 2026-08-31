#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly RECEIVER_ROOT="/srv/business-finlynq-backup"
readonly QUARANTINE_DIRECTORY="$RECEIVER_ROOT/quarantine"

fail() {
  printf 'Receiver quarantine acknowledgement failed: %s\n' "$1" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "run as root after completing operator review"
[[ $# -eq 3 ]] || fail "usage: acknowledge-quarantine.sh <set-name> <reviewer> <ticket>"
readonly quarantine_name="$1"
readonly reviewer="$2"
readonly ticket="$3"
[[ "$quarantine_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$ ]] \
  || fail "set name is unsafe"
[[ "$reviewer" =~ ^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,127}$ ]] \
  || fail "reviewer must be a stable non-secret identifier"
[[ "$ticket" =~ ^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$ ]] \
  || fail "ticket must be a stable non-secret incident or change reference"
for command_name in date jq mktemp mv readlink stat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
[[ -d "$QUARANTINE_DIRECTORY" && ! -L "$QUARANTINE_DIRECTORY" \
  && "$(stat -c '%u:%g:%a' "$QUARANTINE_DIRECTORY")" == "0:0:700" ]] \
  || fail "root-only quarantine directory is unavailable"

readonly quarantine_set="$QUARANTINE_DIRECTORY/$quarantine_name"
[[ -d "$quarantine_set" && ! -L "$quarantine_set" \
  && "$(stat -c '%u:%g:%a' "$quarantine_set")" == "0:0:700" ]] \
  || fail "named quarantine set is unavailable or unsafe"
case "$(readlink -f -- "$quarantine_set")" in
  "$QUARANTINE_DIRECTORY"/*) ;;
  *) fail "named quarantine set resolves outside the quarantine root" ;;
esac
readonly acknowledgement="$quarantine_set/.acknowledged.json"
[[ ! -e "$acknowledgement" && ! -L "$acknowledgement" ]] \
  || fail "quarantine set is already acknowledged; retain the original review record"

temporary_acknowledgement="$(mktemp "$quarantine_set/.acknowledged.json.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$temporary_acknowledgement"
}
trap cleanup EXIT INT TERM
jq -n \
  --arg quarantine "$quarantine_name" \
  --arg reviewedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg reviewedBy "$reviewer" \
  --arg ticket "$ticket" \
  '{
    schemaVersion: 1,
    product: "business-finlynq",
    recordType: "receiver-quarantine-review",
    result: "acknowledged",
    quarantine: $quarantine,
    reviewedAt: $reviewedAt,
    reviewedBy: $reviewedBy,
    ticket: $ticket
  }' >"$temporary_acknowledgement"
chmod 0400 -- "$temporary_acknowledgement"
mv -- "$temporary_acknowledgement" "$acknowledgement"
trap - EXIT INT TERM
printf 'Acknowledged retained receiver quarantine %s under review ticket %s\n' \
  "$quarantine_name" "$ticket"
