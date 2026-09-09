# Continuous deployment from main

Business Finlynq production has one deployable branch: `main`. The separate `dev` branch and development stack are documented in [Development deployment from dev](./development-deployment.md); they have no production deployment path. After a successful `quality-gate` run for a same-repository push to `main`, the `signal-production-deployment` workflow writes a deterministic manifest containing the repository and full revision, then obtains a keyless GitHub OIDC/Sigstore attestation for those exact bytes. It uploads the attestation bundle as an untrusted release asset named `business-finlynq-production-deployment-<full-sha>.attestation.json` under the fixed `production-deployment-signals` release. A root-managed production timer checks every five minutes and deploys only when all of these statements remain true:

- the canonical checkout is clean and on `main` with the reviewed GitHub origin;
- `origin/main` is a fast-forward descendant of the running revision;
- the anonymously downloaded bundle verifies locally against the exact deterministic manifest, repository `finlynq/business-finlynq`, certificate identity `https://github.com/finlynq/business-finlynq/.github/workflows/signal-production-deployment.yml@refs/heads/main`, GitHub Actions OIDC issuer, candidate signer/source digest, `refs/heads/main` source ref, GitHub-hosted-runner policy, and SLSA provenance predicate;
- the off-server backup receiver atomically accepts the running and candidate revisions; and
- the existing production release runner accepts backup, migration, RLS/grant, readiness, browser, scheduler, and evidence checks; and
- the shared-edge reconciler validates every attached production, development, EPM, and Consult backend before converging only the Caddy service.

Production, development, and shared-edge reconciliation acquire the same host deployment lock, preventing builds, migrations, and public-route changes from overlapping on the shared server. A no-op production check also runs edge reconciliation, which repairs reviewed Compose drift without force-recreating an unchanged proxy or operating on a sibling project's containers, networks, or volumes.

The release asset is transport only: replacing or corrupting it cannot authorize a deployment because the host independently verifies its Sigstore signature and claims. The installed root-owned deployer also pins the SHA-256 digests of both production-signaling workflows and compares them with the candidate's exact Git blobs before accepting its attestation. A workflow change therefore stops automatic deployment until an operator reviews it and deliberately reinstalls the production deployer with new trusted digests. No GitHub credential or general remote shell is stored on the production host. The production host uses a dedicated outbound Ed25519 key whose receiver-side forced command can only replace the backup receiver's revision allowlist with an already-trusted source plus one candidate. The production timer has no path for deploying a feature branch, an unattested commit, a force-pushed history, a self-hosted-runner attestation, or an unreviewed protected-host environment change.

Repository merge permission remains production code authority. Before enabling this timer, the `main` ruleset must require the complete `verify` check and at least one independent approving review, with CODEOWNERS review for `.github/workflows/**`, `deploy/**`, `Dockerfile`, and `docker-compose.yml`. The host-pinned workflow digests prevent a repository writer from silently weakening the signer or quality-gate workflow, but they do not turn passing tests into independent human review of ordinary application code.

The fixed `production-deployment-signals` release must remain deliberately mutable so the signaling workflow can add or replace a revision-named transport asset; GitHub's immutable-release setting is incompatible with this design. GitHub limits one release to 1,000 assets. Before reaching that limit, perform a reviewed rotation or archive that preserves every SHA referenced by current `main`, the running revision, the failure latch, the active-finalization marker, and every release-recovery journal on every production host. Never prune automatically by age alone. Alternatively, migrate the workflow and verifier together to a reviewed per-candidate or sharded transport before enabling immutable releases. Release mutability and retention are transport concerns, never authorization controls.

## One-time root installation

Installation requires authorized root access to both hosts. Do not use Docker socket access to bypass that boundary. Before running the installer, install GitHub CLI 2.100.0 or newer as the non-symlink, root-owned executable `/usr/bin/gh` with mode `0755`. The installer verifies that exact path, version, and every attestation-policy flag it depends on; no `gh` login is required, and verification runs with isolated empty credential/configuration directories. The installer also creates `/var/cache/business-finlynq/github-attestations` as root-only mode `0700`. Only cryptographically verified Sigstore/TUF trust metadata is reused there for up to its normal validity window, avoiding repeated trust-root downloads without caching credentials or an unverified deployment decision.

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

The first service run is a no-op when production already runs the accepted `origin/main` revision. There is one crash-finalization exception. The release first writes a protected `terminal-evidence-pending` marker, synchronizes terminal acceptance evidence, binds its SHA-256 digest into an `active-commit-authorized` marker, and only then may commit the durable router sentinel from `maintenance` to `active`. The service accepts that authorization for at most one hour and rechecks the exact evidence digest, revision, run, app/router container and image identities, detailed health, scheduler posture, and live route immediately before the active commit. It then clears the marker, re-runs strict acceptance, and reconciles the edge. A stale, malformed, unauthorized, or mismatched marker fails closed; a pending marker alone can never authorize active routing. A later push is eligible only after its complete `quality-gate` workflow succeeds and publishes the exact keyless attestation bundle.

Planned maintenance requires an explicit automation interlock. Stop and disable both `business-finlynq-continuous-deployment.timer` and `business-finlynq-continuous-deployment.service`, acquire an exclusive hold on `/var/lib/business-finlynq/deployment-host.lock` for the complete maintenance window, and pause and drain all production schedulers before entering maintenance. Do not begin while an active-finalization marker exists, and never delete that marker manually: it is protected in-flight release authorization, not an operator maintenance flag. Without this interlock, an authorized crash-finalization marker may legitimately cause the service to restore the already accepted active route during its one-hour validity window. Re-enable automation only after the intended final router and scheduler state has been independently verified.

## Failure behavior

Any failure to download or verify the attestation bundle occurs before the receiver allowlist, candidate checkout/reset, build, or runtime is mutated, so a GitHub or release-asset outage leaves production unchanged. Before its first network fetch, every run also finalizes an exactly evidenced and authorized live-active release or drives an unaccepted router and write surfaces fail-closed, preventing an interrupted route from remaining public while network access waits. The systemd unit gives the parent and child containment handlers a 15-minute stop window. A failure after mutation keeps the release runner's fail-closed scheduler behavior and creates `/var/lib/business-finlynq/continuous-deployment-failed`. Later automatic attempts refuse to run, including attempts for a newer commit, until an operator reviews the release evidence and current runtime.

After remediation, clear only the matching latch with an explicit acknowledgement:

```bash
failed_revision=<full-failed-sha>
sudo env \
  "CONTINUOUS_DEPLOYMENT_FAILURE_ACK=clear:$failed_revision" \
  /usr/local/sbin/business-finlynq-deploy-main \
    --clear-failure "$failed_revision"
```

Do not clear the latch merely to retry a failed migration or paused scheduler. Follow the failure and forward-repair guidance in the [production release runbook](./release-runbook.md) first.
