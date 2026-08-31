#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly CONFIG_FILE="/etc/business-finlynq/backup-receiver.conf"
for command_name in curl grep hostname python3 stat; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required receiver notification command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" \
  && "$(stat -c '%u:%g:%a' "$CONFIG_FILE")" == "0:0:644" ]] || {
  printf '%s\n' "Receiver notification configuration is unavailable" >&2
  exit 1
}
# shellcheck disable=SC1090
source "$CONFIG_FILE"

RECEIVER_FAILED_UNIT="${RECEIVER_FAILED_UNIT:-business-finlynq-backup-receiver-health.service}"
RECEIVER_ALERT_WEBHOOK_URL_FILE="${RECEIVER_ALERT_WEBHOOK_URL_FILE:-/etc/business-finlynq/backup-receiver-alert-webhook-url}"
[[ -f "$RECEIVER_ALERT_WEBHOOK_URL_FILE" && ! -L "$RECEIVER_ALERT_WEBHOOK_URL_FILE" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_ALERT_WEBHOOK_URL_FILE")" == "0:0:400" ]] || {
  printf 'Receiver failure remains in journald because its external webhook is unavailable: %s\n' "$RECEIVER_FAILED_UNIT" >&2
  exit 1
}
mapfile -t webhook_lines <"$RECEIVER_ALERT_WEBHOOK_URL_FILE"
[[ "${#webhook_lines[@]}" -eq 1 ]] || {
  printf '%s\n' "Receiver alert webhook must be one HTTPS line" >&2
  exit 1
}
webhook_url="${webhook_lines[0]}"
grep -Eq '^https://[^[:space:]"\\]+$' "$RECEIVER_ALERT_WEBHOOK_URL_FILE" || {
  printf '%s\n' "Receiver alert webhook must be one HTTPS line without config metacharacters" >&2
  exit 1
}

host_name="$(hostname -f 2>/dev/null || hostname)"
payload="$(printf '%s on %s failed. Inspect the receiver health and ingestion journals.' "$RECEIVER_FAILED_UNIT" "$host_name")"
json_payload="$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$payload")"
# Feed the secret-bearing URL through curl's protected standard-input config.
# It must never appear in curl argv or the systemd journal/proc command line.
printf 'url = "%s"\n' "$webhook_url" \
  | curl --config - --fail --silent --show-error --max-time 10 --retry 3 \
    --header 'Content-Type: application/json' --data "$json_payload" >/dev/null
