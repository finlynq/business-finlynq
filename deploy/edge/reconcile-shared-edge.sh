#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository="$(cd -- "$script_directory/../.." && pwd -P)"
readonly expected_origin="https://github.com/finlynq/business-finlynq.git"
readonly compose_environment="/etc/business-finlynq/compose.env"
readonly external_basic_auth="/home/deploy/epm-finlynq/secrets/external-basic-auth.caddy"
readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"
readonly shared_edge_lock="/var/lib/business-finlynq/shared-edge.lock"

fail() {
  printf 'Business Finlynq shared-edge reconciliation failed: %s\n' "$*" >&2
  exit 1
}

[[ "$#" == 0 ]] || fail "this command accepts no arguments"
[[ "$(id -u)" == 0 ]] || fail "run this command as root"
[[ "$repository" == "/home/deploy/business-finlynq" ]] \
  || fail "run this command from the canonical production checkout"
for command_name in awk bash chmod curl docker flock git id jq readlink sha256sum stat timeout; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"

[[ -d "${host_deployment_lock%/*}" && ! -L "${host_deployment_lock%/*}" ]] \
  || fail "the application state directory is unavailable"
[[ ! -L "$host_deployment_lock" && ! -L "$shared_edge_lock" ]] \
  || fail "a shared-edge lock path is symbolic"
# The installed production deployer already owns fd 8 on this exact lock. A
# direct operator invocation acquires it here, so development, production, and
# shared-edge changes can never overlap on the multi-deployment host.
if [[ "$(readlink "/proc/$$/fd/8" 2>/dev/null || true)" != "$host_deployment_lock" ]]; then
  exec 8>"$host_deployment_lock"
  chmod 0600 -- "$host_deployment_lock"
  flock --exclusive --nonblock 8 \
    || fail "another production or development deployment is active"
fi
exec 7>"$shared_edge_lock"
chmod 0600 -- "$shared_edge_lock"
flock --exclusive --nonblock 7 || fail "another shared-edge reconciliation is active"

[[ -f "$compose_environment" && ! -L "$compose_environment" \
  && "$(stat -c '%U:%G:%a' -- "$compose_environment")" == "root:deploy:600" ]] \
  || fail "the canonical Compose environment is unavailable or unsafe"
[[ -f "$repository/deploy/Caddyfile.container" \
  && ! -L "$repository/deploy/Caddyfile.container" \
  && "$(stat -c '%U:%G:%a' -- "$repository/deploy/Caddyfile.container")" == "deploy:deploy:644" ]] \
  || fail "the reviewed Caddy configuration is unavailable or unsafe"
[[ -f "$external_basic_auth" && ! -L "$external_basic_auth" \
  && -s "$external_basic_auth" \
  && "$(stat -c '%U:%G:%a' -- "$external_basic_auth")" == "root:root:400" ]] \
  || fail "the EPM basic-auth include must be a non-empty root-owned mode-0400 file"
[[ -z "$(git --no-optional-locks -c safe.directory="$repository" -C "$repository" \
  status --porcelain=v1 --untracked-files=all)" ]] \
  || fail "the canonical production checkout is not clean"
[[ "$(git --no-optional-locks -c safe.directory="$repository" -C "$repository" \
  symbolic-ref --short HEAD)" == "main" ]] \
  || fail "the canonical production checkout is not on main"
[[ "$(git --no-optional-locks -c safe.directory="$repository" -C "$repository" \
  remote get-url origin)" == "$expected_origin" ]] \
  || fail "the canonical production checkout has an unexpected origin"

for network_name in business_finlynq_edge business_finlynq_development_edge \
  epm_finlynq_edge consult_finlynq_edge; do
  docker network inspect "$network_name" >/dev/null 2>&1 \
    || fail "required shared backend network is unavailable: $network_name"
done

compose() {
  env -i "PATH=$PATH" docker compose \
    --project-name business-finlynq \
    --project-directory "$repository" \
    --env-file "$compose_environment" \
    "$@"
}

compose_timed() {
  local duration="$1"
  shift
  timeout --signal=TERM --kill-after=10s "$duration" \
    env -i "PATH=$PATH" docker compose \
      --project-name business-finlynq \
      --project-directory "$repository" \
      --env-file "$compose_environment" \
      "$@"
}

# Validate the exact mounts and every backend from a disposable edge container
# before the live listener is touched. Compose `up` below intentionally omits
# --force-recreate: it replaces only a changed edge service and never tears
# down another project's containers, volumes, or external networks.
compose --profile edge run --rm --no-deps -T --entrypoint /bin/sh edge -ec '
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  wget -q -T 10 -O /dev/null http://production-app:3000/api/health
  wget -q -T 10 -O /dev/null http://development-app:3000/api/health
  wget -q -T 10 -O /dev/null http://epm-finlynq-api:7100/health
  wget -q -T 10 -O /dev/null http://epm-finlynq-console:7090/api/health
  wget -q -T 10 -O /dev/null http://consult-finlynq-app:8080/
'

compose_timed 3m --profile edge up --detach --no-deps --no-build \
  --wait --wait-timeout 120 edge

mapfile -t edge_containers < <(compose --profile edge ps --status running --quiet edge)
[[ "${#edge_containers[@]}" == 1 ]] || fail "exactly one shared edge container must be running"
edge_container="${edge_containers[0]}"
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$edge_container")" == "healthy" ]] \
  || fail "the shared edge container is not healthy"
docker inspect --format '{{json .Mounts}}' "$edge_container" \
  | jq -e --arg source "$external_basic_auth" '
      any(.[]; .Type == "bind" and .Source == $source
        and .Destination == "/config/epm-basic-auth" and .RW == false)
    ' >/dev/null \
  || fail "the live edge does not use the reviewed read-only EPM secret mount"

production_health="$(curl --fail --silent --show-error --max-time 20 \
  https://business.finlynq.com/api/health)" \
  || fail "the production hostname is unavailable through the shared edge"
jq -e 'type == "object" and keys == ["status"] and .status == "ready"' \
  <<<"$production_health" >/dev/null \
  || fail "the production hostname returned an unexpected readiness response"
curl --fail --silent --show-error --max-time 20 \
  https://dev.business.finlynq.com/api/health >/dev/null \
  || fail "the development hostname is unavailable through the shared edge"
epm_status="$(curl --silent --show-error --max-time 20 --output /dev/null \
  --write-out '%{http_code}' https://epm.finlynq.com/)" \
  || fail "the EPM hostname is unavailable through the shared edge"
[[ "$epm_status" == "401" ]] || fail "the EPM console is not protected by basic authentication"
curl --fail --silent --show-error --max-time 20 \
  https://consult.finlynq.com/ >/dev/null \
  || fail "the consultation hostname is unavailable through the shared edge"

printf 'Shared edge accepted without altering sibling deployment resources: container=%s caddy_sha256=%s\n' \
  "$edge_container" "$(sha256sum "$repository/deploy/Caddyfile.container" | awk '{print $1}')"
