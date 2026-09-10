#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_dir/check-latest-backup.sh"
backup_runner="$script_dir/run-backup.sh"
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
      sourceApplicationRevision: $revision,
      backupToolRevision: $revision,
      encryptedArchive: $archive,
      encryptedBytes: $bytes,
      sha256: $sha256,
      encryption: "age",
      format: "postgres-custom",
      database: "must-not-leak",
      sourceHost: "must-not-leak",
      arbitraryPrivateMetadata: {token: "must-not-leak"}
    }' >"$target_dir/$prefix.manifest.json"
  printf '%s remote=%s\n' "$created_at" "offsite:business-finlynq/database" >"$target_dir/$prefix.uploaded"
  chmod 0600 -- "$target_dir"/* "$target_dir/.backup.lock"
}

run_verifier() {
  local target_dir="$1"
  local require_offsite="$2"
  local emit_evidence="${3:-false}"
  local manifest_basename="${4:-}"
  local -a verifier_arguments=()
  [[ -z "$manifest_basename" ]] \
    || verifier_arguments+=(--manifest-basename "$manifest_basename")
  [[ "$emit_evidence" == "false" ]] || verifier_arguments+=(--emit-evidence)
  BACKUP_OUTPUT_DIR="$target_dir" \
  BACKUP_MAX_AGE_HOURS=6 \
  BACKUP_MAX_ACTIVE_SECONDS=4800 \
  BACKUP_REQUIRE_OFFSITE_MARKER="$require_offsite" \
    /bin/bash "$verifier" "${verifier_arguments[@]}" </dev/null
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
default_output="$(run_verifier "$valid_dir" true)"
[[ "$default_output" == "Business Finlynq encrypted backup verification passed" ]] || {
  printf '%s\n' "Verifier default output contract changed unexpectedly" >&2
  exit 1
}
evidence_output="$(run_verifier "$valid_dir" true true)"
[[ "$(printf '%s\n' "$evidence_output" | grep -Fc 'BUSINESS_FINLYNQ_BACKUP_EVIDENCE=')" == "1" ]] || {
  printf '%s\n' "Verifier did not emit exactly one evidence record" >&2
  exit 1
}
evidence_json="$(printf '%s\n' "$evidence_output" | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p')"
[[ -n "$evidence_json" ]] || {
  printf '%s\n' "Verifier did not emit sanitized backup evidence" >&2
  exit 1
}
jq -e --arg revision "$revision" '
  type == "object" and
  (keys | sort) == ([
    "applicationRevision", "backupToolRevision", "createdAt", "encryptedArchive",
    "encryptedBytes", "encryption", "format", "manifestBasename", "product", "schemaVersion",
    "sha256", "sourceApplicationRevision"
  ] | sort) and
  .schemaVersion == 1 and .product == "business-finlynq" and
  .applicationRevision == $revision and .sourceApplicationRevision == $revision and
  .backupToolRevision == $revision and .encryption == "age" and
  .format == "postgres-custom" and
  (.manifestBasename | type == "string" and
    test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.manifest\\.json$")) and
  (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
  (.encryptedArchive | type == "string" and test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.dump\\.age$")) and
  (.encryptedBytes | type == "number" and . > 0) and
  (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
  (tostring | contains("must-not-leak") | not)
' <<<"$evidence_json" >/dev/null
expect_failure "an unknown evidence option" env \
  BACKUP_OUTPUT_DIR="$valid_dir" \
  BACKUP_MAX_AGE_HOURS=6 \
  BACKUP_MAX_ACTIVE_SECONDS=4800 \
  BACKUP_REQUIRE_OFFSITE_MARKER=true \
  /bin/bash "$verifier" --unknown

exact_dir="$fixture_root/exact-selection"
older_created_at="$(date -u --date='-2 minutes' +%Y-%m-%dT%H:%M:%SZ)"
older_timestamp="${older_created_at//-/}"
older_timestamp="${older_timestamp//:/}"
newer_created_at="$(date -u --date='-1 minute' +%Y-%m-%dT%H:%M:%SZ)"
newer_timestamp="${newer_created_at//-/}"
newer_timestamp="${newer_timestamp//:/}"
create_fixture "$exact_dir" "$older_timestamp" "$older_created_at"
create_fixture "$exact_dir" "$newer_timestamp" "$newer_created_at"
older_prefix="business_finlynq_${older_timestamp}_business_finlynq"
newer_prefix="business_finlynq_${newer_timestamp}_business_finlynq"
older_manifest="$older_prefix.manifest.json"
newer_manifest="$newer_prefix.manifest.json"

latest_exact_output="$(run_verifier "$exact_dir" true true)"
latest_exact_json="$(printf '%s\n' "$latest_exact_output" \
  | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p')"
jq -e --arg manifest "$newer_manifest" \
  '.manifestBasename == $manifest' <<<"$latest_exact_json" >/dev/null || {
    printf '%s\n' "No-argument verifier no longer selects the latest completed manifest" >&2
    exit 1
  }

older_exact_output="$(run_verifier "$exact_dir" true true "$older_manifest")"
older_exact_json="$(printf '%s\n' "$older_exact_output" \
  | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p')"
jq -e --arg manifest "$older_manifest" --arg archive "$older_prefix.dump.age" \
  '.manifestBasename == $manifest and .encryptedArchive == $archive' \
  <<<"$older_exact_json" >/dev/null || {
    printf '%s\n' "Exact verifier substituted a newer completed backup" >&2
    exit 1
  }

# Options are intentionally order-independent so the release integration does
# not depend on a fragile positional parser.
reverse_order_output="$(
  BACKUP_OUTPUT_DIR="$exact_dir" \
  BACKUP_MAX_AGE_HOURS=6 \
  BACKUP_MAX_ACTIVE_SECONDS=4800 \
  BACKUP_REQUIRE_OFFSITE_MARKER=true \
    /bin/bash "$verifier" --emit-evidence --manifest-basename "$older_manifest" </dev/null
)"
reverse_order_json="$(printf '%s\n' "$reverse_order_output" \
  | sed -n 's/^BUSINESS_FINLYNQ_BACKUP_EVIDENCE=//p')"
jq -e --arg manifest "$older_manifest" '.manifestBasename == $manifest' \
  <<<"$reverse_order_json" >/dev/null

printf '%s\n' "tampered-exact-payload" >>"$exact_dir/$older_prefix.dump.age"
expect_failure "a corrupted exact backup when a valid newer backup exists" \
  run_verifier "$exact_dir" true true "$older_manifest"
run_verifier "$exact_dir" true true "$newer_manifest" >/dev/null
printf '%s\n' "encrypted-test-payload" >"$exact_dir/$older_prefix.dump.age"

rm -f -- "$exact_dir/$older_prefix.uploaded"
expect_failure "an exact backup missing its off-site marker when a valid newer backup exists" \
  run_verifier "$exact_dir" true true "$older_manifest"
run_verifier "$exact_dir" true true "$newer_manifest" >/dev/null

expect_failure "a nonexistent exact manifest when another completed backup exists" \
  run_verifier "$exact_dir" true true \
    "business_finlynq_19990101T000000Z_business_finlynq.manifest.json"
expect_failure "an exact manifest path traversal" \
  run_verifier "$exact_dir" true true "../$newer_manifest"
expect_failure "an absolute exact manifest path" \
  run_verifier "$exact_dir" true true "$exact_dir/$newer_manifest"
expect_failure "an exact manifest with the wrong suffix" \
  run_verifier "$exact_dir" true true "$newer_prefix.dump.age"
symlink_manifest="business_finlynq_19990101T000001Z_business_finlynq.manifest.json"
ln -s -- "$newer_manifest" "$exact_dir/$symlink_manifest"
expect_failure "a symbolic-link exact manifest" \
  run_verifier "$exact_dir" true true "$symlink_manifest"
expect_failure "a duplicate exact-manifest option" env \
  BACKUP_OUTPUT_DIR="$exact_dir" \
  BACKUP_MAX_AGE_HOURS=6 \
  BACKUP_MAX_ACTIVE_SECONDS=4800 \
  BACKUP_REQUIRE_OFFSITE_MARKER=true \
  /bin/bash "$verifier" \
    --manifest-basename "$newer_manifest" --manifest-basename "$older_manifest"

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
exact_lock_status=0
run_verifier "$valid_dir" false false "$valid_prefix.manifest.json" \
  >/dev/null 2>&1 || exact_lock_status=$?
[[ "$exact_lock_status" == "75" ]] || {
  printf 'Exact verifier returned %s instead of 75 for an active backup\n' \
    "$exact_lock_status" >&2
  exit 1
}
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

# Exercise the producer-result boundary with isolated command fakes. The result
# must be the final line after the local manifest and required remote set have
# committed, and it must not be emitted when the remote manifest commit fails.
producer_fixture="$fixture_root/producer"
producer_bin="$producer_fixture/bin"
producer_output_dir="$producer_fixture/backups"
producer_remote_dir="$producer_fixture/remote"
mkdir -p -- "$producer_bin" "$producer_output_dir" "$producer_remote_dir"

cat >"$producer_bin/pg_dump" <<'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' 'pg_dump (PostgreSQL) 16.4'
else
  printf '%s\n' 'consistent-test-dump'
fi
EOF

cat >"$producer_bin/age" <<'EOF'
#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
cat >"$output"
EOF

cat >"$producer_bin/rclone" <<'EOF'
#!/bin/sh
set -eu
[ "${1:-}" = "--config" ]
shift 2
operation="$1"
shift
case "$operation" in
  copyto)
    source_path="$1"
    remote_name="${2##*/}"
    if [ "${FAKE_RCLONE_FAIL_MANIFEST:-false}" = "true" ]; then
      case "$remote_name" in
        *.manifest.json) exit 72 ;;
      esac
    fi
    cp -- "$source_path" "$FAKE_RCLONE_REMOTE_DIR/$remote_name"
    ;;
  cat)
    remote_name="${1##*/}"
    cat -- "$FAKE_RCLONE_REMOTE_DIR/$remote_name"
    ;;
  *) exit 73 ;;
esac
EOF
chmod 0700 -- "$producer_bin/pg_dump" "$producer_bin/age" "$producer_bin/rclone"

producer_password="$producer_fixture/database-password"
producer_recipient="$producer_fixture/age-recipient"
producer_rclone_config="$producer_fixture/rclone.conf"
printf '%s\n' 'test-database-password' >"$producer_password"
printf '%s\n' 'age1testrecipient' >"$producer_recipient"
printf '%s\n' '[fixture]' >"$producer_rclone_config"

producer_output="$(
  PATH="$producer_bin:$PATH" \
  PGHOST=database \
  PGDATABASE=business_finlynq \
  PGUSER=business_finlynq_backup \
  BACKUP_DATABASE_PASSWORD_FILE="$producer_password" \
  BACKUP_AGE_RECIPIENT_FILE="$producer_recipient" \
  BUSINESS_FINLYNQ_IMAGE_REVISION="$revision" \
  BACKUP_OUTPUT_DIR="$producer_output_dir" \
  BACKUP_REQUIRE_OFFSITE=true \
  BACKUP_RCLONE_REMOTE='fixture:business-finlynq/database' \
  BACKUP_RCLONE_CONFIG_FILE="$producer_rclone_config" \
  FAKE_RCLONE_REMOTE_DIR="$producer_remote_dir" \
    /bin/bash "$backup_runner" </dev/null
)"
[[ "$(printf '%s\n' "$producer_output" \
  | grep -Fc 'BUSINESS_FINLYNQ_BACKUP_RESULT=')" == "1" ]] || {
    printf '%s\n' "Backup producer did not emit exactly one committed result" >&2
    exit 1
  }
producer_result_line="$(printf '%s\n' "$producer_output" | tail -n 1)"
[[ "$producer_result_line" == BUSINESS_FINLYNQ_BACKUP_RESULT=* ]] || {
  printf '%s\n' "Backup producer result is not its final output line" >&2
  exit 1
}
producer_result_json="${producer_result_line#BUSINESS_FINLYNQ_BACKUP_RESULT=}"
producer_manifest="$(jq -er '
  if type == "object" and
    keys == ["manifestBasename", "product", "schemaVersion"] and
    .schemaVersion == 1 and .product == "business-finlynq" and
    (.manifestBasename | type == "string" and
      test("^business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_.-]+\\.manifest\\.json$"))
  then .manifestBasename
  else error("invalid producer result")
  end
' <<<"$producer_result_json")" || {
  printf '%s\n' "Backup producer result schema is invalid" >&2
  exit 1
}
producer_prefix="${producer_manifest%.manifest.json}"
for committed_path in \
  "$producer_output_dir/$producer_manifest" \
  "$producer_output_dir/$producer_prefix.dump.age" \
  "$producer_output_dir/$producer_prefix.sha256" \
  "$producer_output_dir/$producer_prefix.uploaded" \
  "$producer_remote_dir/$producer_manifest" \
  "$producer_remote_dir/$producer_prefix.dump.age" \
  "$producer_remote_dir/$producer_prefix.sha256"; do
  [[ -f "$committed_path" && -s "$committed_path" ]] || {
    printf 'Backup producer emitted a result before committing %s\n' "$committed_path" >&2
    exit 1
  }
done

failed_output_dir="$producer_fixture/failed-backups"
failed_remote_dir="$producer_fixture/failed-remote"
mkdir -p -- "$failed_output_dir" "$failed_remote_dir"
failed_producer_status=0
failed_producer_output="$(
  PATH="$producer_bin:$PATH" \
  PGHOST=database \
  PGDATABASE=business_finlynq \
  PGUSER=business_finlynq_backup \
  BACKUP_DATABASE_PASSWORD_FILE="$producer_password" \
  BACKUP_AGE_RECIPIENT_FILE="$producer_recipient" \
  BUSINESS_FINLYNQ_IMAGE_REVISION="$revision" \
  BACKUP_OUTPUT_DIR="$failed_output_dir" \
  BACKUP_REQUIRE_OFFSITE=true \
  BACKUP_RCLONE_REMOTE='fixture:business-finlynq/database' \
  BACKUP_RCLONE_CONFIG_FILE="$producer_rclone_config" \
  FAKE_RCLONE_REMOTE_DIR="$failed_remote_dir" \
  FAKE_RCLONE_FAIL_MANIFEST=true \
    /bin/bash "$backup_runner" </dev/null 2>&1
)" || failed_producer_status=$?
[[ "$failed_producer_status" != "0" ]] || {
  printf '%s\n' "Backup producer unexpectedly accepted a failed remote manifest commit" >&2
  exit 1
}
if printf '%s\n' "$failed_producer_output" | grep -Fq 'BUSINESS_FINLYNQ_BACKUP_RESULT='; then
  printf '%s\n' "Backup producer emitted an exact result before remote commit" >&2
  exit 1
fi
if find "$failed_output_dir" -maxdepth 1 -type f -name 'business_finlynq_*' -print -quit \
  | grep -q .; then
  printf '%s\n' "Failed backup producer left a local completed-set artifact" >&2
  exit 1
fi

printf '%s\n' "Latest-backup verifier fixture checks passed"
