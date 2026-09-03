#!/bin/sh
# Only used on disposable CI hosts. Uses the exact production image/config.
set -eu
docker run --detach --name finlynq-ci-evidence-scanner \
  --user 100:101 --entrypoint /init-unprivileged --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 3g --pids-limit 64 \
  --tmpfs /tmp:size=128m,mode=1777 --tmpfs /var/log/clamav:size=8m,uid=100,gid=101,mode=0700 \
  --mount type=volume,target=/var/lib/clamav \
  --mount "type=bind,source=$PWD/deploy/evidence/clamd.conf,target=/etc/clamav/clamd.conf,readonly" \
  -p 127.0.0.1:53310:3310 \
  clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591
attempt=0
until docker exec finlynq-ci-evidence-scanner clamdcheck.sh; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    docker logs --tail 40 finlynq-ci-evidence-scanner
    exit 1
  fi
  sleep 2
done
