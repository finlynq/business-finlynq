#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
provisioner="$script_directory/provision-ubuntu-24.04.sh"
ingester="$script_directory/ingest-backups.sh"
verifier="$script_directory/verify-receiver.sh"
health_checker="$script_directory/check-health.sh"
freshness_library="$script_directory/recovery-point-freshness.sh"
notifier="$script_directory/notify-failure.sh"
quarantine_acknowledger="$script_directory/acknowledge-quarantine.sh"
service="$script_directory/business-finlynq-backup-receiver.service"
timer="$script_directory/business-finlynq-backup-receiver.timer"
health_service="$script_directory/business-finlynq-backup-receiver-health.service"
health_timer="$script_directory/business-finlynq-backup-receiver-health.timer"
notify_service="$script_directory/business-finlynq-backup-receiver-notify@.service"
backup_source="$script_directory/../backup/run-backup.sh"

for script_path in \
  "$provisioner" "$ingester" "$verifier" "$health_checker" "$notifier" \
  "$quarantine_acknowledger" \
  "$freshness_library" "$script_directory/test-static.sh"; do
  bash -n "$script_path"
done

require_text() {
  local file_path="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file_path" || {
    printf 'Missing required receiver invariant in %s: %s\n' "$file_path" "$expected" >&2
    exit 1
  }
}

require_order() {
  local file_path="$1"
  local first="$2"
  local second="$3"
  local first_line second_line
  first_line="$(grep -Fn -m1 -- "$first" "$file_path" | cut -d: -f1)"
  second_line="$(grep -Fn -m1 -- "$second" "$file_path" | cut -d: -f1)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] || {
    printf 'Receiver invariant is out of order in %s: %s before %s\n' \
      "$file_path" "$first" "$second" >&2
    exit 1
  }
}

require_text "$provisioner" 'business-finlynq-backup-vault-10GiB.ext4.img'
require_text "$provisioner" 'readonly IMAGE_BYTES="10737418240"'
require_text "$provisioner" 'created_image="true"'
require_text "$provisioner" 'mkfs.ext4 -q -F -L "$FILESYSTEM_LABEL" "$IMAGE_PATH"'
require_text "$provisioner" 'Receiver root is already a non-loop mount; refusing to touch it'
require_text "$provisioner" 'from="%s",restrict,command="internal-sftp -d /incoming -u 077"'
require_text "$provisioner" 'install -o root -g root -m 0644 "$authorized_key_temporary" "$AUTHORIZED_KEYS_FILE"'
require_text "$provisioner" 'AuthorizedKeysFile /etc/ssh/authorized_keys/%u'
require_text "$provisioner" 'if ! sshd -t; then'
require_text "$provisioner" 'systemctl reload ssh.service'
require_text "$provisioner" 'openssl genpkey -algorithm ED25519'
require_text "$provisioner" 'Configured receipt signing key is missing; refusing to rotate trust automatically'
require_text "$provisioner" 'RECEIVER_RECEIPT_SIGNING_PUBLIC_KEY_SHA256='
require_text "$provisioner" 'RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY='
require_text "$provisioner" 'deliberately never prunes older trust pins during rotation'
require_text "$provisioner" 'acknowledge-quarantine.sh" "$INSTALL_DIRECTORY/acknowledge-quarantine.sh"'
require_text "$provisioner" 'recovery-point-freshness.sh" "$INSTALL_DIRECTORY/recovery-point-freshness.sh"'
require_text "$ingester" 'Moving the manifest first'
require_text "$ingester" 'grep -Fxq -- "$manifest_revision" "$RECEIVER_ALLOWED_REVISIONS_FILE"'
require_text "$ingester" 'grep -Fxq -- "$manifest_tool_revision" "$RECEIVER_ALLOWED_REVISIONS_FILE"'
require_text "$ingester" '(.sourceApplicationRevision // .applicationRevision) == .applicationRevision'
require_text "$ingester" 'archive_hash="$(sha256sum "$archive_path"'
require_text "$ingester" 'readonly MAX_BACKUP_DURATION_SECONDS="86400"'
require_text "$ingester" 'manifest_epoch - prefix_epoch <= MAX_BACKUP_DURATION_SECONDS'
require_text "$ingester" 'manifest_epoch <= receiver_now_epoch'
require_text "$ingester" 'future_recovery_point'
require_text "$ingester" 'cp --reflink=never --sparse=never --no-preserve=all'
require_text "$ingester" 'now-unlinked source inode'
require_order "$ingester" 'seal_claim_artifacts "$claim_directory" "$prefix"' 'validate_set "$sealed_claim_directory"'
require_text "$ingester" 'RECEIVER_RETENTION_DAYS" == "60"'
require_text "$ingester" 'receiptType: "offsite-receiver-acceptance"'
require_text "$ingester" 'schemaVersion: 2'
require_text "$ingester" 'signatureAlgorithm: "ed25519"'
require_text "$ingester" 'openssl pkeyutl -sign -rawin'
require_text "$ingester" 'openssl pkeyutl -verify -rawin -pubin'
require_text "$ingester" 'sourceApplicationRevision: (.sourceApplicationRevision // .applicationRevision)'
require_text "$ingester" 'backupToolRevision: (.backupToolRevision // .applicationRevision)'
require_text "$verifier" 'latest receiver acceptance receipt'
require_text "$verifier" 'detached signature'
require_text "$verifier" 'RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY'
require_text "$verifier" 'trusted_receipt_key_path="$RECEIVER_TRUSTED_RECEIPT_KEYS_DIRECTORY/$receipt_signing_key_sha256.pem"'
require_text "$verifier" 'validate_complete_vault_set'
require_text "$verifier" 'actual_sha256="$(sha256sum "$archive_path"'
require_text "$verifier" 'entry_count" == "5"'
require_text "$verifier" 'newest signed vault set is missing, unsafe, size-mismatched, or checksum-corrupt'
require_text "$verifier" 'business-finlynq-backup-receiver-health.timer'
require_text "$verifier" 'candidate_recovery_point_epoch > latest_recovery_point_epoch'
require_text "$verifier" 'STATUS latest_signed_recovery_point_at='
require_text "$verifier" 'business_finlynq_recovery_point_is_fresh'
require_text "$verifier" 'max_age_hours="6"'
require_text "$verifier" 'max_age_hours" -le 6'
require_text "$health_checker" '--require-backup --max-age-hours "$RECEIVER_HEALTH_MAX_AGE_HOURS"'
require_text "$health_checker" 'RECEIVER_HEALTH_MAX_AGE_HOURS" -le 6'
require_text "$health_checker" 'quarantined_sets > 0'
require_text "$health_checker" '.acknowledged.json'
require_text "$health_checker" 'business_finlynq_backup_receiver_quarantine_acknowledged_sets'
require_text "$health_checker" 'STATUS latest_signed_recovery_point_at='
require_text "$health_checker" 'business_finlynq_recovery_point_age_seconds "$latest_signed_recovery_point_at"'
require_text "$health_checker" 'business_finlynq_recovery_point_is_fresh'
require_text "$health_checker" 'business_finlynq_backup_receiver_health_success'
require_text "$health_checker" 'mv -f -- "$metrics_temporary" "$RECEIVER_HEALTH_METRICS_FILE"'
require_text "$health_checker" '( -e "$metrics_directory" && ! -d "$metrics_directory" )'
require_text "$health_checker" '( -e "$RECEIVER_HEALTH_METRICS_FILE" && ! -f "$RECEIVER_HEALTH_METRICS_FILE" )'
require_order "$health_checker" 'for command_name in ' 'stat -c '\''%u:%g:%a'\'' "$CONFIG_FILE"'
if grep -Fq -- '-printf '\''%T@ %p\n'\''' "$verifier"; then
  printf '%s\n' 'Receiver verifier selects backup freshness by manifest mtime' >&2
  exit 1
fi
if grep -Fq -- '.acceptedAt' "$health_checker"; then
  printf '%s\n' 'Receiver health derives freshness from receipt acceptance time' >&2
  exit 1
fi
require_text "$notifier" 'Receiver alert webhook must be one HTTPS line'
require_text "$notifier" 'mapfile -t webhook_lines'
require_text "$notifier" '| curl --config -'
require_text "$notifier" '"$(stat -c '\''%u:%g:%a'\'' "$CONFIG_FILE")" == "0:0:644"'
require_order "$notifier" 'for command_name in ' 'stat -c '\''%u:%g:%a'\'' "$CONFIG_FILE"'
if grep -Eq 'curl[^|]*\$webhook_url|curl[^|]*"\$webhook_url"' "$notifier"; then
  printf '%s\n' 'Receiver notifier exposes its secret webhook URL in curl argv' >&2
  exit 1
fi
require_text "$quarantine_acknowledger" 'receiver-quarantine-review'
require_text "$quarantine_acknowledger" 'retained receiver quarantine'
require_text "$backup_source" 'created_at="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2}T${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2}Z"'
require_text "$service" 'ReadWritePaths=/srv/business-finlynq-backup /var/lib/business-finlynq-backup-receiver'
require_text "$service" 'RestrictAddressFamilies=AF_UNIX'
require_text "$service" 'OnFailure=business-finlynq-backup-receiver-notify@%n.service'
require_text "$timer" 'OnUnitInactiveSec=5m'
require_text "$health_service" 'StateDirectory=business-finlynq-backup-receiver-metrics'
require_text "$health_service" 'OnFailure=business-finlynq-backup-receiver-notify@%n.service'
require_text "$health_service" 'RestrictAddressFamilies=AF_UNIX'
require_text "$health_timer" 'OnUnitInactiveSec=5m'
require_text "$notify_service" 'RestrictAddressFamilies=AF_INET AF_INET6'
require_text "$notify_service" 'ProtectProc=invisible'
require_text "$notify_service" 'ProcSubset=pid'
require_text "$script_directory/README.md" 'host_key_algorithms = ssh-ed25519'
require_text "$script_directory/README.md" 'receiver-generated acceptance receipt'
require_text "$script_directory/README.md" 'signed recovery-point `createdAt`'
require_text "$script_directory/README.md" 'trusted public-key ring'
require_text "$script_directory/README.md" 'acknowledge-quarantine.sh'

for command_name in cp date openssl sed sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Missing receipt-signature test command: %s\n' "$command_name" >&2
    exit 1
  }
done
# shellcheck disable=SC1090
source "$freshness_library"
signature_fixture="$(mktemp -d "${TMPDIR:-/tmp}/business-finlynq-receipt-signature.XXXXXX")"
cleanup_signature_fixture() {
  case "$signature_fixture" in
    "${TMPDIR:-/tmp}"/business-finlynq-receipt-signature.*) rm -rf -- "$signature_fixture" ;;
    *) printf '%s\n' 'Refusing to remove unexpected receipt-signature fixture' >&2 ;;
  esac
}
trap cleanup_signature_fixture EXIT INT TERM
openssl genpkey -algorithm ED25519 -out "$signature_fixture/private.pem"
openssl pkey -in "$signature_fixture/private.pem" -pubout -out "$signature_fixture/public.pem"
old_key_fingerprint="$(sha256sum "$signature_fixture/public.pem" | awk '{print $1}')"
mkdir "$signature_fixture/trusted"
cp -- "$signature_fixture/public.pem" "$signature_fixture/trusted/$old_key_fingerprint.pem"
openssl genpkey -algorithm ED25519 -out "$signature_fixture/current-private.pem"
openssl pkey -in "$signature_fixture/current-private.pem" -pubout -out "$signature_fixture/current-public.pem"
current_key_fingerprint="$(sha256sum "$signature_fixture/current-public.pem" | awk '{print $1}')"
cp -- "$signature_fixture/current-public.pem" "$signature_fixture/trusted/$current_key_fingerprint.pem"
printf '%s\n' "{\"acceptedAt\":\"2026-08-31T07:00:00Z\",\"backupToolRevision\":\"1111111111111111111111111111111111111111\",\"createdAt\":\"2026-08-31T00:00:00Z\",\"encryptedArchive\":\"business_finlynq_fixture.dump.age\",\"encryptedBytes\":1234,\"manifest\":\"business_finlynq_fixture.manifest.json\",\"product\":\"business-finlynq\",\"receiptType\":\"offsite-receiver-acceptance\",\"result\":\"accepted\",\"schemaVersion\":2,\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signatureAlgorithm\":\"ed25519\",\"signingKeySha256\":\"$old_key_fingerprint\",\"sourceApplicationRevision\":\"1111111111111111111111111111111111111111\"}" >"$signature_fixture/receipt.json"
openssl pkeyutl -sign -rawin \
  -inkey "$signature_fixture/private.pem" \
  -in "$signature_fixture/receipt.json" \
  -out "$signature_fixture/receipt.json.sig"
openssl pkeyutl -verify -rawin -pubin \
  -inkey "$signature_fixture/trusted/$old_key_fingerprint.pem" \
  -in "$signature_fixture/receipt.json" \
  -sigfile "$signature_fixture/receipt.json.sig" >/dev/null
if openssl pkeyutl -verify -rawin -pubin \
  -inkey "$signature_fixture/trusted/$current_key_fingerprint.pem" \
  -in "$signature_fixture/receipt.json" \
  -sigfile "$signature_fixture/receipt.json.sig" >/dev/null 2>&1; then
  printf '%s\n' 'A rotated current key incorrectly verified a receipt signed by the retained old key' >&2
  exit 1
fi
sed "s/$old_key_fingerprint/$current_key_fingerprint/" \
  "$signature_fixture/receipt.json" >"$signature_fixture/current-receipt.json"
openssl pkeyutl -sign -rawin \
  -inkey "$signature_fixture/current-private.pem" \
  -in "$signature_fixture/current-receipt.json" \
  -out "$signature_fixture/current-receipt.json.sig"
openssl pkeyutl -verify -rawin -pubin \
  -inkey "$signature_fixture/trusted/$current_key_fingerprint.pem" \
  -in "$signature_fixture/current-receipt.json" \
  -sigfile "$signature_fixture/current-receipt.json.sig" >/dev/null
fixture_now_epoch="$(date -u --date='2026-08-31T07:00:00Z' +%s)"
stale_recovery_point_age_seconds="$(
  business_finlynq_recovery_point_age_seconds '2026-08-31T00:00:00Z' "$fixture_now_epoch"
)"
[[ "$stale_recovery_point_age_seconds" == "25200" ]] || {
  printf '%s\n' 'Signed receipt recovery-point age fixture returned the wrong age' >&2
  exit 1
}
if business_finlynq_recovery_point_is_fresh "$stale_recovery_point_age_seconds" 6; then
  printf '%s\n' 'Delayed signed stale backup satisfied the six-hour freshness check' >&2
  exit 1
fi
if business_finlynq_recovery_point_age_seconds \
  '2026-08-31T07:00:01Z' "$fixture_now_epoch" >/dev/null 2>&1; then
  printf '%s\n' 'Future-dated recovery point passed receiver clock validation' >&2
  exit 1
fi
sed 's/2026-08-31T00:00:00Z/2026-08-31T06:59:59Z/' \
  "$signature_fixture/receipt.json" >"$signature_fixture/receipt.json.tampered"
mv -- "$signature_fixture/receipt.json.tampered" "$signature_fixture/receipt.json"
if openssl pkeyutl -verify -rawin -pubin \
  -inkey "$signature_fixture/trusted/$old_key_fingerprint.pem" \
  -in "$signature_fixture/receipt.json" \
  -sigfile "$signature_fixture/receipt.json.sig" >/dev/null 2>&1; then
  printf '%s\n' 'Detached receiver receipt signature accepted tampered content' >&2
  exit 1
fi

# Model the SFTP race directly: an uploader keeps a writable descriptor open
# while ingestion copies into a distinct non-reflink inode. Mutation through
# that old descriptor must not change the sealed bytes that are hashed/signed.
printf 'age-encryption.org/v1\nimmutable-ciphertext\n' >"$signature_fixture/uploader.dump.age"
exec 8<>"$signature_fixture/uploader.dump.age"
install -m 0600 /dev/null "$signature_fixture/sealed.dump.age"
cp --reflink=never --sparse=never --no-preserve=all -- \
  "$signature_fixture/uploader.dump.age" "$signature_fixture/sealed.dump.age"
chmod 0400 "$signature_fixture/sealed.dump.age"
sealed_hash_before="$(sha256sum "$signature_fixture/sealed.dump.age" | awk '{print $1}')"
printf 'attacker-write-after-claim' >&8
exec 8>&-
sealed_hash_after="$(sha256sum "$signature_fixture/sealed.dump.age" | awk '{print $1}')"
uploader_hash_after="$(sha256sum "$signature_fixture/uploader.dump.age" | awk '{print $1}')"
[[ "$sealed_hash_before" == "$sealed_hash_after" && "$uploader_hash_after" != "$sealed_hash_after" ]] || {
  printf '%s\n' 'Uploader-held writable descriptor changed the sealed receiver inode' >&2
  exit 1
}

# Exercise the newest-set completeness contract with deterministic fixtures.
vault_fixture="$signature_fixture/vault/business_finlynq_20260831T000000Z_business_finlynq"
mkdir -p "$vault_fixture"
vault_prefix="business_finlynq_20260831T000000Z_business_finlynq"
printf 'age-encryption.org/v1\nfixture-ciphertext\n' >"$vault_fixture/$vault_prefix.dump.age"
vault_hash="$(sha256sum "$vault_fixture/$vault_prefix.dump.age" | awk '{print $1}')"
vault_bytes="$(stat -c '%s' "$vault_fixture/$vault_prefix.dump.age")"
printf '%s  %s.dump.age\n' "$vault_hash" "$vault_prefix" >"$vault_fixture/$vault_prefix.sha256"
printf '{"encryptedArchive":"%s.dump.age","encryptedBytes":%s,"sha256":"%s"}\n' \
  "$vault_prefix" "$vault_bytes" "$vault_hash" >"$vault_fixture/$vault_prefix.manifest.json"
printf '{"encryptedBytes":%s,"sha256":"%s"}\n' \
  "$vault_bytes" "$vault_hash" >"$vault_fixture/$vault_prefix.receiver-receipt.json"
head -c 64 /dev/zero >"$vault_fixture/$vault_prefix.receiver-receipt.json.sig"
fixture_complete_set_is_valid() {
  local fixture_directory="$1" fixture_prefix="$2" expected_hash="$3" expected_bytes="$4"
  local archive="$fixture_directory/$fixture_prefix.dump.age"
  local checksum="$fixture_directory/$fixture_prefix.sha256"
  [[ "$(find "$fixture_directory" -mindepth 1 -maxdepth 1 -printf '.' | wc -c)" == "5" \
    && -f "$archive" && ! -L "$archive" \
    && -f "$checksum" && ! -L "$checksum" \
    && "$(stat -c '%s' "$archive")" == "$expected_bytes" \
    && "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_hash" \
    && "$(<"$checksum")" == "$expected_hash  $fixture_prefix.dump.age" ]]
}
fixture_complete_set_is_valid "$vault_fixture" "$vault_prefix" "$vault_hash" "$vault_bytes" \
  || { printf '%s\n' 'Complete newest vault fixture was rejected' >&2; exit 1; }
mv -- "$vault_fixture/$vault_prefix.dump.age" "$signature_fixture/missing.dump.age"
if fixture_complete_set_is_valid "$vault_fixture" "$vault_prefix" "$vault_hash" "$vault_bytes"; then
  printf '%s\n' 'Newest vault fixture remained valid after archive deletion' >&2
  exit 1
fi
mv -- "$signature_fixture/missing.dump.age" "$vault_fixture/$vault_prefix.dump.age"
printf 'corrupt' >>"$vault_fixture/$vault_prefix.dump.age"
if fixture_complete_set_is_valid "$vault_fixture" "$vault_prefix" "$vault_hash" "$vault_bytes"; then
  printf '%s\n' 'Newest vault fixture remained valid after archive corruption' >&2
  exit 1
fi

if grep -ERn --exclude='test-static.sh' --exclude='README.md' --exclude='*.service' --exclude='*.timer' '(AGE-SECRET-KEY|ORGANIZATION_ROOT_KEK|IDENTITY_SECRET|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY)' "$script_directory"; then
  printf '%s\n' 'Receiver assets must not contain encryption or recovery keys' >&2
  exit 1
fi

printf '%s\n' 'Backup receiver static security checks passed'
