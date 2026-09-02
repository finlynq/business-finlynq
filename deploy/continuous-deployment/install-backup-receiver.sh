#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly receiver_user="finlynq-cd"
readonly receiver_group="finlynq-cd"
readonly receiver_home="/var/lib/business-finlynq-continuous-deployment"
readonly authorized_keys_directory="/etc/ssh/authorized_keys"
readonly authorized_keys_file="$authorized_keys_directory/$receiver_user"
readonly gateway_target="/usr/local/libexec/business-finlynq-receiver-deploy-gateway"
readonly allowlist_target="/usr/local/sbin/business-finlynq-allow-backup-revisions"
readonly sudoers_target="/etc/sudoers.d/business-finlynq-continuous-deployment-receiver"
readonly sshd_target="/etc/ssh/sshd_config.d/business-finlynq-continuous-deployment.conf"
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() {
  printf 'Business Finlynq receiver deployment installation failed: %s\n' "$*" >&2
  exit 1
}

public_key_file=""
source_cidr=""
while (( $# > 0 )); do
  case "$1" in
    --public-key-file)
      (( $# >= 2 )) || fail "--public-key-file requires a value"
      public_key_file="$2"
      shift 2
      ;;
    --source-cidr)
      (( $# >= 2 )) || fail "--source-cidr requires a value"
      source_cidr="$2"
      shift 2
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" == 0 ]] || fail "run this installer as root"
[[ -f "$public_key_file" && ! -L "$public_key_file" && -s "$public_key_file" ]] \
  || fail "a regular public key file is required"
[[ "$source_cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] \
  || fail "--source-cidr must be one IPv4 /32 address"
awk -F'[./]' '{for (i=1;i<=4;i++) if ($i < 0 || $i > 255) exit 1}' <<<"$source_cidr" \
  || fail "--source-cidr contains an invalid IPv4 address"

for command_name in awk chmod chown getent groupadd id install mktemp mv readlink \
  rm ssh-keygen sshd systemctl useradd usermod visudo; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
for source_file in allow-backup-revisions.sh receiver-gateway.sh; do
  [[ -f "$script_directory/$source_file" && ! -L "$script_directory/$source_file" ]] \
    || fail "installer source is unavailable: $source_file"
done

read -r key_type key_material key_comment extra <"$public_key_file"
[[ "$key_type" == ssh-ed25519 && "$key_material" =~ ^[A-Za-z0-9+/]+={0,3}$ \
  && -z "${extra:-}" ]] \
  || fail "the deployment public key must be one Ed25519 key"
ssh-keygen -lf "$public_key_file" >/dev/null \
  || fail "the deployment public key is invalid"

if ! getent group "$receiver_group" >/dev/null; then
  groupadd --system "$receiver_group"
fi
if ! getent passwd "$receiver_user" >/dev/null; then
  useradd --system --gid "$receiver_group" --home-dir "$receiver_home" \
    --shell /bin/bash --create-home "$receiver_user"
else
  usermod --gid "$receiver_group" --groups '' --home "$receiver_home" \
    --shell /bin/bash "$receiver_user"
fi
usermod --lock "$receiver_user"
[[ "$(id -Gn "$receiver_user")" == "$receiver_group" ]] \
  || fail "the deployment receiver account has unexpected supplementary groups"
install -d -o "$receiver_user" -g "$receiver_group" -m 0700 -- "$receiver_home"

install -d -o root -g root -m 0755 -- /usr/local/libexec /usr/local/sbin
install -o root -g root -m 0555 -- "$script_directory/receiver-gateway.sh" "$gateway_target"
install -o root -g root -m 0555 -- "$script_directory/allow-backup-revisions.sh" "$allowlist_target"

sudoers_temporary="$(mktemp /etc/sudoers.d/.business-finlynq-cd.XXXXXX)"
printf '%s ALL=(root) NOPASSWD: %s\n' "$receiver_user" "$allowlist_target" \
  >"$sudoers_temporary"
chmod 0440 "$sudoers_temporary"
chown root:root "$sudoers_temporary"
visudo -cf "$sudoers_temporary" >/dev/null \
  || fail "the restricted receiver sudo rule is invalid"
mv -f -- "$sudoers_temporary" "$sudoers_target"

install -d -o root -g root -m 0755 -- "$authorized_keys_directory"
authorized_temporary="$(mktemp "$authorized_keys_directory/.${receiver_user}.XXXXXX")"
printf 'from="%s",restrict,command="%s" %s %s business-finlynq-continuous-deployment\n' \
  "$source_cidr" "$gateway_target" "$key_type" "$key_material" >"$authorized_temporary"
install -o root -g root -m 0644 -- "$authorized_temporary" "$authorized_keys_file"
rm -f -- "$authorized_temporary"

sshd_temporary="$(mktemp /etc/ssh/sshd_config.d/.business-finlynq-cd.XXXXXX)"
cat >"$sshd_temporary" <<'EOF'
Match User finlynq-cd
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
install -o root -g root -m 0644 -- "$sshd_temporary" "$sshd_target"
rm -f -- "$sshd_temporary"
sshd -t || fail "the updated SSH server configuration is invalid"
systemctl reload ssh

printf 'Receiver deployment gateway installed for source %s and key %s.\n' \
  "$source_cidr" "$(ssh-keygen -lf "$public_key_file" | awk 'NR == 1 {print $2}')"
