#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly RECEIVER_USER="finlynq-backup"
readonly RECEIVER_GROUP="finlynq-backup"
readonly RECEIVER_ROOT="/srv/business-finlynq-backup"
readonly IMAGE_DIRECTORY="/var/lib/business-finlynq-backup-receiver"
readonly IMAGE_PATH="$IMAGE_DIRECTORY/business-finlynq-backup-vault-10GiB.ext4.img"
readonly IMAGE_BYTES="10737418240"
readonly FILESYSTEM_LABEL="bf_backup_vault"
readonly AUTHORIZED_KEYS_DIRECTORY="/etc/ssh/authorized_keys"
readonly AUTHORIZED_KEYS_FILE="$AUTHORIZED_KEYS_DIRECTORY/$RECEIVER_USER"
readonly SSHD_DROP_IN="/etc/ssh/sshd_config.d/00-business-finlynq-backup-receiver.conf"
readonly RECEIVER_CONFIG="/etc/business-finlynq/backup-receiver.conf"
readonly ALLOWED_REVISIONS_FILE="/etc/business-finlynq/backup-receiver-allowed-revisions"
readonly INSTALL_DIRECTORY="/usr/local/libexec/business-finlynq-backup-receiver"
readonly FSTAB_MARKER="# Business Finlynq backup receiver - dedicated 10 GiB loopback filesystem"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
public_key_file=""
source_cidr=""
allowed_revisions_input=""
created_image="false"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

ensure_receiver_fstab_entry() {
  local expected_entry
  expected_entry="$IMAGE_PATH $RECEIVER_ROOT ext4 loop,nodev,nosuid,noexec,noatime 0 2"
  if awk -v target="$RECEIVER_ROOT" '$1 !~ /^#/ && $2 == target { found=1 } END { exit !found }' /etc/fstab; then
    grep -Fqx "$expected_entry" /etc/fstab || fail "An unrelated fstab entry already targets the receiver root"
  else
    printf '\n%s\n%s\n' "$FSTAB_MARKER" "$expected_entry" >> /etc/fstab
  fi
}

usage() {
  cat <<'EOF'
Usage:
  sudo bash provision-ubuntu-24.04.sh \
    --public-key-file /root/business-finlynq-backup.pub \
    --source-cidr 91.99.53.52/32 \
    --allowed-revisions-file /root/business-finlynq-allowed-revisions.txt

All three inputs are required. The public key and revision allowlist are read from
files so they are not exposed in the process list. The revision file must contain
one full, lowercase 40- or 64-character Git revision per line.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --public-key-file)
      (( $# >= 2 )) || fail "--public-key-file requires a path"
      public_key_file="$2"
      shift 2
      ;;
    --source-cidr)
      (( $# >= 2 )) || fail "--source-cidr requires an address or CIDR"
      source_cidr="$2"
      shift 2
      ;;
    --allowed-revisions-file)
      (( $# >= 2 )) || fail "--allowed-revisions-file requires a path"
      allowed_revisions_input="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ "$EUID" -eq 0 ]] || fail "Run this provisioner as root"
[[ -n "$public_key_file" && -n "$source_cidr" && -n "$allowed_revisions_input" ]] || {
  usage >&2
  fail "The public key, source CIDR, and allowed-revisions file are required"
}
[[ -f "$public_key_file" && ! -L "$public_key_file" && -s "$public_key_file" ]] || fail "Public key input must be a non-empty regular file"
[[ -f "$allowed_revisions_input" && ! -L "$allowed_revisions_input" && -s "$allowed_revisions_input" ]] || fail "Allowed revisions input must be a non-empty regular file"

[[ -r /etc/os-release ]] || fail "Cannot identify the operating system"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || fail "This provisioner supports Ubuntu 24.04 only"

missing_packages=()
for package_name in openssh-server e2fsprogs jq util-linux python3; do
  dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -Fq 'install ok installed' || missing_packages+=("$package_name")
done
if (( ${#missing_packages[@]} > 0 )); then
  log "Installing required Ubuntu packages: ${missing_packages[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing_packages[@]}"
fi

for command_name in awk blkid find findmnt flock getent grep id install jq losetup mkfs.ext4 mount passwd python3 readlink sha256sum ssh-keygen sshd stat systemctl truncate useradd usermod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

normalized_source_cidr="$(python3 - "$source_cidr" <<'PY'
import ipaddress
import sys

try:
    print(ipaddress.ip_network(sys.argv[1], strict=False))
except ValueError as error:
    raise SystemExit(f"invalid source CIDR: {error}")
PY
)" || fail "Source CIDR is invalid"
source_probe="$(python3 - "$normalized_source_cidr" <<'PY'
import ipaddress
import sys

network = ipaddress.ip_network(sys.argv[1], strict=False)
print(network.network_address)
PY
)"

mapfile -t public_key_lines < <(awk 'NF && $1 !~ /^#/' "$public_key_file")
[[ "${#public_key_lines[@]}" -eq 1 ]] || fail "Public key input must contain exactly one non-comment key"
read -r key_type key_material _key_comment <<< "${public_key_lines[0]}"
case "$key_type" in
  ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com) ;;
  *) fail "Unsupported SSH public-key type: $key_type" ;;
esac
[[ "$key_material" =~ ^[A-Za-z0-9+/]+={0,3}$ ]] || fail "SSH public-key material is malformed"
ssh-keygen -l -f "$public_key_file" >/dev/null || fail "ssh-keygen rejected the supplied public key"

awk 'NF && $1 !~ /^#/ && NF != 1 { exit 1 }' "$allowed_revisions_input" || fail "Each allowed-revisions line must contain exactly one revision"
normalized_revisions="$(awk 'NF && $1 !~ /^#/ { print $1 }' "$allowed_revisions_input" | sort -u)"
[[ -n "$normalized_revisions" ]] || fail "Allowed revisions input contains no revisions"
while IFS= read -r revision; do
  [[ "$revision" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && ! "$revision" =~ ^0+$ ]] || fail "Invalid allowed application revision: $revision"
done <<< "$normalized_revisions"

install -d -o root -g root -m 0700 "$IMAGE_DIRECTORY"
if [[ ! -e "$IMAGE_PATH" ]]; then
  log "Creating the explicitly named sparse 10 GiB receiver image"
  install -o root -g root -m 0600 /dev/null "$IMAGE_PATH"
  truncate --size "$IMAGE_BYTES" "$IMAGE_PATH"
  created_image="true"
  mkfs.ext4 -q -F -L "$FILESYSTEM_LABEL" "$IMAGE_PATH"
else
  [[ -f "$IMAGE_PATH" && ! -L "$IMAGE_PATH" ]] || fail "The dedicated image path exists but is not a regular file"
fi

[[ "$(stat -c '%u:%g:%a:%s' "$IMAGE_PATH")" == "0:0:600:$IMAGE_BYTES" ]] || fail "The dedicated image must be root:root, mode 0600, and exactly 10 GiB"
[[ "$(blkid -p -s TYPE -o value "$IMAGE_PATH" 2>/dev/null)" == "ext4" ]] || fail "The dedicated image is not an ext4 filesystem"
[[ "$(blkid -p -s LABEL -o value "$IMAGE_PATH" 2>/dev/null)" == "$FILESYSTEM_LABEL" ]] || fail "The dedicated image has the wrong filesystem label"

install -d -o root -g root -m 0755 "$RECEIVER_ROOT"
if mounted_source="$(findmnt -rn -M "$RECEIVER_ROOT" -o SOURCE 2>/dev/null)"; then
  [[ "$mounted_source" == /dev/loop* ]] || fail "Receiver root is already a non-loop mount; refusing to touch it"
  mounted_backing="$(losetup -n -O BACK-FILE "$mounted_source" 2>/dev/null | head -n 1 | xargs)"
  [[ -n "$mounted_backing" ]] || fail "Cannot determine the backing file for $mounted_source"
  [[ "$(readlink -f -- "$mounted_backing")" == "$(readlink -f -- "$IMAGE_PATH")" ]] || fail "Receiver root is mounted from a different loopback image"
  ensure_receiver_fstab_entry
else
  [[ -z "$(find "$RECEIVER_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "Receiver mount point is non-empty; refusing to hide existing data"
  while IFS=: read -r attached_loop _; do
    [[ -n "$attached_loop" ]] || continue
    if attached_target="$(findmnt -rn -S "$attached_loop" -o TARGET 2>/dev/null)"; then
      fail "The dedicated image is already mounted elsewhere at $attached_target"
    fi
  done < <(losetup -j "$IMAGE_PATH")
  ensure_receiver_fstab_entry
  mount "$RECEIVER_ROOT"
fi

mount_options=",$(findmnt -rn -M "$RECEIVER_ROOT" -o OPTIONS),"
for required_option in nodev nosuid noexec; do
  [[ "$mount_options" == *",$required_option,"* ]] || fail "Receiver filesystem is missing mount option: $required_option"
done

if ! getent group "$RECEIVER_GROUP" >/dev/null; then
  groupadd --system "$RECEIVER_GROUP"
fi
if ! getent passwd "$RECEIVER_USER" >/dev/null; then
  useradd --system --gid "$RECEIVER_GROUP" --home-dir /incoming --shell /usr/sbin/nologin --no-create-home "$RECEIVER_USER"
else
  usermod --gid "$RECEIVER_GROUP" --groups '' --home /incoming --shell /usr/sbin/nologin "$RECEIVER_USER"
fi
usermod --lock "$RECEIVER_USER"
[[ "$(id -Gn "$RECEIVER_USER")" == "$RECEIVER_GROUP" ]] || fail "Receiver user has unexpected supplementary groups"

chown root:root "$RECEIVER_ROOT"
chmod 0755 "$RECEIVER_ROOT"
install -d -o "$RECEIVER_USER" -g "$RECEIVER_GROUP" -m 0700 "$RECEIVER_ROOT/incoming"
for root_only_directory in processing vault quarantine; do
  install -d -o root -g root -m 0700 "$RECEIVER_ROOT/$root_only_directory"
done

install -d -o root -g root -m 0755 "$INSTALL_DIRECTORY"
install -o root -g root -m 0755 "$script_directory/ingest-backups.sh" "$INSTALL_DIRECTORY/ingest-backups.sh"
install -o root -g root -m 0755 "$script_directory/verify-receiver.sh" "$INSTALL_DIRECTORY/verify-receiver.sh"
install -d -o root -g root -m 0755 /etc/business-finlynq
config_temporary="$(mktemp /etc/business-finlynq/.backup-receiver.conf.XXXXXX)"
cat > "$config_temporary" <<EOF
RECEIVER_SOURCE_CIDR=$normalized_source_cidr
RECEIVER_SOURCE_PROBE=$source_probe
RECEIVER_ALLOWED_REVISIONS_FILE=$ALLOWED_REVISIONS_FILE
RECEIVER_RETENTION_DAYS=60
RECEIVER_SETTLE_SECONDS=60
EOF
install -o root -g root -m 0644 "$config_temporary" "$RECEIVER_CONFIG"
rm -f -- "$config_temporary"
revisions_temporary="$(mktemp /etc/business-finlynq/.backup-receiver-revisions.XXXXXX)"
printf '%s\n' "$normalized_revisions" > "$revisions_temporary"
install -o root -g root -m 0644 "$revisions_temporary" "$ALLOWED_REVISIONS_FILE"
rm -f -- "$revisions_temporary"

install -d -o root -g root -m 0755 "$AUTHORIZED_KEYS_DIRECTORY"
authorized_key_temporary="$(mktemp "$AUTHORIZED_KEYS_DIRECTORY/.${RECEIVER_USER}.XXXXXX")"
printf 'from="%s",restrict,command="internal-sftp -d /incoming -u 077" %s %s\n' \
  "$normalized_source_cidr" "$key_type" "$key_material" > "$authorized_key_temporary"
install -o root -g root -m 0600 "$authorized_key_temporary" "$AUTHORIZED_KEYS_FILE"
rm -f -- "$authorized_key_temporary"

sshd_temporary="$(mktemp /etc/ssh/sshd_config.d/.business-finlynq-backup-receiver.XXXXXX)"
cat > "$sshd_temporary" <<'EOF'
Match User finlynq-backup
    ChrootDirectory /srv/business-finlynq-backup
    ForceCommand internal-sftp -d /incoming -u 077
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitEmptyPasswords no
    PermitTTY no
    DisableForwarding yes
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u

Match all
EOF
sshd_previous=""
if [[ -e "$SSHD_DROP_IN" ]]; then
  [[ -f "$SSHD_DROP_IN" && ! -L "$SSHD_DROP_IN" ]] || fail "Existing receiver sshd drop-in is not a regular file"
  sshd_previous="$(mktemp /etc/ssh/sshd_config.d/.business-finlynq-backup-receiver.previous.XXXXXX)"
  cp --preserve=mode,ownership,timestamps -- "$SSHD_DROP_IN" "$sshd_previous"
fi
install -o root -g root -m 0644 "$sshd_temporary" "$SSHD_DROP_IN"
rm -f -- "$sshd_temporary"
restore_previous_sshd_drop_in() {
  if [[ -n "$sshd_previous" ]]; then
    mv -- "$sshd_previous" "$SSHD_DROP_IN"
  else
    rm -f -- "$SSHD_DROP_IN"
  fi
}

if ! sshd -t; then
  restore_previous_sshd_drop_in
  fail "sshd rejected the receiver configuration; the previous configuration was restored"
fi

if ! effective_sshd="$(sshd -T -C "user=$RECEIVER_USER,host=business-finlynq-backup,addr=$source_probe")"; then
  restore_previous_sshd_drop_in
  sshd -t || fail "Effective sshd evaluation failed and restoring the previous drop-in did not restore valid syntax"
  fail "Could not evaluate the matched receiver sshd policy; the previous configuration was restored"
fi
for expected_setting in \
  "chrootdirectory $RECEIVER_ROOT" \
  "forcecommand internal-sftp -d /incoming -u 077" \
  "authenticationmethods publickey" \
  "passwordauthentication no" \
  "kbdinteractiveauthentication no" \
  "permittty no" \
  "disableforwarding yes" \
  "authorizedkeysfile /etc/ssh/authorized_keys/%u"; do
  if ! grep -Fqx "$expected_setting" <<< "$effective_sshd"; then
    restore_previous_sshd_drop_in
    sshd -t || fail "Effective sshd policy failed and restoring the previous drop-in did not restore valid syntax"
    fail "Effective sshd configuration is missing '$expected_setting'; the previous configuration was restored"
  fi
done
rm -f -- "$sshd_previous"

install -o root -g root -m 0644 "$script_directory/business-finlynq-backup-receiver.service" /etc/systemd/system/business-finlynq-backup-receiver.service
install -o root -g root -m 0644 "$script_directory/business-finlynq-backup-receiver.timer" /etc/systemd/system/business-finlynq-backup-receiver.timer
systemctl daemon-reload
systemctl reload ssh.service
systemctl enable --now business-finlynq-backup-receiver.timer
systemctl start business-finlynq-backup-receiver.service
"$INSTALL_DIRECTORY/verify-receiver.sh"

created_image="false"
log "Business Finlynq backup receiver provisioned successfully"
log "The receiver stores encrypted artifacts only; no age identity or application recovery key was installed"
