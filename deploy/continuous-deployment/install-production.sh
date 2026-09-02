#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly configuration_directory="/etc/business-finlynq"
readonly secret_directory="$configuration_directory/secrets"
readonly receiver_key="$secret_directory/continuous-deployment-receiver"
readonly receiver_known_hosts="$configuration_directory/continuous-deployment-known-hosts"
readonly deployment_environment="$configuration_directory/continuous-deployment.env"
readonly deploy_target="/usr/local/sbin/business-finlynq-deploy-main"
readonly service_target="/etc/systemd/system/business-finlynq-continuous-deployment.service"
readonly timer_target="/etc/systemd/system/business-finlynq-continuous-deployment.timer"

fail() {
  printf 'Business Finlynq production deployment installation failed: %s\n' "$*" >&2
  exit 1
}

receiver_host=""
known_hosts_input=""
enable_timer="false"
while (( $# > 0 )); do
  case "$1" in
    --receiver-host)
      (( $# >= 2 )) || fail "--receiver-host requires a value"
      receiver_host="$2"
      shift 2
      ;;
    --receiver-known-hosts-file)
      (( $# >= 2 )) || fail "--receiver-known-hosts-file requires a value"
      known_hosts_input="$2"
      shift 2
      ;;
    --enable)
      enable_timer="true"
      shift
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(id -u)" == 0 ]] || fail "run this installer as root"
[[ "$receiver_host" =~ ^[A-Za-z0-9.-]+$ ]] \
  || fail "--receiver-host is missing or invalid"
[[ -f "$known_hosts_input" && ! -L "$known_hosts_input" && -s "$known_hosts_input" ]] \
  || fail "--receiver-known-hosts-file must identify a regular non-empty file"

for command_name in chmod chown cmp getent install mktemp mv readlink rm ssh-keygen \
  stat systemctl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
for source_file in deploy-main.sh business-finlynq-continuous-deployment.service \
  business-finlynq-continuous-deployment.timer; do
  [[ -f "$script_directory/$source_file" && ! -L "$script_directory/$source_file" ]] \
    || fail "installer source is unavailable: $source_file"
done
[[ -f "$configuration_directory/compose.env" \
  && "$(stat -c '%U:%G:%a' -- "$configuration_directory/compose.env")" == root:deploy:600 ]] \
  || fail "the canonical Compose environment is unavailable or unsafe"
[[ -f "$configuration_directory/operations.env" \
  && "$(stat -c '%U:%G:%a' -- "$configuration_directory/operations.env")" == root:deploy:600 ]] \
  || fail "the canonical operations environment is unavailable or unsafe"

ssh-keygen -F "$receiver_host" -f "$known_hosts_input" >/dev/null \
  || fail "the supplied known-hosts file does not pin the receiver host"

install -d -o root -g root -m 0750 -- "$configuration_directory"
if getent group business-finlynq-secrets >/dev/null; then
  install -d -o root -g business-finlynq-secrets -m 0750 -- "$secret_directory"
else
  install -d -o root -g root -m 0700 -- "$secret_directory"
fi

if [[ ! -e "$receiver_key" ]]; then
  ssh-keygen -q -t ed25519 -N '' \
    -C business-finlynq-continuous-deployment \
    -f "$receiver_key"
fi
[[ -f "$receiver_key" && ! -L "$receiver_key" \
  && -f "$receiver_key.pub" && ! -L "$receiver_key.pub" ]] \
  || fail "the receiver deployment keypair is unavailable or unsafe"
chown root:root "$receiver_key" "$receiver_key.pub"
chmod 0400 "$receiver_key"
chmod 0444 "$receiver_key.pub"
private_key_fingerprint="$(ssh-keygen -lf "$receiver_key" | awk 'NR == 1 { print $2 }')"
public_key_fingerprint="$(ssh-keygen -lf "$receiver_key.pub" | awk 'NR == 1 { print $2 }')"
[[ -n "$private_key_fingerprint" && "$private_key_fingerprint" == "$public_key_fingerprint" ]] \
  || fail "the receiver deployment keypair does not match"

install -o root -g root -m 0400 -- "$known_hosts_input" "$receiver_known_hosts"
environment_temporary="$(mktemp "$configuration_directory/.continuous-deployment.env.XXXXXX")"
printf 'BACKUP_RECEIVER_HOST=%s\n' "$receiver_host" >"$environment_temporary"
printf 'BACKUP_RECEIVER_USER=finlynq-cd\n' >>"$environment_temporary"
printf 'BACKUP_RECEIVER_KEY_FILE=%s\n' "$receiver_key" >>"$environment_temporary"
printf 'BACKUP_RECEIVER_KNOWN_HOSTS_FILE=%s\n' "$receiver_known_hosts" >>"$environment_temporary"
install -o root -g root -m 0600 -- "$environment_temporary" "$deployment_environment"
rm -f -- "$environment_temporary"

install -d -o root -g root -m 0755 -- /usr/local/sbin
install -o root -g root -m 0550 -- "$script_directory/deploy-main.sh" "$deploy_target"
install -o root -g root -m 0644 \
  -- "$script_directory/business-finlynq-continuous-deployment.service" "$service_target"
install -o root -g root -m 0644 \
  -- "$script_directory/business-finlynq-continuous-deployment.timer" "$timer_target"
systemctl daemon-reload

if [[ "$enable_timer" == true ]]; then
  systemctl enable --now business-finlynq-continuous-deployment.timer
  printf 'Continuous deployment timer enabled.\n'
else
  printf 'Continuous deployment installed but left disabled pending receiver setup.\n'
fi
printf 'Install this public key on the receiver with install-backup-receiver.sh:\n'
printf '%s\n' "$(<"$receiver_key.pub")"
