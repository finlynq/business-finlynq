#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

MONITOR_HOSTNAME="${MONITOR_HOSTNAME:-business.finlynq.com}"
MONITOR_BASE_URL="${MONITOR_BASE_URL:-https://$MONITOR_HOSTNAME}"
MONITOR_BACKUP_DIR="${MONITOR_BACKUP_DIR:-/var/backups/business-finlynq}"
MONITOR_MAX_BACKUP_AGE_HOURS="${MONITOR_MAX_BACKUP_AGE_HOURS:-8}"
MONITOR_MIN_TLS_DAYS="${MONITOR_MIN_TLS_DAYS:-21}"
MONITOR_MAX_DISK_PERCENT="${MONITOR_MAX_DISK_PERCENT:-85}"
MONITOR_EXPECT_EDGE="${MONITOR_EXPECT_EDGE:-true}"
MONITOR_EXPECT_AUTH_EMAIL_WORKER="${MONITOR_EXPECT_AUTH_EMAIL_WORKER:-false}"
MONITOR_REQUIRE_OFFSITE="${MONITOR_REQUIRE_OFFSITE:-true}"
MONITOR_EXPECT_REVISION="${MONITOR_EXPECT_REVISION:-${BUSINESS_FINLYNQ_IMAGE_REVISION:-}}"

failures=()

record_failure() {
  failures+=("$1")
}

for numeric_value in MONITOR_MAX_BACKUP_AGE_HOURS MONITOR_MIN_TLS_DAYS MONITOR_MAX_DISK_PERCENT; do
  [[ "${!numeric_value}" =~ ^[0-9]+$ ]] || {
    printf 'Invalid numeric monitoring setting: %s\n' "$numeric_value" >&2
    exit 2
  }
done
[[ "$MONITOR_EXPECT_EDGE" == "true" || "$MONITOR_EXPECT_EDGE" == "false" ]] || exit 2
[[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" || "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "false" ]] || exit 2
[[ "$MONITOR_REQUIRE_OFFSITE" == "true" || "$MONITOR_REQUIRE_OFFSITE" == "false" ]] || exit 2

if [[ -n "$MONITOR_EXPECT_REVISION" && ! "$MONITOR_EXPECT_REVISION" =~ ^[a-f0-9]{7,64}$ ]]; then
  printf 'MONITOR_EXPECT_REVISION must be an abbreviated or full hexadecimal Git revision\n' >&2
  exit 2
fi

for command_name in curl docker jq openssl sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required monitoring command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done

response_body="$(mktemp)"
response_headers="$(mktemp)"
cleanup() {
  rm -f -- "$response_body" "$response_headers"
}
trap cleanup EXIT INT TERM

http_status="$(curl \
  --silent \
  --show-error \
  --max-time 10 \
  --dump-header "$response_headers" \
  --output "$response_body" \
  --write-out '%{http_code}' \
  "$MONITOR_BASE_URL/api/health" || printf '000')"
if [[ "$http_status" != "200" ]] || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$response_body"; then
  record_failure "public readiness endpoint failed (HTTP $http_status)"
fi
if ! grep -Eiq '^strict-transport-security:[[:space:]]*max-age=' "$response_headers"; then
  record_failure "HTTPS response is missing HSTS"
fi
if ! grep -Eiq '^cache-control:.*no-store' "$response_headers"; then
  record_failure "readiness response is missing no-store caching"
fi
if [[ -n "$MONITOR_EXPECT_REVISION" ]]; then
  response_revision="$(jq -r '.revision // empty' "$response_body" 2>/dev/null || true)"
  [[ "$response_revision" == "$MONITOR_EXPECT_REVISION" ]] || record_failure "readiness revision does not match the deployed release"
fi

tls_seconds=$((MONITOR_MIN_TLS_DAYS * 86400))
if ! openssl s_client \
  -connect "$MONITOR_HOSTNAME:443" \
  -servername "$MONITOR_HOSTNAME" \
  </dev/null 2>/dev/null \
  | openssl x509 -checkend "$tls_seconds" -noout >/dev/null 2>&1; then
  record_failure "TLS certificate expires within $MONITOR_MIN_TLS_DAYS days or could not be read"
fi

expected_services=(database app)
if [[ "$MONITOR_EXPECT_EDGE" == "true" ]]; then
  expected_services+=(edge)
fi
if [[ "$MONITOR_EXPECT_AUTH_EMAIL_WORKER" == "true" ]]; then
  expected_services+=(auth_email_worker)
fi
for service_name in "${expected_services[@]}"; do
  container_id="$(docker compose --profile edge --profile auth-email ps --quiet "$service_name" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    record_failure "container is missing: $service_name"
    continue
  fi
  container_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$container_state" != "healthy" && "$container_state" != "running" ]]; then
    record_failure "container is not healthy: $service_name ($container_state)"
  fi
done

if [[ ! -d "$MONITOR_BACKUP_DIR" ]]; then
  record_failure "backup directory is missing"
else
  disk_percent="$(df -P "$MONITOR_BACKUP_DIR" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')"
  if [[ ! "$disk_percent" =~ ^[0-9]+$ ]] || (( disk_percent >= MONITOR_MAX_DISK_PERCENT )); then
    record_failure "backup filesystem utilization is ${disk_percent:-unknown}% (limit $MONITOR_MAX_DISK_PERCENT%)"
  fi

  latest_manifest=""
  for candidate in "$MONITOR_BACKUP_DIR"/business_finlynq_*.manifest.json; do
    [[ -f "$candidate" ]] || continue
    if [[ -z "$latest_manifest" || "$candidate" -nt "$latest_manifest" ]]; then
      latest_manifest="$candidate"
    fi
  done

  if [[ -z "$latest_manifest" ]]; then
    record_failure "no completed backup manifest exists"
  else
    manifest_epoch="$(stat -c '%Y' "$latest_manifest" 2>/dev/null || printf 0)"
    age_hours=$(( ( $(date +%s) - manifest_epoch ) / 3600 ))
    (( age_hours <= MONITOR_MAX_BACKUP_AGE_HOURS )) || record_failure "newest backup is $age_hours hours old"

    manifest_basename="$(basename -- "$latest_manifest")"
    backup_prefix="${manifest_basename%.manifest.json}"
    archive_path="$MONITOR_BACKUP_DIR/${backup_prefix}.dump.age"
    checksum_path="$MONITOR_BACKUP_DIR/${backup_prefix}.sha256"
    uploaded_path="$MONITOR_BACKUP_DIR/${backup_prefix}.uploaded"
    manifest_archive="$(jq -r '.encryptedArchive // empty' "$latest_manifest" 2>/dev/null || true)"
    manifest_sha256="$(jq -r '.sha256 // empty' "$latest_manifest" 2>/dev/null || true)"
    if [[ "$manifest_archive" != "${backup_prefix}.dump.age" || ! "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]]; then
      record_failure "newest backup manifest is invalid or inconsistent"
    fi
    if [[ ! -s "$archive_path" || ! -s "$checksum_path" ]]; then
      record_failure "newest backup set is incomplete"
    else
      expected_sha256="$(awk 'NR == 1 {print $1}' "$checksum_path")"
      actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
      if [[ ! "$expected_sha256" =~ ^[a-f0-9]{64}$ || "$expected_sha256" != "$actual_sha256" || "$manifest_sha256" != "$actual_sha256" ]]; then
        record_failure "newest encrypted backup checksum is invalid"
      fi
    fi
    if [[ "$MONITOR_REQUIRE_OFFSITE" == "true" && ! -s "$uploaded_path" ]]; then
      record_failure "newest backup has no verified off-site upload marker"
    fi
  fi
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Business Finlynq production check failed:\n' >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

printf '%s\n' "Business Finlynq production check passed"
