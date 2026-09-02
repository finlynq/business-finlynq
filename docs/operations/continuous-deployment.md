# Continuous deployment from main

Business Finlynq has one deployable branch: `main`. A successful `quality-gate` run for a same-repository push to `main` publishes an immutable tag named `deploy-production-<full-sha>`. The tag is a deployment signal, not another development branch. A root-managed production timer checks every five minutes and deploys only when all of these statements remain true:

- the canonical checkout is clean and on `main` with the reviewed GitHub origin;
- `origin/main` is a fast-forward descendant of the running revision;
- the exact `deploy-production-<full-sha>` tag points to that `origin/main` commit;
- the off-server backup receiver atomically accepts the running and candidate revisions; and
- the existing production release runner accepts backup, migration, RLS/grant, readiness, browser, scheduler, and evidence checks.

No GitHub credential or general remote shell is stored on the production host. The production host uses a dedicated outbound Ed25519 key whose receiver-side forced command can only replace the backup receiver's revision allowlist with an already-trusted source plus one candidate. The production timer has no path for deploying a feature branch, an untagged commit, a force-pushed history, or an unreviewed environment change.

## One-time root installation

Installation requires authorized root access to both hosts. Do not use Docker socket access to bypass that boundary.

On the production host, prepare a known-hosts file from a receiver host-key fingerprint verified through the provider console or another independent channel. Do not trust an unauthenticated `ssh-keyscan` result by itself. From the exact clean `main` checkout, install the production side without enabling it:

```bash
sudo bash deploy/continuous-deployment/install-production.sh \
  --receiver-host <backup-receiver-host> \
  --receiver-known-hosts-file /root/verified-receiver-known-hosts
```

The installer prints the dedicated public key and leaves the timer disabled. Copy that public key to a root-only temporary file on the backup receiver. Install its forced-command gateway, restricting the key to the production server's public `/32` address:

```bash
sudo bash deploy/continuous-deployment/install-backup-receiver.sh \
  --public-key-file /root/business-finlynq-continuous-deployment.pub \
  --source-cidr <production-public-ip>/32
```

Return to production and enable the timer by rerunning the production installer with the same independently verified inputs and `--enable`:

```bash
sudo bash deploy/continuous-deployment/install-production.sh \
  --receiver-host <backup-receiver-host> \
  --receiver-known-hosts-file /root/verified-receiver-known-hosts \
  --enable
```

Verify installation with:

```bash
systemctl status business-finlynq-continuous-deployment.timer
systemctl start business-finlynq-continuous-deployment.service
journalctl -u business-finlynq-continuous-deployment.service --since today
```

The first service run is a no-op when production already runs the accepted `origin/main` revision. A later push is eligible only after its complete `quality-gate` workflow succeeds and publishes the immutable deployment tag.

## Failure behavior

Any failure before checkout or environment mutation leaves production unchanged. A failure after mutation keeps the release runner's fail-closed scheduler behavior and creates `/var/lib/business-finlynq/continuous-deployment-failed`. Later automatic attempts refuse to run, including attempts for a newer commit, until an operator reviews the release evidence and current runtime.

After remediation, clear only the matching latch with an explicit acknowledgement:

```bash
failed_revision=<full-failed-sha>
sudo env \
  "CONTINUOUS_DEPLOYMENT_FAILURE_ACK=clear:$failed_revision" \
  /usr/local/sbin/business-finlynq-deploy-main \
    --clear-failure "$failed_revision"
```

Do not clear the latch merely to retry a failed migration or paused scheduler. Follow the failure and forward-repair guidance in the [production release runbook](./release-runbook.md) first.
