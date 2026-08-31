#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly RECEIVER_USER="finlynq-backup"
readonly RECEIVER_GROUP="finlynq-backup"
readonly RECEIVER_ROOT="/srv/business-finlynq-backup"
readonly IMAGE_PATH="/var/lib/business-finlynq-backup-receiver/business-finlynq-backup-vault-10GiB.ext4.img"
readonly IMAGE_BYTES="10737418240"
readonly FILESYSTEM_LABEL="bf_backup_vault"
readonly CONFIG_FILE="/etc/business-finlynq/backup-receiver.conf"
readonly AUTHORIZED_KEYS_FILE="/etc/ssh/authorized_keys/$RECEIVER_USER"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RECOVERY_POINT_FRESHNESS_LIBRARY="$script_directory/recovery-point-freshness.sh"

require_backup="false"
max_age_hours="6"
if [[ "${1:-}" == "--require-backup" ]]; then
  require_backup="true"
  shift
fi
if [[ "${1:-}" == "--max-age-hours" ]]; then
  [[ $# -ge 2 ]] || { printf '%s\n' "--max-age-hours requires an integer" >&2; exit 2; }
  max_age_hours="$2"
  shift 2
fi
[[ $# -eq 0 ]] || { printf '%s\n' "Unknown verifier arguments" >&2; exit 2; }
[[ "$max_age_hours" =~ ^[0-9]+$ && "$max_age_hours" -gt 0 \
  && "$max_age_hours" -le 6 ]] \
  || { printf '%s\n' "max age must be a positive integer no greater than 6" >&2; exit 2; }
[[ "$EUID" -eq 0 ]] || { printf '%s\n' "Run the receiver verifier as root" >&2; exit 1; }
for command_name in awk basename blkid cmp date df dirname find findmnt getent grep head id jq losetup mktemp openssl passwd readlink sha256sum sshd stat systemctl tail wc xargs; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required receiver-verification command is unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done

failures=0
warnings=0
pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }

[[ -f "$RECOVERY_POINT_FRESHNESS_LIBRARY" && ! -L "$RECOVERY_POINT_FRESHNESS_LIBRARY" ]] \
  || { printf '%s\n' "Recovery-point freshness library is unavailable or unsafe" >&2; exit 2; }
# shellcheck disable=SC1090
source "$RECOVERY_POINT_FRESHNESS_LIBRARY"

[[ -f "$IMAGE_PATH" && ! -L "$IMAGE_PATH" ]] || fail "dedicated receiver image is missing or unsafe"
if [[ -f "$IMAGE_PATH" && ! -L "$IMAGE_PATH" ]]; then
  [[ "$(stat -c '%u:%g:%a:%s' "$IMAGE_PATH")" == "0:0:600:$IMAGE_BYTES" ]] && pass "dedicated image ownership, mode, and 10 GiB bound" || fail "dedicated image metadata"
  [[ "$(blkid -p -s TYPE -o value "$IMAGE_PATH" 2>/dev/null)" == "ext4" ]] && pass "dedicated image ext4 type" || fail "dedicated image filesystem type"
  [[ "$(blkid -p -s LABEL -o value "$IMAGE_PATH" 2>/dev/null)" == "$FILESYSTEM_LABEL" ]] && pass "dedicated image label" || fail "dedicated image label"
fi

if mounted_source="$(findmnt -rn -M "$RECEIVER_ROOT" -o SOURCE 2>/dev/null)"; then
  mounted_backing="$(losetup -n -O BACK-FILE "$mounted_source" 2>/dev/null | head -n 1 | xargs)"
  if [[ "$mounted_source" == /dev/loop* && -n "$mounted_backing" && "$(readlink -f -- "$mounted_backing")" == "$(readlink -f -- "$IMAGE_PATH")" ]]; then
    pass "receiver root is mounted from the dedicated loopback image"
  else
    fail "receiver root mount source"
  fi
  mount_options=",$(findmnt -rn -M "$RECEIVER_ROOT" -o OPTIONS),"
  for option_name in nodev nosuid noexec; do
    [[ "$mount_options" == *",$option_name,"* ]] && pass "mount option $option_name" || fail "missing mount option $option_name"
  done
else
  fail "receiver root is not a mount point"
fi

if passwd_entry="$(getent passwd "$RECEIVER_USER")"; then
  IFS=: read -r _ _ _ _ _ receiver_home receiver_shell <<< "$passwd_entry"
  [[ "$receiver_home" == "/incoming" && "$receiver_shell" == "/usr/sbin/nologin" ]] && pass "receiver account is no-shell" || fail "receiver account home or shell"
  [[ "$(id -Gn "$RECEIVER_USER")" == "$RECEIVER_GROUP" ]] && pass "receiver account has no supplementary groups" || fail "receiver account group membership"
  passwd -S "$RECEIVER_USER" | awk '$2 == "L" { found=1 } END { exit !found }' && pass "receiver account password is locked" || fail "receiver account password lock"
else
  fail "receiver account does not exist"
fi

[[ "$(stat -c '%u:%g:%a' "$RECEIVER_ROOT" 2>/dev/null || true)" == "0:0:755" ]] && pass "root-owned OpenSSH chroot" || fail "chroot ownership or mode"
[[ "$(stat -c '%U:%G:%a' "$RECEIVER_ROOT/incoming" 2>/dev/null || true)" == "$RECEIVER_USER:$RECEIVER_GROUP:700" ]] && pass "uploader-only incoming directory" || fail "incoming ownership or mode"
for root_only_name in processing vault quarantine; do
  [[ "$(stat -c '%u:%g:%a' "$RECEIVER_ROOT/$root_only_name" 2>/dev/null || true)" == "0:0:700" ]] && pass "root-only $root_only_name directory" || fail "$root_only_name ownership or mode"
done

if [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" && "$(stat -c '%u:%g:%a' "$CONFIG_FILE")" == "0:0:644" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
else
  fail "root-owned receiver configuration"
fi
RECEIVER_RECEIPT_SIGNING_KEY_FILE="${RECEIVER_RECEIPT_SIGNING_KEY_FILE:-}"
RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE="${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE:-}"
RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256="${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256:-}"
RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY="${RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY:-}"
if [[ -f "${RECEIVER_RECEIPT_SIGNING_KEY_FILE:-}" \
  && ! -L "${RECEIVER_RECEIPT_SIGNING_KEY_FILE:-}" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_RECEIPT_SIGNING_KEY_FILE")" == "0:0:400" ]]; then
  if openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -check -noout >/dev/null 2>&1 \
    && openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -text_pub -noout 2>/dev/null \
      | grep -Fqi 'ED25519'; then
    pass "receiver-only Ed25519 receipt signing key"
  else
    fail "receipt signing private-key contents"
  fi
else
  fail "receipt signing private-key ownership or mode"
fi
if [[ -f "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE:-}" \
  && ! -L "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE:-}" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE")" == "0:0:644" \
  && "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256:-}" =~ ^[a-f0-9]{64}$ \
  && ! "${RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256:-}" =~ ^0+$ ]]; then
  derived_receipt_public_key="$(mktemp)"
  if openssl pkey -pubin -in "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" -pubcheck -noout >/dev/null 2>&1 \
    && openssl pkey -in "$RECEIVER_RECEIPT_SIGNING_KEY_FILE" -pubout -out "$derived_receipt_public_key" \
    && cmp -s -- "$derived_receipt_public_key" "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" \
    && [[ "$(sha256sum "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" | awk '{print $1}')" \
      == "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256" ]]; then
    pass "pinned receipt signing public key matches receiver private key"
  else
    fail "receipt signing public-key identity"
  fi
  rm -f -- "$derived_receipt_public_key"
else
  fail "receipt signing public-key ownership, mode, or fingerprint"
fi
trusted_receipt_key_count=0
if [[ "$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY" == /* \
  && -d "$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY" \
  && ! -L "$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY" \
  && "$(stat -c '%u:%g:%a' "$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY")" == "0:0:755" ]]; then
  while IFS= read -r -d '' trusted_receipt_key; do
    trusted_receipt_key_name="$(basename -- "$trusted_receipt_key")"
    trusted_receipt_key_fingerprint="${trusted_receipt_key_name%.pem}"
    if [[ "$trusted_receipt_key_fingerprint" =~ ^[a-f0-9]{64}$ \
      && ! "$trusted_receipt_key_fingerprint" =~ ^0+$ \
      && -f "$trusted_receipt_key" && ! -L "$trusted_receipt_key" \
      && "$(stat -c '%u:%g:%a' "$trusted_receipt_key")" == "0:0:644" \
      && "$(sha256sum "$trusted_receipt_key" | awk '{print $1}')" == "$trusted_receipt_key_fingerprint" ]] \
      && openssl pkey -pubin -in "$trusted_receipt_key" -pubcheck -noout >/dev/null 2>&1 \
      && openssl pkey -pubin -in "$trusted_receipt_key" -text_pub -noout 2>/dev/null \
        | grep -Fqi 'ED25519'; then
      trusted_receipt_key_count=$((trusted_receipt_key_count + 1))
    else
      fail "trusted receipt public-key filename, ownership, fingerprint, or contents"
    fi
  done < <(find "$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY" -mindepth 1 -maxdepth 1 \
    \( -type f -o -type l \) -name '*.pem' -print0 2>/dev/null)
  active_trusted_receipt_key="$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY/$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256.pem"
  if [[ -f "$active_trusted_receipt_key" && ! -L "$active_trusted_receipt_key" ]] \
    && cmp -s -- "$RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_FILE" "$active_trusted_receipt_key"; then
    pass "active receipt key is present in the retained trusted key ring"
  else
    fail "active receipt key is absent from the retained trusted key ring"
  fi
  (( trusted_receipt_key_count > 0 )) \
    && pass "trusted receipt public-key ring" \
    || fail "trusted receipt public-key ring is empty"
else
  fail "trusted receipt public-key ring ownership or mode"
fi
if [[ -f "${RECEIVER_ALLOWED_REVISIONS_FILE:-}" && ! -L "${RECEIVER_ALLOWED_REVISIONS_FILE:-}" && "$(stat -c '%u:%g:%a' "$RECEIVER_ALLOWED_REVISIONS_FILE")" == "0:0:644" ]]; then
  invalid_revisions="$(awk 'NF && ($1 !~ /^([a-f0-9]{40}|[a-f0-9]{64})$/ || $1 ~ /^0+$/) { count++ } END { print count+0 }' "$RECEIVER_ALLOWED_REVISIONS_FILE")"
  [[ "$invalid_revisions" == "0" && -s "$RECEIVER_ALLOWED_REVISIONS_FILE" ]] && pass "non-empty application revision allowlist" || fail "application revision allowlist contents"
else
  fail "application revision allowlist file"
fi

if [[ -f "$AUTHORIZED_KEYS_FILE" && ! -L "$AUTHORIZED_KEYS_FILE" ]]; then
  [[ "$(stat -c '%u:%g:%a' "$AUTHORIZED_KEYS_FILE")" == "0:0:644" ]] && pass "root-owned, non-writable authorized key outside chroot" || fail "authorized key ownership or mode"
  grep -Eq '^from="[^"[:space:]]+",restrict,command="internal-sftp -d /incoming -u 077" (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com) ' "$AUTHORIZED_KEYS_FILE" && pass "source-restricted SFTP-only authorized key" || fail "authorized key restrictions"
else
  fail "authorized key file"
fi

if sshd -t; then
  pass "sshd configuration syntax"
  effective_sshd="$(sshd -T -C "user=$RECEIVER_USER,host=business-finlynq-backup,addr=${RECEIVER_SOURCE_PROBE:-127.0.0.1}")"
  for expected_setting in \
    "chrootdirectory $RECEIVER_ROOT" \
    "forcecommand internal-sftp -d /incoming -u 077" \
    "authenticationmethods publickey" \
    "passwordauthentication no" \
    "kbdinteractiveauthentication no" \
    "permittty no" \
    "disableforwarding yes" \
    "authorizedkeysfile /etc/ssh/authorized_keys/%u"; do
    grep -Fqx "$expected_setting" <<< "$effective_sshd" || fail "effective sshd setting: $expected_setting"
  done
else
  fail "sshd configuration syntax"
fi

for timer_name in business-finlynq-backup-receiver.timer business-finlynq-backup-receiver-health.timer; do
  systemctl is-enabled --quiet "$timer_name" && pass "$timer_name enabled" || fail "$timer_name enabled"
  systemctl is-active --quiet "$timer_name" && pass "$timer_name active" || fail "$timer_name active"
done
systemctl is-failed --quiet business-finlynq-backup-receiver.service && fail "receiver ingestion service failed" || pass "receiver ingestion service not failed"

queued_manifests="$(find "$RECEIVER_ROOT/incoming" -mindepth 1 -maxdepth 1 -name 'business_finlynq_*.manifest.json' -printf '.' 2>/dev/null | wc -c)"
quarantined_sets="$(find "$RECEIVER_ROOT/quarantine" -mindepth 1 -maxdepth 1 -type d -printf '.' 2>/dev/null | wc -c)"
printf 'STATUS queued_manifests=%s quarantined_sets=%s filesystem=%s\n' "$queued_manifests" "$quarantined_sets" "$(df -h --output=pcent "$RECEIVER_ROOT" | tail -n 1 | xargs)"

load_validated_receipt_candidate() {
  local candidate_manifest="$1"
  local candidate_prefix candidate_receipt candidate_receipt_signature
  local manifest_name manifest_created_at manifest_archive manifest_bytes manifest_sha256
  local manifest_source_revision manifest_tool_revision receipt_accepted_at
  local receipt_epoch recovery_point_epoch receipt_signing_key_sha256 trusted_receipt_key_path

  [[ -f "$candidate_manifest" && ! -L "$candidate_manifest" \
    && "$(stat -c '%u:%g:%a' "$candidate_manifest")" == "0:0:400" ]] || return 1
  candidate_prefix="${candidate_manifest%.manifest.json}"
  candidate_receipt="${candidate_prefix}.receiver-receipt.json"
  candidate_receipt_signature="${candidate_receipt}.sig"
  [[ -f "$candidate_receipt" && ! -L "$candidate_receipt" \
    && "$(stat -c '%u:%g:%a' "$candidate_receipt")" == "0:0:400" \
    && -f "$candidate_receipt_signature" && ! -L "$candidate_receipt_signature" \
    && "$(stat -c '%u:%g:%a:%s' "$candidate_receipt_signature")" == "0:0:400:64" ]] \
    || return 1

  manifest_name="$(basename -- "$candidate_manifest")"
  manifest_created_at="$(jq -r '.createdAt // empty' "$candidate_manifest")"
  manifest_archive="$(jq -r '.encryptedArchive // empty' "$candidate_manifest")"
  manifest_bytes="$(jq -r '.encryptedBytes // empty' "$candidate_manifest")"
  manifest_sha256="$(jq -r '.sha256 // empty' "$candidate_manifest")"
  manifest_source_revision="$(jq -r '.sourceApplicationRevision // .applicationRevision // empty' "$candidate_manifest")"
  manifest_tool_revision="$(jq -r '.backupToolRevision // .applicationRevision // empty' "$candidate_manifest")"
  receipt_signing_key_sha256="$(jq -r '.signingKeySha256 // empty' "$candidate_receipt")"
  [[ "$receipt_signing_key_sha256" =~ ^[a-f0-9]{64}$ \
    && ! "$receipt_signing_key_sha256" =~ ^0+$ ]] || return 1
  trusted_receipt_key_path="$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY/$receipt_signing_key_sha256.pem"
  [[ -f "$trusted_receipt_key_path" && ! -L "$trusted_receipt_key_path" \
    && "$(stat -c '%u:%g:%a' "$trusted_receipt_key_path")" == "0:0:644" \
    && "$(sha256sum "$trusted_receipt_key_path" | awk '{print $1}')" == "$receipt_signing_key_sha256" ]] \
    || return 1
  jq -e \
    --arg manifest "$manifest_name" \
    --arg createdAt "$manifest_created_at" \
    --arg archive "$manifest_archive" \
    --argjson bytes "$manifest_bytes" \
    --arg sha256 "$manifest_sha256" \
    --arg sourceRevision "$manifest_source_revision" \
    --arg toolRevision "$manifest_tool_revision" \
    --arg signingKeySha256 "$receipt_signing_key_sha256" \
    'keys == ["acceptedAt", "backupToolRevision", "createdAt", "encryptedArchive", "encryptedBytes", "manifest", "product", "receiptType", "result", "schemaVersion", "sha256", "signatureAlgorithm", "signingKeySha256", "sourceApplicationRevision"]
      and .schemaVersion == 2
      and .product == "business-finlynq"
      and .receiptType == "offsite-receiver-acceptance"
      and .result == "accepted"
      and .signatureAlgorithm == "ed25519"
      and .signingKeySha256 == $signingKeySha256
      and (.acceptedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and .manifest == $manifest
      and .createdAt == $createdAt
      and .encryptedArchive == $archive
      and .encryptedBytes == $bytes
      and .sha256 == $sha256
      and .sourceApplicationRevision == $sourceRevision
      and .backupToolRevision == $toolRevision' "$candidate_receipt" >/dev/null \
    || return 1
  openssl pkeyutl -verify -rawin -pubin \
    -inkey "$trusted_receipt_key_path" \
    -in "$candidate_receipt" \
    -sigfile "$candidate_receipt_signature" >/dev/null 2>&1 \
    || return 1

  candidate_signed_recovery_point_at="$(jq -r '.createdAt' "$candidate_receipt")"
  receipt_accepted_at="$(jq -r '.acceptedAt' "$candidate_receipt")"
  receipt_epoch="$(date -u --date="$receipt_accepted_at" +%s 2>/dev/null)" || return 1
  recovery_point_epoch="$(date -u --date="$candidate_signed_recovery_point_at" +%s 2>/dev/null)" \
    || return 1
  (( recovery_point_epoch <= receipt_epoch && receipt_epoch <= receiver_current_epoch )) \
    || return 1

  candidate_manifest_path="$candidate_manifest"
  candidate_receipt_path="$candidate_receipt"
  candidate_receipt_signature_path="$candidate_receipt_signature"
  candidate_recovery_point_epoch="$recovery_point_epoch"
}

validate_complete_vault_set() {
  local selected_manifest="$1"
  local selected_receipt="$2"
  local selected_receipt_signature="$3"
  local set_directory manifest_name prefix archive_name checksum_name archive_path checksum_path
  local manifest_bytes manifest_sha256 actual_bytes actual_sha256 entry_count entry_path
  local expected_checksum_line
  local -a checksum_lines

  set_directory="$(dirname -- "$selected_manifest")"
  manifest_name="$(basename -- "$selected_manifest")"
  [[ "$manifest_name" =~ ^(business_finlynq_[0-9]{8}T[0-9]{6}Z_[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})\.manifest\.json$ ]] \
    || return 1
  prefix="${BASH_REMATCH[1]}"
  archive_name="$prefix.dump.age"
  checksum_name="$prefix.sha256"
  archive_path="$set_directory/$archive_name"
  checksum_path="$set_directory/$checksum_name"
  entry_count="$(find "$set_directory" -mindepth 1 -maxdepth 1 -printf '.' | wc -c)"
  [[ "$entry_count" == "5" ]] || return 1
  for entry_path in "$archive_path" "$checksum_path" "$selected_manifest" \
    "$selected_receipt" "$selected_receipt_signature"; do
    [[ -f "$entry_path" && ! -L "$entry_path" \
      && "$(stat -c '%u:%g:%a:%h' "$entry_path")" == "0:0:400:1" ]] \
      || return 1
  done
  [[ "$(stat -c '%s' "$selected_receipt_signature")" == "64" ]] || return 1

  manifest_bytes="$(jq -r '.encryptedBytes // empty' "$selected_manifest")"
  manifest_sha256="$(jq -r '.sha256 // empty' "$selected_manifest")"
  [[ "$(jq -r '.encryptedArchive // empty' "$selected_manifest")" == "$archive_name" \
    && "$manifest_bytes" =~ ^[1-9][0-9]*$ \
    && "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || return 1
  actual_bytes="$(stat -c '%s' "$archive_path")"
  [[ "$actual_bytes" == "$manifest_bytes" ]] || return 1
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  [[ "$actual_sha256" == "$manifest_sha256" ]] || return 1
  expected_checksum_line="$actual_sha256  $archive_name"
  mapfile -t checksum_lines <"$checksum_path"
  [[ "${#checksum_lines[@]}" -eq 1 && "${checksum_lines[0]}" == "$expected_checksum_line" ]] \
    || return 1
  [[ "$(jq -r '.encryptedBytes // empty' "$selected_receipt")" == "$actual_bytes" \
    && "$(jq -r '.sha256 // empty' "$selected_receipt")" == "$actual_sha256" ]] \
    || return 1
}

receiver_current_epoch="$(date +%s)"
latest_manifest=""
latest_receipt=""
latest_receipt_signature=""
latest_signed_recovery_point_at=""
latest_recovery_point_epoch=-1
while IFS= read -r -d '' candidate_manifest; do
  if load_validated_receipt_candidate "$candidate_manifest"; then
    if (( candidate_recovery_point_epoch > latest_recovery_point_epoch )); then
      latest_manifest="$candidate_manifest_path"
      latest_receipt="$candidate_receipt_path"
      latest_receipt_signature="$candidate_receipt_signature_path"
      latest_signed_recovery_point_at="$candidate_signed_recovery_point_at"
      latest_recovery_point_epoch="$candidate_recovery_point_epoch"
    fi
  else
    fail "vaulted backup receipt, binding, signature, or timestamp"
  fi
done < <(find "$RECEIVER_ROOT/vault" -mindepth 5 -maxdepth 5 -type f \
  -name 'business_finlynq_*.manifest.json' -print0 2>/dev/null)

if [[ -n "$latest_manifest" ]]; then
  printf 'STATUS latest_manifest=%s\n' "$latest_manifest"
  if validate_complete_vault_set \
    "$latest_manifest" "$latest_receipt" "$latest_receipt_signature"; then
    pass "latest receiver acceptance receipt, detached signature, and rehashed complete vault set"
  else
    fail "newest signed vault set is missing, unsafe, size-mismatched, or checksum-corrupt"
  fi
  if latest_recovery_point_age_seconds="$(
    business_finlynq_recovery_point_age_seconds \
      "$latest_signed_recovery_point_at" "$receiver_current_epoch"
  )"; then
    printf 'STATUS latest_signed_recovery_point_at=%s\n' "$latest_signed_recovery_point_at"
    printf 'STATUS latest_recovery_point_age_seconds=%s\n' "$latest_recovery_point_age_seconds"
    if business_finlynq_recovery_point_is_fresh \
      "$latest_recovery_point_age_seconds" "$max_age_hours"; then
      pass "latest signed recovery point age"
    else
      fail "latest signed recovery point is not younger than $max_age_hours hours"
    fi
  else
    fail "latest signed recovery-point timestamp"
  fi
elif [[ "$require_backup" == "true" ]]; then
  fail "no accepted backup exists"
else
  warn "no accepted backup exists yet"
fi

if (( failures > 0 )); then
  printf 'Receiver verification failed: failures=%s warnings=%s\n' "$failures" "$warnings" >&2
  exit 1
fi
printf 'Receiver verification passed: failures=0 warnings=%s\n' "$warnings"
