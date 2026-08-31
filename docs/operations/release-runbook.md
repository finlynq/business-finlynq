# Production release runbook

Use this checklist for every Business Finlynq release. Releases are commit-addressed and migrations are forward-only.

## Required evidence before deployment

- CI passed lint, type checking, all unit/PostgreSQL tests, production build, high-severity production dependency audit, and Playwright release gates.
- The candidate image was built from the exact reviewed Git SHA and `BUSINESS_FINLYNQ_IMAGE_REVISION` is that full SHA.
- An encrypted off-site backup completed and its remote checksum was verified. Before the release backup, the receiver allowlist contains both the still-running source revision and the candidate revision used by the backup tool.
- The most recent restore drill is within 30 days and includes separate key recovery.
- Database capacity, disk, TLS, external uptime monitor, alert delivery, and auth email worker health are green.
- Any migration was reviewed for locks, runtime-role grants, backup-role grants, rollback compatibility, and required forward repair.
- The last demo-sandbox nightly reconciliation passed, no slot is unexpectedly quarantined or overdue, and the single nightly scheduler is enabled on hosts that allow writable demos.
- The mandatory operations environment contains the full release SHA, matching monitor revision, every app-gate expectation (including the independent bank-feed gate), and reviewed demo-pool thresholds.
- A named operator owns the release and another owns rollback/acceptance.

## Scripted release contract

`deploy/release/run-release.sh` is the authoritative application-update path. It refuses a dirty checkout, an abbreviated or non-HEAD revision, a reused evidence run ID, a permissive environment file, a revision mismatch, a mutable/non-addressed release image, or an unsafe rehearsal resource. It materializes the exact candidate Git object tree into a private directory, retains its Git-tree and file-hash manifests, snapshots both reviewed environment files as mode `0600`, and uses only those staged assets and snapshots for Compose, helper, test, and systemd-install operations. It builds four commit-tagged images (`app`, `migrator`, `auth-worker`, and `operations`), verifies each immutable Docker image ID and OCI revision label, then pins every release-run service to the captured `sha256:` image ID with pulling and building disabled before any production database operation.

The production mode is deliberately for updating an existing release: it requires the running app so its exact prior image ID and OCI revision can be retained. Use rehearsal mode to prove clean installation. The script performs, in order:

1. validate the exact clean Git SHA, rendered Compose boundary, production origin/cookies, target gates, monitor expectations, and private evidence paths;
2. build and record the candidate image IDs before changing runtime state;
3. retain the previous app image ID, durably pause and drain the selected scheduler, prove the alternate scheduler inactive, contain and report any orphaned scheduled one-shot container, stop the app and auth worker, and record that every write surface is quiesced;
4. while writes remain unavailable, create and verify the encrypted pre-migration backup (with bounded timeout and orphan cleanup), then run migration, runtime-role reconciliation, auth-worker reconciliation, backup-role reconciliation, the exact schema/RLS/grant and journal-type verifiers, and the full audit-graph/request-outbox integrity verifier before any app traffic is restored;
5. run additive bootstrap, persist and verify the post-bootstrap accounting-evidence result, prove candidate readiness with every gate disabled, then run browser acceptance with real-business writes and live bank feeds still disabled;
6. only after browser acceptance, recreate the app from the same immutable image ID with the reviewed final gate posture, verify the exact app/worker image IDs and OCI labels plus detailed and public readiness, install and byte-verify all eight systemd service/timer files when applicable, resume schedulers, and run the installed production monitor; and
7. retain checksummed JSON/log evidence plus the prior immutable app image record. Database rollback remains forward-repair-only.

Any failure after the scheduler is paused stops the candidate and leaves the scheduler paused. If the final production monitor fails after scheduler resume, the failure trap re-pauses it before stopping the candidate. Do not manually resume a failed release. Review `99-failure.json`, service logs, and `SHA256SUMS`; use the application-only rollback tool only after confirming forward-schema compatibility.

From the exact reviewed checkout, with both secret environment files owned by root or the release operator and mode `0600`:

```bash
revision="$(git rev-parse HEAD)"
run_id="release-$(date -u +%Y%m%d-%H%M%S)"
export RELEASE_EXECUTION_ACK="release:$revision:$run_id"
bash deploy/release/run-release.sh \
  --mode release \
  --revision "$revision" \
  --environment /etc/business-finlynq/compose.env \
  --operations-environment /etc/business-finlynq/operations.env \
  --evidence-root /var/lib/business-finlynq/release-evidence \
  --run-id "$run_id" \
  --scheduler systemd
```

Use `--scheduler cron` only for the documented deploy-owned fallback and run as the `deploy` user who owns that managed crontab. Systemd mode requires authority to stop/start the four Business Finlynq timers (backup, monitor, accounting evidence, and demo reconciliation). Compose and operations environment files, the evidence root, and the backup directory must stay outside the Git checkout so secret or generated state can never enter the commit-addressed Docker build context. The script rechecks that the checkout is clean immediately before and after the build. The evidence root and the release image IDs must be retained at least through the next accepted release.

Provision the shared lock directory once before the first rehearsal or release: `sudo install -d -m 0700 -o deploy -g deploy /home/deploy/.local/state/business-finlynq/release-locks`. Production release, application rollback, and the one-time scheduler bootstrap take the same non-blocking host lock for their complete lifetime, including failure cleanup. Rehearsals take a per-Compose-project lock. A concurrent command fails before it reads or changes deployed state; never bypass or remove a held lock file.

### Mandatory first scheduler-boundary rollout

The release that first introduces `check-scheduler-boundary.sh` cannot safely update the live checkout while the legacy timer or cron wrapper is still active: that old entry point does not yet honor the durable maintenance marker or verify the checkout revision. Before checking out this candidate, fetch the reviewed commit, archive it outside the live checkout, and run its bootstrap boundary against the still-deployed clean revision. This is a one-time mandatory operation; `run-release.sh` refuses the first rollout without its protected receipt and maintenance marker.

```bash
cd /home/deploy/business-finlynq
source_revision="$(git rev-parse HEAD)"
revision="<full-reviewed-candidate-sha>"
git cat-file -e "$revision^{commit}"
bootstrap_root="$(mktemp -d /tmp/business-finlynq-release-bootstrap.XXXXXX)"
install -d -m 0700 "$bootstrap_root/repository"
git archive --format=tar "$revision" | tar -x -C "$bootstrap_root/repository"

# systemd host (run the cron variant as the exact deploy user without sudo)
sudo env \
  "SCHEDULER_BOUNDARY_BOOTSTRAP_ACK=pause-before-checkout:$source_revision:$revision:systemd" \
  bash "$bootstrap_root/repository/deploy/release/bootstrap-scheduler-boundary.sh" \
    --candidate-revision "$revision" --scheduler systemd
```

For the deploy-owned cron fallback, replace the last command with `SCHEDULER_BOUNDARY_BOOTSTRAP_ACK="pause-before-checkout:$source_revision:$revision:cron" bash ... --scheduler cron` while logged in as the exact `deploy` account. The bootstrap binds its three executable assets to the candidate Git objects, removes only the exact old managed cron block when applicable, disables and drains every installed legacy systemd timer/service, accepts an explicitly `not-found` candidate-new unit, proves both scheduling mechanisms and scheduled one-shot containers inactive, and atomically records the source/candidate receipt. Leave the marker and receipt in place, check out the candidate, then run the normal release command. A successful release installs the new boundary, runs its installed monitor, writes `scheduler-boundary.json`, and retires the one-time receipt. Do not recreate a receipt manually or resume a failed bootstrap/release.

The pre-migration encrypted/off-site backup is wrapped in the same reviewed `SCHEDULED_BACKUP_TIMEOUT_SECONDS` ceiling as scheduled backups (90 minutes, maximum 5,400 seconds). A timeout fails the release with the application, worker, and schedulers still quiesced, stops and removes the exact one-off backup container within a second bound, proves it is gone, retains failure evidence, and keeps the shared coordination lock until cleanup completes.

### Two clean rehearsals

A rehearsal uses the same image, backup, migration, grant, schema, readiness, and browser flow in a distinct Compose project. The mandatory override gives every named volume and network a run-specific name before the script performs scoped `down --volumes`; it cannot resolve to any production resource name. It never manipulates production schedulers or contacts an off-site backup remote, and it requires:

- a unique loopback port through `BUSINESS_FINLYNQ_APP_PORT`;
- `BUSINESS_FINLYNQ_APP_ORIGIN=http://127.0.0.1:<port>` plus non-`__Host` rehearsal cookie names;
- `BACKUP_LOCAL_DIR` and `MONITOR_BACKUP_DIR` below the selected evidence root;
- `BACKUP_REQUIRE_OFFSITE=false` and `MONITOR_REQUIRE_OFFSITE=false`;
- isolated rehearsal-only database passwords and encryption secrets; and
- writable synthetic demo gates, while real account, business-write, and bank-feed gates should remain false.

Run twice with different environment files, ports, backup directories, and run IDs. The following is illustrative; substitute the actual reviewed SHA and private paths:

```bash
revision="$(git rev-parse HEAD)"

export RELEASE_EXECUTION_ACK="rehearsal:$revision:rehearsal-first"
bash deploy/release/run-release.sh \
  --mode rehearsal --revision "$revision" \
  --environment /etc/business-finlynq/rehearsal-first.env \
  --evidence-root /var/lib/business-finlynq/release-evidence \
  --run-id rehearsal-first

export RELEASE_EXECUTION_ACK="rehearsal:$revision:rehearsal-second"
bash deploy/release/run-release.sh \
  --mode rehearsal --revision "$revision" \
  --environment /etc/business-finlynq/rehearsal-second.env \
  --evidence-root /var/lib/business-finlynq/release-evidence \
  --run-id rehearsal-second

npm run release:verify-rehearsals -- \
  "/var/lib/business-finlynq/release-evidence/$revision/rehearsal-first" \
  "/var/lib/business-finlynq/release-evidence/$revision/rehearsal-second"
```

The pair verifier checks the complete runner artifact format, internal identities, image IDs, checkpoints, readiness records, browser-log digest, and file inventory for two distinct runs of one revision. Its local checksums detect accidental corruption but are not a trusted signature: anyone who can rewrite an evidence directory can also rewrite `SHA256SUMS`. Code, a unit-test fixture, verifier output, or an empty evidence directory is therefore not G0-05 acceptance evidence. Retain the two real run directories as immutable CI artifacts or in write-protected operator storage, link the originating CI run or witnessed operator record, and require an independent approver to confirm that both commands actually executed.

## Deployment

The sequence below explains the controls enforced by the scripted path. Do not substitute an ad hoc copy/paste deployment for `run-release.sh`.

1. Materialize and hash the exact Git tree, snapshot the reviewed environments, build all four targets from that tree, capture their image IDs/OCI labels, and retain the current application image ID and revision. Do not use an unreviewed working tree or a live mutable Compose file.
2. Activate the durable maintenance marker; disable and drain every installed Business Finlynq timer/service or remove the exact deployed cron block; prove the alternate scheduler and labeled scheduled one-shot containers inactive. Then stop both app and authentication worker and prove they are stopped.
3. With all write surfaces still stopped, run the bounded encrypted backup and exact backup verifier, including its off-site marker. Keep the app and worker stopped through migration and every pre-traffic verifier.
4. Run the immutable-ID-pinned migrator as database owner. Before bootstrap or app startup, run the mandatory post-migration runtime, authentication-worker, and backup-role reconcilers plus schema/RLS/grant, journal-type, and accounting-evidence verifiers.
5. Run additive `bootstrap_demo`, re-run and retain accounting-evidence verification, start the immutable candidate with all gates disabled, and complete readiness plus browser acceptance. Normal bootstrap prepares only additive dirty slots and preserves assigned claims; destructive full-pool acceptance belongs only in an explicit maintenance window or fresh install.
6. Recreate the app and optional auth worker from the same captured IDs with the reviewed final gates. Verify exact IDs/labels, readiness, and environment stability; install and verify the scheduler assets; resume only the selected scheduler and run its installed monitor.
7. Verify public `/api/live`, minimal public `/api/health`, loopback-only detailed readiness, response security headers, release revision, auth worker, backup/reconciliation/accounting job evidence, and external monitoring. Confirm public readiness contains neither `checks` nor `revision`.
8. Re-enable writes only after tenant isolation, posting authorization, idempotency, audit insertion, period controls, and browser acceptance pass against the deployed release.
9. Record completion, checksummed evidence links, backup checksum, immutable image IDs, and operator approvals.

When running the release gate against production, export explicit expectations so an accidentally disabled launch gate cannot pass merely because the Playwright runner does not share the server environment:

```text
PLAYWRIGHT_BASE_URL=https://business.finlynq.com
E2E_EXPECT_ACCOUNT_LOGIN_ENABLED=true
E2E_EXPECT_ACCOUNT_SIGNUP_ENABLED=true
npm run test:e2e
```

The browser test also requires the public `/api/health` response to be the minimal ready status and requires Cloudflare's widget API to render its response control on the live signup page. The host monitor checks the detailed flag posture and email-worker readiness over loopback. Managed challenges may solve without exposing a visible iframe, and Cloudflare does not guarantee that iframe as a public integration contract.

## Rollback

- If the schema remains compatible, redeploy the prior immutable application artifact and repeat acceptance.
- Before deploying any artifact that predates migration `0030` and the per-organization runtime gate, set `BUSINESS_WRITES_ENABLED=false` and keep it false. Those artifacts understand only the global switch and are safe against the forward schema only as read-only fallbacks; a true global gate would authorize every otherwise eligible real organization.
- If the schema is incompatible, keep writes disabled and apply a reviewed forward repair migration. Do not run an ad hoc down migration.
- Never delete the PostgreSQL volume, restore over the live database, or replace an encryption key to make an old artifact start.
- A database restore is a disaster-recovery operation into an isolated empty destination, not the normal application rollback mechanism.

For a compatible application-only rollback, keep schedulers paused and use the checksummed evidence from either the failed attempt or the last accepted release. The tool verifies every evidence checksum, the retained `sha256:` image ID, and its OCI revision; it forces all login, write, delivery, and bank-feed gates off and never runs a database down migration:

```bash
export ROLLBACK_SCHEMA_COMPATIBLE_ACK=application-only-forward-schema
bash deploy/release/run-application-rollback.sh \
  --evidence /var/lib/business-finlynq/release-evidence/<candidate-sha>/<run-id> \
  --environment /etc/business-finlynq/compose.env \
  --scheduler systemd
```

Use `--scheduler cron` only on the reviewed deploy-owned fallback. The rollback tool first acquires the same complete scheduler pause/drain boundary as a release. It materializes the exact candidate Git tree, snapshots and hashes the canonical Compose environment, and requires exactly one current app container whose image ID and OCI revision match either the evidence candidate or the retained previous artifact. The latter explicitly preserves rollback after a failure that stopped the previous app before candidate creation. The observed artifact and runtime state are recorded. The tool binds the retained app to its exact local image ID with pulling/building disabled and arms an `EXIT` containment trap before starting it. It then verifies that image/revision and every login, delivery, write, Turnstile, and bank-feed gate from the container itself. Success provides degraded read-only informational/readiness service, durably writes and fsyncs a private sibling rollback-evidence record, disarms containment only after that evidence succeeds, and intentionally leaves schedulers paused. Any acceptance/evidence failure stops both app and auth worker. Re-enable a prior authenticated surface only through a separately reviewed compatibility decision; apply a forward repair rather than changing keys, volumes, or migration history.

### One-release f8485 credential adapter

The retained pre-file-secret app (`f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107`) predates the file-based app database password contract. Its deployed image ID was recorded as `sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5`; the one-release override hard-pins that retained local image and uses `pull_policy: never`. This override is deliberately target-server-specific: it works only while that exact recorded image remains in the target server's local image store. `deploy/rollback/docker-compose.legacy-inline-password.yml` mounts the normal app password file and replaces only the old container entrypoint with a restricted adapter. The adapter validates the file and exact revision, exports the legacy variable only inside that container, and may execute only `node server.js`. The password is never rendered into Compose, a command argument, or the new app container.

This rollback is intentionally a degraded availability mode: the override forces demo login, demo writes, real account login and signup, email delivery, Turnstile, and business writes off. It can keep readiness and the public informational surface available while a forward repair is prepared, but it cannot provide an authenticated workspace. Migration `0012` replaced the legacy demo-session function, so neither the synthetic demo nor any account workflow is compatible with f8485 after the current forward migrations.

Before the release, rehearse the retained target-server image against an isolated current-schema restore and archive the degraded readiness/disabled-login result. The legacy rehearsal shares the production restore-drill lock, requires `BUSINESS_FINLYNQ_IMAGE_REVISION` to identify the current reviewed release, captures and label-verifies the current app/migrator/operations images, and pins every restore/rehearsal service plus the retained f8485 image to immutable local IDs with pulling/building disabled. On that target server, with the restore secrets and backup manifest configured, run:

```bash
export ROLLBACK_COMPATIBILITY_ACK='f8485-one-release-only'
./deploy/rollback/run-legacy-restore-rehearsal.sh
```

The command restores only into the tmpfs-backed `restore_database`, runs current forward migrations plus all three role reconcilers, verifies restored key recovery before creating any new demo key, recreates the demo-sandbox baseline for the current release, starts the hard-pinned image as `rollback_rehearsal_app` on only the internal restore network, and runs `verify-legacy-app.sh`. That verifier proves readiness and that demo login remains disabled without issuing a session. It publishes no port and cleans up only the explicitly named disposable restore/rehearsal containers. A missing recorded local image fails closed because pulling and rebuilding are disabled.

During an actual rollback, first keep every login and write gate disabled and confirm the availability-only limitation, then set the acknowledgement:

```bash
export ROLLBACK_COMPATIBILITY_ACK='f8485-one-release-only'
docker compose \
  -f docker-compose.yml \
  -f deploy/rollback/docker-compose.legacy-inline-password.yml \
  config --quiet
docker compose \
  -f docker-compose.yml \
  -f deploy/rollback/docker-compose.legacy-inline-password.yml \
  up --detach --no-deps app
ROLLBACK_APP_URL=http://127.0.0.1:3100 ./deploy/rollback/verify-legacy-app.sh
```

Record the old image digest and acceptance output, then move forward to a fixed current artifact. Do not advertise or enable the demo/account workspace on this fallback, reuse the adapter for another revision, or retain it beyond the next successful release.

## Account/login enablement

Before setting `ACCOUNT_LOGIN_ENABLED=true`:

- mount a valid Resend key through `AUTH_RESEND_API_KEY_FILE` into the authentication worker only;
- set and validate `AUTH_EMAIL_DELIVERY_ENABLED=true`, `AUTH_EMAIL_PROVIDER=resend`, sender, and optional reply-to;
- enable the `auth-email` Compose profile and confirm the worker remains healthy;
- set `MONITOR_EXPECT_AUTH_EMAIL_WORKER=true` and prove a stopped worker triggers an external alert;
- invite a controlled test identity, verify one-use recovery delivery and session revocation, then revoke that identity;
- confirm generic rate-limited responses and external alerts for delivery failures.

Create invitations only through the isolated owner-only operations container. With the identity secret and non-secret delivery metadata configured, run `docker compose --profile account-operations run --rm --no-deps invite_account` followed by the documented `--organization`, `--role`, `--email`, `--name`, and optional `--invited-by` arguments. The command only queues delivery in PostgreSQL, has no egress network, and never receives the provider key. The app and email worker never receive the owner database credential.

Never pass a provider key inline in the production environment. The worker fails closed when its mounted provider secret is absent or invalid. The app never sees that key; when real accounts are enabled its readiness instead fails closed unless non-secret delivery metadata is valid and the database reports a fresh worker heartbeat with no stuck or seriously delayed delivery.

## Organization write activation

`ACCOUNT_LOGIN_ENABLED` and `BUSINESS_WRITES_ENABLED` do not activate a tenant by themselves. Real writes require the global gate and the exact active `REAL` organization UUID to be enabled through the audited owner-only operator command. Follow [Real-account activation and emergency write disable](./real-account-activation.md) for staging, two-person pilot acceptance, control-organization proof, audit evidence, support triage, and emergency disable. Never update `organizations.writes_enabled_at` directly.
