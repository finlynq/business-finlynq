#!/bin/sh
# Only used on disposable CI hosts. Uses the exact production image/config.
set -eu

scanner_image="clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591"
scanner_container="finlynq-ci-evidence-scanner"
updater_container="finlynq-ci-evidence-scanner-update"
signature_volume="finlynq-ci-evidence-scanner-signatures"
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
resources_owned=false
bootstrap_complete=false

cleanup_failed_bootstrap() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$resources_owned" = true ] && [ "$bootstrap_complete" != true ]; then
    docker logs --tail 40 "$updater_container" 2>/dev/null || true
    docker logs --tail 40 "$scanner_container" 2>/dev/null || true
    docker rm --force "$updater_container" "$scanner_container" >/dev/null 2>&1 || true
    docker volume rm "$signature_volume" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_failed_bootstrap EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if docker container inspect "$updater_container" >/dev/null 2>&1 \
  || docker container inspect "$scanner_container" >/dev/null 2>&1 \
  || docker volume inspect "$signature_volume" >/dev/null 2>&1; then
  echo "Disposable CI evidence-scanner resources already exist" >&2
  exit 1
fi

docker volume create "$signature_volume" >/dev/null
resources_owned=true

# The pinned image can contain signatures older than clamd.conf permits. Refresh
# them to completion before starting ClamD so its startup cannot race FreshClam.
timeout --signal=TERM --kill-after=30s 10m \
  docker run --rm --name "$updater_container" \
    --user 100:101 --entrypoint freshclam --read-only \
    --cap-drop ALL --security-opt no-new-privileges --memory 3g --pids-limit 64 \
    --tmpfs /tmp:size=128m,mode=1777 \
    --mount "type=volume,source=$signature_volume,target=/var/lib/clamav" \
    --mount "type=bind,source=$script_directory/freshclam-ci.conf,target=/etc/clamav/freshclam-finlynq.conf,readonly" \
    "$scanner_image" \
    --foreground --stdout --user=clamav \
    --config-file=/etc/clamav/freshclam-finlynq.conf

docker run --detach --name "$scanner_container" \
  --user 100:101 --entrypoint /init-unprivileged --read-only \
  --env CLAMAV_NO_FRESHCLAMD=true \
  --cap-drop ALL --security-opt no-new-privileges --memory 3g --pids-limit 64 \
  --tmpfs /tmp:size=128m,mode=1777 --tmpfs /var/log/clamav:size=8m,uid=100,gid=101,mode=0700 \
  --mount "type=volume,source=$signature_volume,target=/var/lib/clamav,readonly" \
  --mount "type=bind,source=$script_directory/clamd.conf,target=/etc/clamav/clamd.conf,readonly" \
  -p 127.0.0.1:53310:3310 \
  "$scanner_image" >/dev/null

attempt=0
until docker exec "$scanner_container" clamdcheck.sh; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    exit 1
  fi
  sleep 2
done

bootstrap_complete=true
