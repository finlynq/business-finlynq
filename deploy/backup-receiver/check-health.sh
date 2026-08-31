#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly RECEIVER_ROOT="/srv/business-finlynq-backup"
readonly CONFIG_FILE="/etc/business-finlynq/backup-receiver.conf"
readonly DEFAULT_VERIFIER="/usr/local/libexec/business-finlynq-backup-receiver/verify-receiver.sh"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RECOVERY_POINT_FRESHNESS_LIBRARY="$script_directory/recovery-point-freshness.sh"

[[ "$EUID" -eq 0 ]] || { printf '%s\n' "Receiver health check must run as root" >&2; exit 1; }
for command_name in basename chmod date find install jq mktemp mv rm sed stat; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required receiver health command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
[[ -f "$RECOVERY_POINT_FRESHNESS_LIBRARY" && ! -L "$RECOVERY_POINT_FRESHNESS_LIBRARY" ]] \
  || { printf '%s\n' "Recovery-point freshness library is unavailable or unsafe" >&2; exit 2; }
# shellcheck disable=SC1090
source "$RECOVERY_POINT_FRESHNESS_LIBRARY"
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" && "$(stat -c '%u:%g:%a' "$CONFIG_FILE")" == "0:0:644" ]] \
  || { printf '%s\n' "Receiver health configuration is unavailable" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG_FILE"

RECEIVER_HEALTH_MAX_AGE_HOURS="${RECEIVER_HEALTH_MAX_AGE_HOURS:-6}"
RECEIVER_HEALTH_METRICS_FILE="${RECEIVER_HEALTH_METRICS_FILE:-/var/lib/business-finlynq-backup-receiver-metrics/receiver.prom}"
RECEIVER_HEALTH_VERIFIER="${RECEIVER_HEALTH_VERIFIER:-$DEFAULT_VERIFIER}"

[[ "$RECEIVER_HEALTH_MAX_AGE_HOURS" =~ ^[0-9]+$ \
  && "$RECEIVER_HEALTH_MAX_AGE_HOURS" -gt 0 \
  && "$RECEIVER_HEALTH_MAX_AGE_HOURS" -le 6 ]] \
  || { printf '%s\n' "Receiver maximum recovery-point age must be 1 to 6 hours" >&2; exit 2; }
[[ -x "$RECEIVER_HEALTH_VERIFIER" && ! -L "$RECEIVER_HEALTH_VERIFIER" ]] \
  || { printf '%s\n' "Receiver verifier is unavailable or unsafe" >&2; exit 1; }

verification_output="$(mktemp)"
health_success=0
quarantined_sets=-1
retained_quarantined_sets=-1
acknowledged_quarantined_sets=-1
latest_recovery_point_age_seconds=-1

write_metrics() {
  local exit_status="$1" metrics_directory metrics_temporary now
  metrics_directory="${RECEIVER_HEALTH_METRICS_FILE%/*}"
  now="$(date +%s)"
  if [[ "$RECEIVER_HEALTH_METRICS_FILE" != /* || "$metrics_directory" == "$RECEIVER_HEALTH_METRICS_FILE" \
    || -L "$metrics_directory" || -L "$RECEIVER_HEALTH_METRICS_FILE" \
    || ( -e "$metrics_directory" && ! -d "$metrics_directory" ) \
    || ( -e "$RECEIVER_HEALTH_METRICS_FILE" && ! -f "$RECEIVER_HEALTH_METRICS_FILE" ) ]]; then
    printf '%s\n' "Receiver health metrics path is unsafe" >&2
    return 1
  fi
  install -d -o root -g root -m 0755 -- "$metrics_directory" || return 1
  metrics_temporary="$(mktemp "${RECEIVER_HEALTH_METRICS_FILE}.tmp.XXXXXX")" || return 1
  chmod 0644 -- "$metrics_temporary"
  {
    printf '%s\n' '# HELP business_finlynq_backup_receiver_health_success Whether the latest independent receiver health check succeeded.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_health_success gauge'
    printf 'business_finlynq_backup_receiver_health_success %s\n' "$([[ "$exit_status" == "0" && "$health_success" == "1" ]] && printf '1' || printf '0')"
    printf '%s\n' '# HELP business_finlynq_backup_receiver_health_last_run_unixtime Unix time of the latest independent receiver health check.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_health_last_run_unixtime gauge'
    printf 'business_finlynq_backup_receiver_health_last_run_unixtime %s\n' "$now"
    printf '%s\n' '# HELP business_finlynq_backup_receiver_quarantined_sets Unacknowledged invalid completed backup sets requiring operator review.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_quarantined_sets gauge'
    printf 'business_finlynq_backup_receiver_quarantined_sets %s\n' "$quarantined_sets"
    printf '%s\n' '# HELP business_finlynq_backup_receiver_quarantine_retained_sets All invalid completed backup sets retained for evidence and review.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_quarantine_retained_sets gauge'
    printf 'business_finlynq_backup_receiver_quarantine_retained_sets %s\n' "$retained_quarantined_sets"
    printf '%s\n' '# HELP business_finlynq_backup_receiver_quarantine_acknowledged_sets Retained invalid sets with a valid root-owned operator acknowledgement.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_quarantine_acknowledged_sets gauge'
    printf 'business_finlynq_backup_receiver_quarantine_acknowledged_sets %s\n' "$acknowledged_quarantined_sets"
    printf '%s\n' '# HELP business_finlynq_backup_receiver_latest_accepted_receipt_age_seconds Age of the recovery point in the newest validated signed receiver receipt; -1 means unavailable.'
    printf '%s\n' '# TYPE business_finlynq_backup_receiver_latest_accepted_receipt_age_seconds gauge'
    printf 'business_finlynq_backup_receiver_latest_accepted_receipt_age_seconds %s\n' "$latest_recovery_point_age_seconds"
  } >"$metrics_temporary"
  mv -f -- "$metrics_temporary" "$RECEIVER_HEALTH_METRICS_FILE"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  rm -f -- "$verification_output"
  if ! write_metrics "$exit_status"; then
    printf '%s\n' "Receiver health heartbeat could not be written" >&2
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

if ! "$RECEIVER_HEALTH_VERIFIER" --require-backup --max-age-hours "$RECEIVER_HEALTH_MAX_AGE_HOURS" \
  >"$verification_output" 2>&1; then
  printf '%s\n' "Receiver verification or accepted-backup freshness failed" >&2
  exit 1
fi

quarantined_sets=0
retained_quarantined_sets=0
acknowledged_quarantined_sets=0
while IFS= read -r -d '' quarantined_set; do
  retained_quarantined_sets=$((retained_quarantined_sets + 1))
  [[ -d "$quarantined_set" && ! -L "$quarantined_set" \
    && "$(stat -c '%u:%g:%a' "$quarantined_set")" == "0:0:700" ]] || {
    printf '%s\n' "Receiver quarantine contains an unsafe set" >&2
    exit 1
  }
  quarantine_name="$(basename -- "$quarantined_set")"
  acknowledgement="$quarantined_set/.acknowledged.json"
  if [[ ! -e "$acknowledgement" && ! -L "$acknowledgement" ]]; then
    quarantined_sets=$((quarantined_sets + 1))
    continue
  fi
  [[ -f "$acknowledgement" && ! -L "$acknowledgement" \
    && "$(stat -c '%u:%g:%a' "$acknowledgement")" == "0:0:400" ]] || {
    printf '%s\n' "Receiver quarantine acknowledgement is unsafe" >&2
    exit 1
  }
  jq -e --arg quarantine "$quarantine_name" \
    'keys == ["product", "quarantine", "recordType", "result", "reviewedAt", "reviewedBy", "schemaVersion", "ticket"]
      and .schemaVersion == 1
      and .product == "business-finlynq"
      and .recordType == "receiver-quarantine-review"
      and .result == "acknowledged"
      and .quarantine == $quarantine
      and (.reviewedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.reviewedBy | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,127}$"))
      and (.ticket | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$"))' \
    "$acknowledgement" >/dev/null || {
    printf '%s\n' "Receiver quarantine acknowledgement has an invalid contract" >&2
    exit 1
  }
  reviewed_at="$(jq -r '.reviewedAt' "$acknowledgement")"
  reviewed_epoch="$(date -u --date="$reviewed_at" +%s 2>/dev/null)" || {
    printf '%s\n' "Receiver quarantine acknowledgement timestamp is invalid" >&2
    exit 1
  }
  (( reviewed_epoch <= $(date +%s) )) || {
    printf '%s\n' "Receiver quarantine acknowledgement timestamp is in the future" >&2
    exit 1
  }
  acknowledged_quarantined_sets=$((acknowledged_quarantined_sets + 1))
done < <(find "$RECEIVER_ROOT/quarantine" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
if (( quarantined_sets > 0 )); then
  printf 'Receiver has %s unacknowledged quarantined completed backup set(s)\n' "$quarantined_sets" >&2
  exit 1
fi

latest_signed_recovery_point_at="$(sed -n \
  's/^STATUS latest_signed_recovery_point_at=\([0-9T:Z-]*\)$/\1/p' \
  "$verification_output")"
[[ "$latest_signed_recovery_point_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
  printf '%s\n' "Validated signed recovery-point timestamp is unavailable" >&2
  exit 1
}
now="$(date +%s)"
latest_recovery_point_age_seconds="$(
  business_finlynq_recovery_point_age_seconds "$latest_signed_recovery_point_at" "$now"
)" || {
  printf '%s\n' "Validated signed recovery-point timestamp is invalid" >&2
  exit 1
}
business_finlynq_recovery_point_is_fresh \
  "$latest_recovery_point_age_seconds" "$RECEIVER_HEALTH_MAX_AGE_HOURS" || {
  printf '%s\n' "Latest signed recovery point reached the recovery threshold" >&2
  exit 1
}

health_success=1
printf '%s\n' "Business Finlynq backup receiver health check passed"
