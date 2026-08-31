#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_dir/check-latest-backup.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/business-finlynq-backup-check.XXXXXX")"
revision="1111111111111111111111111111111111111111"
lock_holder_pid=""

cleanup() {
  if [[ -n "$lock_holder_pid" ]]; then
    kill "$lock_holder_pid" 2>/dev/null || true
    wait "$lock_holder_pid" 2>/dev/null || true
  fi
  case "$fixture_root" in
    "${TMPDIR:-/tmp}"/business-finlynq-backup-check.*) rm -rf -- "$fixture_root" ;;
    *) printf '%s\n' "Refusing to remove unexpected test fixture path" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

create_fixture() {
  local target_dir="$1"
  local timestamp="$2"
  local created_at="$3"
  local prefix="business_finlynq_${timestamp}_business_finlynq"
  local archive_name="$prefix.dump.age"
  local archive_path="$target_dir/$archive_name"
  local archive_sha256=""
  local archive_bytes=""

  mkdir -p -- "$target_dir"
  : >"$target_dir/.backup.lock"
  printf '%s\n' "encrypted-test-payload" >"$archive_path"
  archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  archive_bytes="$(wc -c <"$archive_path" | tr -d '[:space:]')"
  printf '%s  %s\n' "$archive_sha256" "$archive_name" >"$target_dir/$prefix.sha256"
  jq -n \
    --arg createdAt "$created_at" \
    --arg archive "$archive_name" \
    --arg sha256 "$archive_sha256" \
    --arg revision "$revision" \
    --argjson bytes "$archive_bytes" \
    '{
      schemaVersion: 1,
      product: "business-finlynq",
      createdAt: $createdAt,
      applicationRevision: $revision,
      encryptedArchive: $archive,
      encryptedBytes: $bytes,
      sha256: $sha256
    }' >"$target_dir/$prefix.manifest.json"
  printf '%s remote=%s\n' "$created_at" "offsite:business-finlynq/database" >"$target_dir/$prefix.uploaded"
  chmod 0600 -- "$target_dir"/* "$target_dir/.backup.lock"
}

run_verifier() {
  local target_dir="$1"
  local require_offsite="$2"
  BACKUP_OUTPUT_DIR="$target_dir" \
  BACKUP_MAX_AGE_HOURS=6 \
  BACKUP_MAX_ACTIVE_SECONDS=4800 \
  BACKUP_REQUIRE_OFFSITE_MARKER="$require_offsite" \
    /bin/bash "$verifier" </dev/null
}

expect_failure() {
  local message="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'Verifier accepted %s\n' "$message" >&2
    exit 1
  fi
}

current_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
current_created_at="${current_timestamp:0:4}-${current_timestamp:4:2}-${current_timestamp:6:2}T${current_timestamp:9:2}:${current_timestamp:11:2}:${current_timestamp:13:2}Z"
valid_dir="$fixture_root/valid"
create_fixture "$valid_dir" "$current_timestamp" "$current_created_at"
run_verifier "$valid_dir" true >/dev/null

valid_prefix="business_finlynq_${current_timestamp}_business_finlynq"
printf '%s\n' "tampered" >>"$valid_dir/$valid_prefix.dump.age"
expect_failure "a corrupted encrypted archive" run_verifier "$valid_dir" true
printf '%s\n' "encrypted-test-payload" >"$valid_dir/$valid_prefix.dump.age"

rm -f -- "$valid_dir/$valid_prefix.uploaded"
expect_failure "a missing required off-site marker" run_verifier "$valid_dir" true
run_verifier "$valid_dir" false >/dev/null

mismatch_dir="$fixture_root/filename-mismatch"
create_fixture "$mismatch_dir" "$current_timestamp" "2000-01-01T00:00:00Z"
expect_failure "a creation timestamp that differs from its filename" run_verifier "$mismatch_dir" true

stale_dir="$fixture_root/stale-touched"
create_fixture "$stale_dir" "20000101T000000Z" "2000-01-01T00:00:00Z"
touch -- "$stale_dir/business_finlynq_20000101T000000Z_business_finlynq.manifest.json"
expect_failure "a stale manifest whose filesystem timestamp was touched" run_verifier "$stale_dir" true

future_created_at="$(date -u --date='+1 day' +%Y-%m-%dT%H:%M:%SZ)"
future_timestamp="${future_created_at//-/}"
future_timestamp="${future_timestamp//:/}"
future_dir="$fixture_root/future"
create_fixture "$future_dir" "$future_timestamp" "$future_created_at"
expect_failure "a future-dated backup" run_verifier "$future_dir" true

lock_ready="$fixture_root/lock-ready"
lock_release="$fixture_root/lock-release"
(
  exec 8>"$valid_dir/.backup.lock"
  flock --exclusive 8
  : >"$lock_ready"
  while [[ ! -e "$lock_release" ]]; do
    sleep 0.05
  done
) &
lock_holder_pid=$!
for _ in {1..100}; do
  [[ -e "$lock_ready" ]] && break
  sleep 0.05
done
[[ -e "$lock_ready" ]] || {
  printf '%s\n' "Timed out preparing active-backup lock fixture" >&2
  exit 1
}

lock_output="$fixture_root/lock-output"
lock_status=0
run_verifier "$valid_dir" false >"$lock_output" 2>&1 || lock_status=$?
[[ "$lock_status" == "75" ]] || {
  printf 'Verifier returned %s instead of 75 for an active backup\n' "$lock_status" >&2
  exit 1
}
grep -Fqx -- "Backup verification deferred while an encrypted backup is active" "$lock_output"
: >"$lock_release"
wait "$lock_holder_pid"
lock_holder_pid=""

stale_lock_ready="$fixture_root/stale-lock-ready"
stale_lock_release="$fixture_root/stale-lock-release"
(
  exec 8>"$stale_dir/.backup.lock"
  flock --exclusive 8
  : >"$stale_lock_ready"
  while [[ ! -e "$stale_lock_release" ]]; do
    sleep 0.05
  done
) &
lock_holder_pid=$!
for _ in {1..100}; do
  [[ -e "$stale_lock_ready" ]] && break
  sleep 0.05
done
[[ -e "$stale_lock_ready" ]] || {
  printf '%s\n' "Timed out preparing stale active-backup fixture" >&2
  exit 1
}
stale_lock_status=0
run_verifier "$stale_dir" true >/dev/null 2>&1 || stale_lock_status=$?
[[ "$stale_lock_status" != "0" && "$stale_lock_status" != "75" ]] || {
  printf 'Verifier masked a stale completed recovery point with active status %s\n' "$stale_lock_status" >&2
  exit 1
}
: >"$stale_lock_release"
wait "$lock_holder_pid"
lock_holder_pid=""

printf '%s\n' "Latest-backup verifier fixture checks passed"
