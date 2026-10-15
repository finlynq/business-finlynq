#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

fail() { printf 'Nonproduction demo maintenance refused: %s\n' "$*" >&2; exit 1; }
[[ "$#" == 1 || ( "$#" == 2 && "$2" == --check ) ]] || fail 'usage: dev|stage [--check]'
case "$1" in
  dev)
    repository=/home/deploy/business-finlynq-dev
    environment=/etc/business-finlynq-dev/compose.env
    project=business-finlynq-dev
    override=( -f "$repository/deploy/dev/docker-compose.dev.yml" )
    ;;
  stage)
    repository=/home/deploy/business-finlynq-stage
    environment=/etc/business-finlynq-development/compose.env
    project=business-finlynq-development
    override=()
    ;;
  *) fail 'only dev and stage are supported; production has separate maintenance' ;;
esac
readonly repository environment project
readonly host_lock=/var/lib/business-finlynq/deployment-host.lock
readonly clean_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# A credential-free target preview is safe for acceptance and installation checks.
if [[ "${2:-}" == --check ]]; then
  printf 'environment=%s\nrepository=%s\ncompose_environment=%s\nproject=%s\nservice=reconcile_demo_sandboxes\n' "$1" "$repository" "$environment" "$project"
  exit 0
fi
[[ "$(id -u)" == 0 ]] || fail 'run as root'
[[ -f "$environment" && ! -L "$environment" && "$(stat -c '%U:%G:%a' "$environment")" == root:deploy:600 ]] \
  || fail 'protected Compose environment is missing or unsafe'
[[ -d "$repository/.git" && ! -L "$repository" ]] || fail 'canonical environment checkout is missing'
[[ -f "$host_lock" && ! -L "$host_lock" && "$(readlink -f "$host_lock")" == "$host_lock" ]] \
  || fail 'deployment coordination lock is missing or unsafe'
exec 9>"$host_lock"
flock --exclusive --timeout 7200 9 || fail 'deployment lock timed out'

# Use the environment's installed revision and fixed PUBLIC_DEMO reset. No
# organization selector or caller-supplied Compose settings can enter this call.
env -i PATH="$clean_path" docker compose --project-name "$project" \
  --project-directory "$repository" --env-file "$environment" \
  -f "$repository/docker-compose.yml" "${override[@]}" \
  --profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes
