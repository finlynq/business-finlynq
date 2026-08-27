#!/usr/bin/env bash
set -Eeuo pipefail

MONITOR_ALERT_WEBHOOK_URL_FILE="${MONITOR_ALERT_WEBHOOK_URL_FILE:-/etc/business-finlynq/secrets/monitor-webhook-url}"
MONITOR_FAILED_UNIT="${MONITOR_FAILED_UNIT:-business-finlynq-monitor.service}"

if [[ ! -s "$MONITOR_ALERT_WEBHOOK_URL_FILE" ]]; then
  printf 'No monitoring webhook configured; failure remains available in journald for %s\n' "$MONITOR_FAILED_UNIT" >&2
  exit 0
fi

IFS= read -r webhook_url < "$MONITOR_ALERT_WEBHOOK_URL_FILE" || true
[[ "$webhook_url" == https://* ]] || {
  printf 'Monitoring webhook must use HTTPS\n' >&2
  exit 1
}

host_name="$(hostname -f 2>/dev/null || hostname)"
payload="$(printf '%s on %s failed. Inspect systemd and container logs.' "$MONITOR_FAILED_UNIT" "$host_name")"
json_payload="$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$payload")"

curl \
  --fail \
  --silent \
  --show-error \
  --max-time 10 \
  --retry 3 \
  --header 'Content-Type: application/json' \
  --data "$json_payload" \
  "$webhook_url" >/dev/null
