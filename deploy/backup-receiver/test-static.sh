#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
provisioner="$script_directory/provision-ubuntu-24.04.sh"
ingester="$script_directory/ingest-backups.sh"
verifier="$script_directory/verify-receiver.sh"
service="$script_directory/business-finlynq-backup-receiver.service"
timer="$script_directory/business-finlynq-backup-receiver.timer"
backup_source="$script_directory/../backup/run-backup.sh"

for script_path in "$provisioner" "$ingester" "$verifier" "$script_directory/test-static.sh"; do
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
require_text "$ingester" 'Moving the manifest first'
require_text "$ingester" 'grep -Fxq -- "$manifest_revision" "$RECEIVER_ALLOWED_REVISIONS_FILE"'
require_text "$ingester" 'archive_hash="$(sha256sum "$archive_path"'
require_text "$ingester" 'readonly MAX_BACKUP_DURATION_SECONDS="86400"'
require_text "$ingester" 'manifest_epoch - prefix_epoch <= MAX_BACKUP_DURATION_SECONDS'
require_text "$ingester" 'RECEIVER_RETENTION_DAYS" == "60"'
require_text "$backup_source" 'created_at="${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2}T${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2}Z"'
require_text "$service" 'ReadWritePaths=/srv/business-finlynq-backup /var/lib/business-finlynq-backup-receiver'
require_text "$service" 'RestrictAddressFamilies=AF_UNIX'
require_text "$timer" 'OnUnitInactiveSec=5m'
require_text "$script_directory/README.md" 'host_key_algorithms = ssh-ed25519'

if grep -ERn --exclude='test-static.sh' --exclude='README.md' --exclude='*.service' --exclude='*.timer' '(AGE-SECRET-KEY|ORGANIZATION_ROOT_KEK|IDENTITY_SECRET|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY)' "$script_directory"; then
  printf '%s\n' 'Receiver assets must not contain encryption or recovery keys' >&2
  exit 1
fi

printf '%s\n' 'Backup receiver static security checks passed'
