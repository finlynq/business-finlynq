#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly RECEIVER_USER="finlynq-backup"
readonly RECEIVER_ROOT="/srv/business-finlynq-backup"
readonly INCOMING_DIRECTORY="$RECEIVER_ROOT/incoming"
readonly PROCESSING_DIRECTORY="$RECEIVER_ROOT/processing"
readonly VAULT_DIRECTORY="$RECEIVER_ROOT/vault"
readonly QUARANTINE_DIRECTORY="$RECEIVER_ROOT/quarantine"
readonly STATE_DIRECTORY="/var/lib/business-finlynq-backup-receiver"
readonly CONFIG_FILE="/etc/business-finlynq/backup-receiver.conf"
readonly MAX_BACKUP_DURATION_SECONDS="86400"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "Receiver ingestion must run as root"
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" && "$(stat -c '%u:%g:%a' "$CONFIG_FILE")" == "0:0:644" ]] || fail "Receiver configuration must be root:root mode 0644"
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${RECEIVER_ALLOWED_REVISIONS_FILE:?RECEIVER_ALLOWED_REVISIONS_FILE is required}"
: "${RECEIVER_RECEIPT_SIGNING_KEY_FILE:?RECEIVER_RECEIPT_SIGNING_KEY_FILE is required}"
: "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE:?RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE is required}"
: "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256:?RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256 is required}"
RECEIVER_RETENTION_DAYS="${RECEIVER_RETENTION_DAYS:-60}"
RECEIVER_SETTLE_SECONDS="${RECEIVER_SETTLE_SECONDS:-60}"
[[ "$RECEIVER_RETENTION_DAYS" == "60" ]] || fail "Target-side retention must remain 60 days"
[[ "$RECEIVER_SETTLE_SECONDS" =~ ^[0-9]+$ && "$RECEIVER_SETTLE_SECONDS" -ge 30 ]] || fail "RECEIVER_SETTLE_SECONDS must be at least 30"
[[ -f "$RECEIVER_ALLOWED_REVISIONS_FILE" && ! -L "$RECEIVER_ALLOWED_REVISIONS_FILE" && -s "$RECEIVER_ALLOWED_REVISIONS_FILE" ]] || fail "The root-managed application revision allowlist is missing"
[[ "$(stat -c '%u:%g:%a' "$RECEIVER_ALLOWED_REVISIONS_FILE")" == "0:0:644" ]] || fail "The application revision allowlist must be root:root mode 0644"
[[ "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256" =~ ^[a-f0-9]{64}$ \
  && ! "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256" =~ ^0+$ ]] \
  || fail "The receipt signing public-key fingerprint is invalid"

for command_name in awk cmp cp date find flock grep head install jq mktemp mv openssl rm rmdir sha256sum stat wc; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

[[ -f "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" && ! -L "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_RECEIPT_SIGNING_KEY_FILE")" == "0:0:400" ]] \
  || fail "Receipt signing private key must be root:root mode 0400"
[[ -f "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" && ! -L "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE")" == "0:0:644" ]] \
  || fail "Receipt signing public key must be root:root mode 0644"
openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -check -noout >/dev/null 2>&1 \
  || fail "Receipt signing private key is invalid"
openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -text_pub -noout 2>/dev/null \
  | grep -Fqi 'ED25519' || fail "Receipt signing key must use Ed25519"
openssl pkey -pubin -in "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" -pubcheck -noout >/dev/null 2>&1 \
  || fail "Receipt signing public key is invalid"
derived_receipt_public_key="$(mktemp)"
openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -pubout -out "$derived_receipt_public_key" \
  || fail "Could not derive the receipt signing public key"
cmp -s -- "$derived_receipt_public_key" "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" \
  || fail "Receipt signing private and public keys do not match"
rm -f -- "$derived_receipt_public_key"
[[ "$(sha256sum "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" | awk '{print $1}')" \
  == "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256" ]] \
  || fail "Receipt signing public key does not match its pinned fingerprint"

for required_directory in "$RECEIVER_ROOT" "$INCOMING_DIRECTORY" "$PROCESSING_DIRECTORY" "$VAULT_DIRECTORY" "$QUARANTINE_DIRECTORY"; do
  [[ -d "$required_directory" && ! -L "$required_directory" ]] || fail "Required receiver directory is unsafe or missing: $required_directory"
done
receiver_device="$(stat -c '%d' "$RECEIVER_ROOT")"
for receiver_directory in "$INCOMING_DIRECTORY" "$PROCESSING_DIRECTORY" "$VAULT_DIRECTORY" "$QUARANTINE_DIRECTORY"; do
  [[ "$(stat -c '%d' "$receiver_directory")" == "$receiver_device" ]] || fail "Receiver directories must stay on the dedicated filesystem"
done
[[ "$(stat -c '%u:%g:%a' "$RECEIVER_ROOT")" == "0:0:755" ]] || fail "Chroot root ownership or mode is unsafe"
[[ "$(stat -c '%u:%a' "$INCOMING_DIRECTORY")" == "$(id -u "$RECEIVER_USER"):700" ]] || fail "Incoming directory ownership or mode is unsafe"
for root_only_directory in "$PROCESSING_DIRECTORY" "$VAULT_DIRECTORY" "$QUARANTINE_DIRECTORY"; do
  [[ "$(stat -c '%u:%g:%a' "$root_only_directory")" == "0:0:700" ]] || fail "Root-only directory ownership or mode is unsafe: $root_only_directory"
done

install -d -o root -g root -m 0700 "$STATE_DIRECTORY"
exec 9>"$STATE_DIRECTORY/ingest.lock"
flock -n 9 || fail "Another receiver ingestion process holds the lock"

uploader_uid="$(id -u "$RECEIVER_USER")"
uploader_gid="$(id -g "$RECEIVER_USER")"
validation_error=""

reject() {
  validation_error="$1"
  return 1
}

quarantine_claim() {
  local claim_directory="$1"
  local reason="$2"
  local quarantine_stamp quarantine_target
  reason="${reason//[^a-z0-9_-]/_}"
  quarantine_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  quarantine_target="$(mktemp -d "$QUARANTINE_DIRECTORY/${quarantine_stamp}_${reason}.XXXXXX")"
  chmod 0700 "$quarantine_target"
  if [[ -d "$claim_directory" && ! -L "$claim_directory" ]]; then
    while IFS= read -r -d '' claimed_entry; do
      mv -- "$claimed_entry" "$quarantine_target/"
    done < <(find "$claim_directory" -mindepth 1 -maxdepth 1 -print0)
    rmdir -- "$claim_directory"
  fi
  printf '%s\n' "$reason" > "$quarantine_target/.reason"
  chown -hR root:root "$quarantine_target"
  find "$quarantine_target" -type d -exec chmod 0700 {} +
  find "$quarantine_target" -type f -exec chmod 0400 {} +
  log "Quarantined an invalid completed backup set: $(basename -- "$quarantine_target")"
}

seal_claim_artifacts() {
  local untrusted_claim_directory="$1"
  local prefix="$2"
  local archive_name checksum_name manifest_name artifact_name source_path sealed_path
  local entry_count file_uid file_gid file_links

  archive_name="$prefix.dump.age"
  checksum_name="$prefix.sha256"
  manifest_name="$prefix.manifest.json"
  entry_count="$(find "$untrusted_claim_directory" -mindepth 1 -maxdepth 1 -printf '.' | wc -c)"
  [[ "$entry_count" == "3" ]] || { reject "unexpected_file_count"; return 1; }
  for artifact_name in "$archive_name" "$checksum_name" "$manifest_name"; do
    source_path="$untrusted_claim_directory/$artifact_name"
    [[ -f "$source_path" && ! -L "$source_path" ]] \
      || { reject "non_regular_artifact"; return 1; }
    file_uid="$(stat -c '%u' "$source_path")"
    file_gid="$(stat -c '%g' "$source_path")"
    file_links="$(stat -c '%h' "$source_path")"
    [[ "$file_uid" == "$uploader_uid" && "$file_gid" == "$uploader_gid" \
      && "$file_links" == "1" ]] \
      || { reject "unsafe_artifact_metadata"; return 1; }
  done

  sealed_claim_directory="$(mktemp -d "$PROCESSING_DIRECTORY/.${prefix}.sealed.XXXXXX")"
  chmod 0700 "$sealed_claim_directory"
  chown root:root "$sealed_claim_directory"
  for artifact_name in "$archive_name" "$checksum_name" "$manifest_name"; do
    source_path="$untrusted_claim_directory/$artifact_name"
    sealed_path="$sealed_claim_directory/$artifact_name"
    # Create a distinct root-owned inode, then force a byte copy without
    # reflinks. An uploader-held writable descriptor can continue to mutate the
    # now-unlinked source inode, but can never mutate the validated vault inode.
    install -o root -g root -m 0600 /dev/null "$sealed_path" \
      || { reject "artifact_seal_failed"; return 1; }
    cp --reflink=never --sparse=never --no-preserve=all -- "$source_path" "$sealed_path" \
      || { reject "artifact_seal_failed"; return 1; }
    chown root:root "$sealed_path"
    chmod 0400 "$sealed_path"
    [[ "$(stat -c '%u:%g:%a:%h:%d' "$sealed_path")" \
      == "0:0:400:1:$receiver_device" ]] \
      || { reject "artifact_seal_metadata_failed"; return 1; }
  done

  # Discard only the three already-claimed uploader inodes after all sealed
  # copies exist. Open SFTP descriptors then refer to anonymous, untrusted
  # inodes and cannot affect either validation or the published vault set.
  for artifact_name in "$archive_name" "$checksum_name" "$manifest_name"; do
    rm -f -- "$untrusted_claim_directory/$artifact_name"
  done
  rmdir -- "$untrusted_claim_directory"
}

validate_set() {
  local claim_directory="$1"
  local prefix="$2"
  local timestamp="$3"
  local database="$4"
  local archive_name checksum_name manifest_name archive_path checksum_path manifest_path
  local entry_count entry_path file_uid file_gid file_mode file_links file_device
  local prefix_created_at prefix_epoch manifest_created_at manifest_epoch receiver_now_epoch
  local manifest_database manifest_archive manifest_bytes manifest_hash manifest_revision
  local archive_bytes archive_hash expected_checksum_line
  local -a checksum_lines

  archive_name="$prefix.dump.age"
  checksum_name="$prefix.sha256"
  manifest_name="$prefix.manifest.json"
  archive_path="$claim_directory/$archive_name"
  checksum_path="$claim_directory/$checksum_name"
  manifest_path="$claim_directory/$manifest_name"

  entry_count="$(find "$claim_directory" -mindepth 1 -maxdepth 1 -printf '.' | wc -c)"
  [[ "$entry_count" == "3" ]] || { reject "unexpected_file_count"; return 1; }
  for entry_path in "$archive_path" "$checksum_path" "$manifest_path"; do
    [[ -f "$entry_path" && ! -L "$entry_path" ]] || { reject "non_regular_artifact"; return 1; }
    file_uid="$(stat -c '%u' "$entry_path")"
    file_gid="$(stat -c '%g' "$entry_path")"
    file_mode="$(stat -c '%a' "$entry_path")"
    file_links="$(stat -c '%h' "$entry_path")"
    file_device="$(stat -c '%d' "$entry_path")"
    [[ "$file_uid" == "0" && "$file_gid" == "0" && "$file_mode" == "400" \
      && "$file_links" == "1" && "$file_device" == "$receiver_device" ]] \
      || { reject "unsafe_sealed_artifact_metadata"; return 1; }
  done

  [[ "$(stat -c '%s' "$manifest_path")" -le 65536 ]] || { reject "manifest_too_large"; return 1; }
  [[ "$(stat -c '%s' "$checksum_path")" -le 256 ]] || { reject "checksum_too_large"; return 1; }
  [[ "$(stat -c '%s' "$archive_path")" -gt 22 ]] || { reject "archive_too_small"; return 1; }
  cmp -s <(head -c 22 "$archive_path") <(printf 'age-encryption.org/v1\n') || { reject "invalid_age_header"; return 1; }

  jq -e '
    type == "object" and
    ((keys == [
      "applicationRevision", "compression", "createdAt", "database",
      "encryptedArchive", "encryptedBytes", "encryption", "format",
      "localRetentionDays", "pgDumpVersion", "product", "schemaVersion",
      "sha256", "sourceHost"
    ]) or (keys == [
      "applicationRevision", "backupToolRevision", "compression", "createdAt",
      "database", "encryptedArchive", "encryptedBytes", "encryption", "format",
      "localRetentionDays", "pgDumpVersion", "product", "schemaVersion", "sha256",
      "sourceApplicationRevision", "sourceHost"
    ])) and
    .schemaVersion == 1 and
    .product == "business-finlynq" and
    (.createdAt | type == "string") and
    (.database | type == "string" and test("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")) and
    (.sourceHost | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$")) and
    (.applicationRevision | type == "string" and test("^([a-f0-9]{40}|[a-f0-9]{64})$") and (test("^0+$") | not)) and
    ((.sourceApplicationRevision // .applicationRevision) == .applicationRevision) and
    ((.backupToolRevision // .applicationRevision) | type == "string" and test("^([a-f0-9]{40}|[a-f0-9]{64})$") and (test("^0+$") | not)) and
    .format == "postgres-custom" and
    .compression == "zstd:9" and
    .encryption == "age" and
    (.pgDumpVersion | type == "string" and length > 0 and length <= 255) and
    (.encryptedArchive | type == "string") and
    (.encryptedBytes | type == "number" and floor == . and . > 0) and
    (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.localRetentionDays | type == "number" and floor == . and . >= 0)
  ' "$manifest_path" >/dev/null || { reject "invalid_manifest"; return 1; }

  prefix_created_at="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2}T${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2}Z"
  [[ "$(date -u -d "$prefix_created_at" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" == "$prefix_created_at" ]] || { reject "invalid_timestamp"; return 1; }
  manifest_created_at="$(jq -r '.createdAt' "$manifest_path")"
  [[ "$(date -u -d "$manifest_created_at" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" == "$manifest_created_at" ]] || { reject "invalid_manifest_timestamp"; return 1; }
  prefix_epoch="$(date -u -d "$prefix_created_at" +%s)"
  manifest_epoch="$(date -u -d "$manifest_created_at" +%s)"
  (( manifest_epoch >= prefix_epoch && manifest_epoch - prefix_epoch <= MAX_BACKUP_DURATION_SECONDS )) || { reject "timestamp_mismatch"; return 1; }
  receiver_now_epoch="$(date +%s)"
  (( manifest_epoch <= receiver_now_epoch )) \
    || { reject "future_recovery_point"; return 1; }
  manifest_database="$(jq -r '.database' "$manifest_path")"
  manifest_archive="$(jq -r '.encryptedArchive' "$manifest_path")"
  manifest_bytes="$(jq -r '.encryptedBytes' "$manifest_path")"
  manifest_hash="$(jq -r '.sha256' "$manifest_path")"
  manifest_revision="$(jq -r '.applicationRevision' "$manifest_path")"
  manifest_tool_revision="$(jq -r '.backupToolRevision // .applicationRevision' "$manifest_path")"
  [[ "$manifest_database" == "$database" ]] || { reject "database_name_mismatch"; return 1; }
  [[ "$manifest_archive" == "$archive_name" ]] || { reject "archive_name_mismatch"; return 1; }
  grep -Fxq -- "$manifest_revision" "$RECEIVER_ALLOWED_REVISIONS_FILE" || { reject "unapproved_application_revision"; return 1; }
  grep -Fxq -- "$manifest_tool_revision" "$RECEIVER_ALLOWED_REVISIONS_FILE" || { reject "unapproved_backup_tool_revision"; return 1; }

  archive_bytes="$(stat -c '%s' "$archive_path")"
  [[ "$archive_bytes" == "$manifest_bytes" ]] || { reject "archive_size_mismatch"; return 1; }
  archive_hash="$(sha256sum "$archive_path" | awk '{print $1}')"
  [[ "$archive_hash" == "$manifest_hash" ]] || { reject "archive_hash_mismatch"; return 1; }
  expected_checksum_line="$archive_hash  $archive_name"
  mapfile -t checksum_lines < "$checksum_path"
  [[ "${#checksum_lines[@]}" -eq 1 && "${checksum_lines[0]}" == "$expected_checksum_line" ]] || { reject "checksum_file_mismatch"; return 1; }
}

accept_claim() {
  local claim_directory="$1"
  local prefix="$2"
  local timestamp="$3"
  local dated_vault target_directory manifest_path receipt_name receipt_path partial_receipt
  local signature_name signature_path partial_signature accepted_at
  dated_vault="$VAULT_DIRECTORY/${timestamp:0:4}/${timestamp:4:2}/${timestamp:6:2}"
  install -d -o root -g root -m 0700 "$VAULT_DIRECTORY/${timestamp:0:4}" "$VAULT_DIRECTORY/${timestamp:0:4}/${timestamp:4:2}" "$dated_vault"
  target_directory="$dated_vault/$prefix"
  [[ ! -e "$target_directory" ]] || {
    quarantine_claim "$claim_directory" "duplicate_vault_set"
    return
  }
  manifest_path="$claim_directory/$prefix.manifest.json"
  receipt_name="$prefix.receiver-receipt.json"
  receipt_path="$claim_directory/$receipt_name"
  partial_receipt="$claim_directory/.${receipt_name}.partial.$$"
  signature_name="$receipt_name.sig"
  signature_path="$claim_directory/$signature_name"
  partial_signature="$claim_directory/.${signature_name}.partial.$$"
  accepted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ ! -e "$receipt_path" && ! -L "$receipt_path" \
    && ! -e "$signature_path" && ! -L "$signature_path" ]] \
    || fail "Receiver acceptance receipt or signature already exists"
  jq \
    --arg acceptedAt "$accepted_at" \
    --arg manifest "$prefix.manifest.json" \
    --arg signingKeySha256 "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256" \
    '{
      schemaVersion: 2,
      product: "business-finlynq",
      receiptType: "offsite-receiver-acceptance",
      result: "accepted",
      signatureAlgorithm: "ed25519",
      signingKeySha256: $signingKeySha256,
      acceptedAt: $acceptedAt,
      manifest: $manifest,
      createdAt: .createdAt,
      encryptedArchive: .encryptedArchive,
      encryptedBytes: .encryptedBytes,
      sha256: .sha256,
      sourceApplicationRevision: (.sourceApplicationRevision // .applicationRevision),
      backupToolRevision: (.backupToolRevision // .applicationRevision)
    }' "$manifest_path" >"$partial_receipt"
  openssl pkeyutl -sign -rawin \
    -inkey "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" \
    -in "$partial_receipt" \
    -out "$partial_signature" \
    || fail "Could not sign receiver acceptance receipt"
  [[ "$(stat -c '%s' "$partial_signature")" == "64" ]] \
    || fail "Receiver acceptance receipt signature has an invalid size"
  openssl pkeyutl -verify -rawin -pubin \
    -inkey "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" \
    -in "$partial_receipt" \
    -sigfile "$partial_signature" >/dev/null 2>&1 \
    || fail "Receiver acceptance receipt signature did not self-verify"
  chmod 0400 "$partial_receipt"
  chmod 0400 "$partial_signature"
  mv -- "$partial_receipt" "$receipt_path"
  mv -- "$partial_signature" "$signature_path"
  # Receipt creation completes while the claim is still root-only. The single
  # directory rename then publishes the validated triplet, receiver-generated
  # receipt, and detached Ed25519 signature into the vault together.
  mv -- "$claim_directory" "$target_directory"
  chown -hR root:root "$target_directory"
  find "$target_directory" -type d -exec chmod 0700 {} +
  find "$target_directory" -type f -exec chmod 0400 {} +
  touch "$target_directory"
  log "Accepted encrypted backup set into the root-only vault: $prefix"
}

claim_manifest_set() {
  local manifest_path="$1"
  local manifest_name prefix timestamp database archive_name checksum_name claim_directory artifact_name artifact_path marker_age
  manifest_name="$(basename -- "$manifest_path")"
  if [[ ! "$manifest_name" =~ ^(business_finlynq_([0-9]{8}T[0-9]{6}Z)_([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))\.manifest\.json$ ]]; then
    claim_directory="$(mktemp -d "$PROCESSING_DIRECTORY/.invalid-manifest.XXXXXX")"
    mv -- "$manifest_path" "$claim_directory/"
    quarantine_claim "$claim_directory" "invalid_manifest_name"
    return
  fi
  prefix="${BASH_REMATCH[1]}"
  timestamp="${BASH_REMATCH[2]}"
  database="${BASH_REMATCH[3]}"
  archive_name="$prefix.dump.age"
  checksum_name="$prefix.sha256"

  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || {
    claim_directory="$(mktemp -d "$PROCESSING_DIRECTORY/.unsafe-manifest.XXXXXX")"
    mv -- "$manifest_path" "$claim_directory/"
    quarantine_claim "$claim_directory" "non_regular_manifest_marker"
    return
  }
  marker_age="$(( $(date +%s) - $(stat -c '%Y' "$manifest_path") ))"
  (( marker_age >= RECEIVER_SETTLE_SECONDS )) || return

  claim_directory="$(mktemp -d "$PROCESSING_DIRECTORY/.${prefix}.claim.XXXXXX")"
  chmod 0700 "$claim_directory"
  # Each rename is atomic on the dedicated filesystem. Moving the manifest first
  # consumes the completion marker before any untrusted content is inspected.
  for artifact_name in "$manifest_name" "$archive_name" "$checksum_name"; do
    artifact_path="$INCOMING_DIRECTORY/$artifact_name"
    if [[ ! -e "$artifact_path" && ! -L "$artifact_path" ]]; then
      quarantine_claim "$claim_directory" "incomplete_after_manifest"
      return
    fi
    if ! mv -- "$artifact_path" "$claim_directory/$artifact_name"; then
      quarantine_claim "$claim_directory" "claim_race"
      return
    fi
  done

  validation_error=""
  sealed_claim_directory=""
  if ! seal_claim_artifacts "$claim_directory" "$prefix"; then
    if [[ -n "$sealed_claim_directory" && -d "$sealed_claim_directory" \
      && ! -L "$sealed_claim_directory" ]]; then
      quarantine_claim "$sealed_claim_directory" "${validation_error:-artifact_seal_failed}"
    fi
    if [[ -d "$claim_directory" && ! -L "$claim_directory" ]]; then
      quarantine_claim "$claim_directory" "${validation_error:-artifact_seal_failed}_originals"
    fi
    return
  fi
  if validate_set "$sealed_claim_directory" "$prefix" "$timestamp" "$database"; then
    accept_claim "$sealed_claim_directory" "$prefix" "$timestamp"
  else
    quarantine_claim "$sealed_claim_directory" "${validation_error:-validation_failed}"
  fi
}

while IFS= read -r -d '' manifest_path; do
  claim_manifest_set "$manifest_path"
done < <(find "$INCOMING_DIRECTORY" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -name 'business_finlynq_*.manifest.json' -print0)

# A process killed between atomic renames can leave a root-only claim behind.
# It is never returned to uploader control; stale claims are quarantined.
while IFS= read -r -d '' stale_claim; do
  quarantine_claim "$stale_claim" "stale_processing_claim"
done < <(find "$PROCESSING_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -mmin +15 -print0)

prune_root_only_sets() {
  local retention_root="$1"
  local minimum_depth="$2"
  local maximum_depth="$3"
  local expired_set
  while IFS= read -r -d '' expired_set; do
    [[ -d "$expired_set" && ! -L "$expired_set" ]] || continue
    case "$expired_set" in
      "$retention_root"/*) ;;
      *) fail "Retention candidate escaped its root: $expired_set" ;;
    esac
    log "Removing an expired root-only receiver set: $expired_set"
    rm -rf --one-file-system -- "$expired_set"
  done < <(find "$retention_root" -mindepth "$minimum_depth" -maxdepth "$maximum_depth" -type d -mtime "+$RECEIVER_RETENTION_DAYS" -print0)
}

prune_root_only_sets "$VAULT_DIRECTORY" 4 4
prune_root_only_sets "$QUARANTINE_DIRECTORY" 1 1
find "$VAULT_DIRECTORY" -mindepth 1 -depth -type d -empty -delete

log "Receiver ingestion and 60-day retention pass completed"
