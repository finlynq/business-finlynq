#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
[[ "$(id -u)" == 0 && "$#" == 0 ]] || { echo 'Run as root with no arguments.' >&2; exit 1; }
readonly source_directory="$(cd "$(dirname "$0")" && pwd -P)"
readonly repository="$(git -C "$source_directory" rev-parse --show-toplevel)"
readonly destination=/opt/finlynq-shared-scanner
[[ -z "$(git -C "$repository" status --porcelain --untracked-files=all)" ]] \
  || { echo 'Install only from a clean reviewed revision.' >&2; exit 1; }
[[ ! -e "$destination" ]] || { echo 'Owner already installed; follow the reviewed upgrade runbook.' >&2; exit 1; }
[[ -f /var/lib/business-finlynq/deployment-host.lock ]] || exit 1
exec 9>/var/lib/business-finlynq/deployment-host.lock
flock --exclusive --nonblock 9 || { echo 'A Business deployment is active.' >&2; exit 1; }
install -d -o root -g root -m 0755 "$destination"
for file in compose.yml clamd.conf gateway.mjs initialize.mjs business-relay.yml attest.py manage.sh; do
  install -o root -g root -m 0644 "$source_directory/$file" "$destination/$file"
done
chmod 0755 "$destination/manage.sh"
git -C "$repository" rev-parse HEAD >"$destination/revision"
chmod 0644 "$destination/revision"
for unit in finlynq-shared-scanner.service finlynq-shared-scanner-monitor.service finlynq-shared-scanner-monitor.timer; do
  install -o root -g root -m 0644 "$source_directory/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
echo 'Shared scanner installed, not started. Review and approve its staged activation before enabling the units.'
