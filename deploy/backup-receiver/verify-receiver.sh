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

require_backup="false"
max_age_hours="24"
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
[[ "$max_age_hours" =~ ^[0-9]+$ && "$max_age_hours" -gt 0 ]] || { printf '%s\n' "max age must be a positive integer" >&2; exit 2; }
[[ "$EUID" -eq 0 ]] || { printf '%s\n' "Run the receiver verifier as root" >&2; exit 1; }

failures=0
warnings=0
pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }

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

systemctl is-enabled --quiet business-finlynq-backup-receiver.timer && pass "receiver timer enabled" || fail "receiver timer enabled"
systemctl is-active --quiet business-finlynq-backup-receiver.timer && pass "receiver timer active" || fail "receiver timer active"
systemctl is-failed --quiet business-finlynq-backup-receiver.service && fail "receiver ingestion service failed" || pass "receiver ingestion service not failed"

queued_manifests="$(find "$RECEIVER_ROOT/incoming" -mindepth 1 -maxdepth 1 -name 'business_finlynq_*.manifest.json' -printf '.' 2>/dev/null | wc -c)"
quarantined_sets="$(find "$RECEIVER_ROOT/quarantine" -mindepth 1 -maxdepth 1 -type d -printf '.' 2>/dev/null | wc -c)"
printf 'STATUS queued_manifests=%s quarantined_sets=%s filesystem=%s\n' "$queued_manifests" "$quarantined_sets" "$(df -h --output=pcent "$RECEIVER_ROOT" | tail -n 1 | xargs)"

latest_manifest="$(find "$RECEIVER_ROOT/vault" -mindepth 5 -maxdepth 5 -type f -name 'business_finlynq_*.manifest.json' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1{s/^[^ ]* //;p;}')"
if [[ -n "$latest_manifest" ]]; then
  latest_age_seconds="$(( $(date +%s) - $(stat -c '%Y' "$latest_manifest") ))"
  latest_age_hours="$(( latest_age_seconds / 3600 ))"
  printf 'STATUS latest_manifest=%s age_hours=%s\n' "$latest_manifest" "$latest_age_hours"
  (( latest_age_seconds <= max_age_hours * 3600 )) && pass "latest accepted backup age" || fail "latest accepted backup is older than $max_age_hours hours"
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
