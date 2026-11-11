#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
readonly owner=/opt/finlynq-shared-scanner
[[ "$(id -u)" == 0 && "$(realpath "$0")" == "$owner/manage.sh" ]] \
  || { echo 'Use the installed root-owned scanner manager.' >&2; exit 1; }
[[ "$#" == 1 ]] || { echo 'Expected start, restart, or verify.' >&2; exit 1; }
cd "$owner"
case "$1" in
  verify) exec python3 "$owner/attest.py" ;;
  start|restart) ;;
  *) echo 'Expected start, restart, or verify.' >&2; exit 1 ;;
esac
# The same lock as Business releases prevents replacing its dependency during a
# release. Consult operators drain new uploads before requesting owner restart.
exec 9>/var/lib/business-finlynq/deployment-host.lock
flock --exclusive --nonblock 9 || { echo 'A Business deployment is active.' >&2; exit 1; }
exec 8>/run/lock/finlynq-shared-scanner.lock
flock --exclusive --nonblock 8 || exit 1
compose=(docker compose --project-name finlynq-shared-scanner -f "$owner/compose.yml")
if [[ "$1" == start ]]; then
  "${compose[@]}" --profile initialize run --rm --no-deps initialize
  "${compose[@]}" up --detach --wait --wait-timeout 300 --no-build scanner gateway
else
  # Explicit maintenance only. Reapply the reviewed runtime even when an outage
  # makes live pre-attestation impossible; accepting it still requires full proof.
  "${compose[@]}" up --detach --force-recreate --wait --wait-timeout 300 --no-build scanner gateway
fi
python3 "$owner/attest.py"
