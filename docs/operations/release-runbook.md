# Production release runbook

Use this checklist for every Business Finlynq release. Releases are commit-addressed and migrations are forward-only.

Before pushing the candidate, run `npm run check:predeploy`. This portable local
preflight catches Drizzle declaration and journal-seed drift, lint and type
errors, ordinary test failures, and production-build failures without waiting
for a hosted runner. It does not replace the authoritative `quality-gate`,
which additionally verifies the Compose and systemd contracts, a live
PostgreSQL migration and grant lifecycle, hardened container builds, and the
Playwright browser release gate. Windows preflight runs skip the Unix-only
Bash/jq document-provider deployment fixtures; the Linux quality gate runs
them before it can publish a deployment signal.

## Required evidence before deployment

- CI passed lint, type checking, all unit/PostgreSQL tests, production build, high-severity production dependency audit, and Playwright release gates.
- The candidate image was built from the exact reviewed Git SHA and `BUSINESS_FINLYNQ_IMAGE_REVISION` is that full SHA.
- An encrypted off-site backup completed and its remote checksum was verified. Before the release backup, the receiver allowlist contains both the still-running source revision and the candidate revision used by the backup tool.
- The most recent restore drill is within 30 days and includes separate key recovery.
- Database capacity, disk, TLS, external uptime monitor, alert delivery, and auth email worker health are green.
- Any migration was reviewed for locks, runtime-role grants, backup-role grants, rollback compatibility, and required forward repair.
- The last shared-demo nightly reset passed, the durable state is READY with a future boundary, and the single scheduler is enabled on hosts that allow writable demos.
- The mandatory operations environment contains the full release SHA, matching monitor revision, every app-gate expectation, and the reviewed shared-demo maintenance expectation.
- The external change record or standing on-call schedule names one operator for the release and another for rollback/acceptance. These human assignments are not fields in the runner's checksummed evidence.

## Scripted release contract

`deploy/release/run-release.sh` is the authoritative application-update path. It refuses a dirty checkout, an abbreviated or non-HEAD revision, a reused evidence run ID, a permissive environment file, a revision mismatch, a mutable/non-addressed release image, or an unsafe rehearsal resource. It materializes the exact candidate Git object tree into a private directory, retains its Git-tree and file-hash manifests, snapshots both reviewed environment files as mode `0600`, and uses only those staged assets and snapshots for Compose, helper, test, and systemd-install operations. It builds six commit-tagged images (`database`, `app`, `migrator`, `auth-worker`, `operations`, and browser `acceptance`) plus the separately versioned `business-finlynq-release-router:v1`. The stable router is built through the canonical `business-finlynq-release-router-build-v1` Compose project, carries revision `release-router-v1` and contract label `v1`, and is excluded from ordinary commit-addressed build and cleanup sets. Router contract changes require a new router version and dedicated rollout; do not reuse `v1` for changed content. Image-config/history timestamps are pinned and local BuildKit provenance and SBOM attestations are disabled so repeated exports of the same reviewed inputs retain one Docker image identity. The runner verifies each immutable Docker image ID and OCI revision label, then pins every release-run service to the captured `sha256:` image ID with pulling and building disabled before any production database operation. The release's protected Git-tree manifests, revision labels, image IDs, logs, and checksummed evidence remain the local audit record; standardized BuildKit attestations are not attached to these host-local images. The database image is based on the immutable PostgreSQL digest and embeds the first-cluster role initializer, so accepted containers never depend on a temporary host bind. The acceptance image is based on the exact Playwright version and immutable official-image digest committed in the Dockerfile; it contains its own Node runtime, npm-installed lockfile dependencies, Chromium, and browser libraries, so the production host needs Docker but does not need host Node, npm, `node_modules`, Playwright browsers, or browser system packages.

The host-side release and monitoring scripts require `jq`. Production release mode supports only the root-managed systemd scheduler and must be run with the authority to control its units; there is no rootless or cron release fallback. Continuous-deployment hosts additionally require GitHub CLI 2.100.0 or newer at the non-symlink, root-owned `/usr/bin/gh` path with mode `0755`. The deployment verifier uses an isolated configuration, needs no GitHub credential, pins the reviewed production-signaling and quality-gate workflow blob digests, and reuses only root-owned Sigstore/TUF metadata under `/var/cache/business-finlynq/github-attestations` so routine verification is both exact and fast. A deliberate workflow change fails closed until the installed root verifier is reviewed and refreshed.

### Release-router availability contract

The stable v1 router owns loopback port `3100` and the production edge alias; the app has only the private `release-app:3000` alias. Its dedicated state volume contains a durable `active` or `maintenance` sentinel, and an absent, malformed, or unsafe sentinel fails closed to maintenance on restart. Maintenance is persisted before its Caddy reload. Active routing is reloaded while durable state deliberately remains `maintenance`; the runner first writes a protected `terminal-evidence-pending` finalization marker, synchronizes terminal evidence, upgrades that marker to `active-commit-authorized` with the evidence SHA-256 digest, atomically and synchronously commits the `active` sentinel, and then clears the marker. Routine application releases reuse the attested running router and never force-recreate it. The one-time transition from the legacy app-owned port is the exception: the runner attests and stops the exact legacy app, disconnects its stopped public-edge alias before creating the router in maintenance, and reconnects that exact alias only when a pre-mutation recovery restores the old app. Steady-state checks include stopped endpoints, so an abandoned alias cannot later restart into ambiguous Docker DNS.

Before stopping an app, the runner proves maintenance while that app is still healthy and waits for established router-to-app connections to drain. `/api/live` remains `200`; public `/api/health` and all public application routes return non-cacheable `503` with bounded retry advice. Candidate health and browser acceptance use a new random 256-bit preview token for that release only. It is carried as a standard `Authorization: Bearer` credential so Caddy redacts it by default; external-edge verification rejects both source and loaded configurations that enable credential logging. The token is confined to the runner's bounded probes and acceptance container, stripped before the app and from cross-origin browser requests. Never persist, reuse, disclose, or use it for interactive maintenance access.

The public maintenance interval begins when maintenance is confirmed and ends when the final app and optional worker identities, internal readiness, reviewed gates, and browser checks pass and the existing router is atomically reloaded live-active. Final public readiness and, when configured, the production-scoped external-edge contract are verified immediately. Scheduler installation, resume, accounting evidence, and the installed monitor then run with the accepted application visible but durable router state still fail-closed; any failure drives the router back to maintenance and contains the candidate. Terminal evidence is sealed and hashed into the authorized finalization marker before the durable state becomes `active`. The stable listener is never restarted. An eligible online backup runs before maintenance; otherwise only the quiesced backup, migration, role/schema reconciliation, bootstrap, and acceptance extend the maintenance interval.

The production mode is deliberately for updating an existing release: it requires the running app so its exact prior image ID and OCI revision can be retained. Use rehearsal mode to prove clean installation. The script performs, in order:

1. validate the exact clean Git SHA, rendered Compose boundary, production origin/cookies, target gates, monitor expectations, and private evidence paths;
2. build and record the candidate image IDs before changing runtime state;
3. retain and attest the previous app and optional auth-worker image IDs/revisions, durably pause and drain the systemd scheduler, prove the legacy cron scheduler inactive, contain any orphaned scheduled one-shot container, provision the backup role, and—only when the worker is absent and sanitized database inspection reports zero active client transactions, unlogged relations, sequences, foreign tables, and prepared transactions—attempt an online backup before maintenance;
4. atomically enter and prove durable router maintenance, stop the auth worker, drain in-flight router-to-app requests, stop the app, and prove every client session in the application database gone. Reuse the online artifact only when the database container, system identifier, timeline, database name, eligibility, and WAL insert LSN remain exact; otherwise create one quiesced backup with a 300-second ceiling. Verify the precise producer-emitted manifest, then run migration, all role reconcilers, the exact schema/RLS/grant and journal-type verifiers, and the full audit-graph/request-outbox integrity verifier before traffic is restored;
5. run additive bootstrap, persist and verify the post-bootstrap accounting-evidence result, prove candidate readiness with every gate disabled, then use the private preview route to run the immutable, secretless browser-acceptance container while public application traffic remains in maintenance and real-business writes and live bank feeds remain disabled;
6. only after browser acceptance, recreate the app from the same immutable image ID with the reviewed final gate posture, verify exact app/worker identities and internal readiness, prove maintenance remains in place, reload the existing router live-active without changing its durable maintenance sentinel, then verify final public readiness and the production-scoped external-edge contract when configured; and
7. recheck the canonical environments, install and byte-verify all eight systemd service/timer files, resume the systemd scheduler, run fresh accounting and production-monitor checks, seal and synchronize checksummed terminal evidence, upgrade the finalization marker with that evidence digest, atomically persist the router's `active` sentinel last, and clear the marker. Database rollback remains forward-repair-only.

Any failure first tries to retain or restore router maintenance before containing the candidate, and leaves the scheduler paused. Before database mutation, the runner automatically restarts and attests the exact retained app and, when previously running, the exact auth worker before waiting on health; it then reloads the stable router active and records recovery evidence. Failure to prove that recovery remains fail-closed and requires operator action. At or after database mutation, it does not guess compatibility or automatically restore an old app. If the final production monitor fails after scheduler resume, the failure trap re-pauses it before stopping the candidate. A host loss after durable terminal evidence but before the final active sentinel is handled by the same-revision continuous-deployment finalizer only while the `active-commit-authorized` marker is at most one hour old and its exact evidence digest, revision, run, app/router identities, detailed health, scheduler posture, and live route all revalidate. A pending, stale, malformed, or mismatched marker cannot authorize activation. Do not manually resume a failed release or delete a finalization marker. Review `99-failure.json`, service logs, and `SHA256SUMS`; use the application-only rollback tool only after confirming forward-schema compatibility.

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

Release mode accepts only `--scheduler systemd` and requires authority to stop/start the four Business Finlynq timers (backup, monitor, accounting evidence, and demo reconciliation). Compose and operations environment files, the evidence root, and the backup directory must stay outside the Git checkout so secret or generated state can never enter the commit-addressed Docker build context. The script rechecks that the checkout is clean immediately before and after the build. The evidence root and the release image IDs must be retained at least through the next accepted release.

`RELEASE_EXECUTION_ACK` binds a command to one mode, revision, and run ID; it is an execution guard, not a human approval signature. Manual releases link the external change/witness record that names the release and rollback owners. Automatic `main` deployment relies on the reviewed CI signal and standing on-call assignments. Neither form writes people or approval assertions into `90-release-complete.json`.

Planned maintenance must use the same automation boundary as a release. Stop and disable both the continuous-deployment service and timer, acquire an exclusive hold on `/var/lib/business-finlynq/deployment-host.lock` for the entire maintenance window, and pause and drain every production scheduler before entering router maintenance. Refuse to begin while a finalization marker exists, and never delete one manually: it represents protected in-flight release authorization, not deliberate maintenance. Re-enable automation only after independently verifying the intended final router and scheduler state.

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

# Root-managed systemd host
sudo env \
  "SCHEDULER_BOUNDARY_BOOTSTRAP_ACK=pause-before-checkout:$source_revision:$revision:systemd" \
  bash "$bootstrap_root/repository/deploy/release/bootstrap-scheduler-boundary.sh" \
    --candidate-revision "$revision" --scheduler systemd
```

The bootstrap binds its three executable assets to the candidate Git objects, removes only the exact old managed cron block when applicable, disables and drains every installed legacy systemd timer/service, accepts an explicitly `not-found` candidate-new unit, proves both scheduling mechanisms and scheduled one-shot containers inactive, and atomically records the source/candidate receipt. Leave the marker and receipt in place, check out the candidate, then run the normal root/systemd release command. A successful release installs the new boundary, runs its installed monitor, writes `scheduler-boundary.json`, and retires the one-time receipt. There is no cron variant of this production release bootstrap. Do not recreate a receipt manually or resume a failed bootstrap/release.

The production release backup has two bounded paths. When the auth worker is absent and database inspection is online-safe, the runner permits up to 900 seconds for an online encrypted/off-site backup while the old app remains public. After write-surface drain it reuses that artifact only if exact database identity and WAL boundaries are unchanged. An active worker, unsafe relation/transaction semantics, WAL advance, or identity change selects a quiesced backup capped at 300 seconds. In every path the producer emits one exact committed manifest basename only after required remote commit, and the verifier checks that basename rather than “latest.” Timeout/failure contains and removes the exact one-off backup container, and before database mutation restores the old release when maintenance had begun. `SCHEDULED_BACKUP_TIMEOUT_SECONDS` still bounds isolated rehearsals and scheduled backups up to 5,400 seconds; it cannot widen the production online or quiesced caps.

If a candidate is superseded after this bootstrap has paused the schedulers but before the canonical checkout changes, leave the protected marker and receipt in place. Fetch the newer descendant commit and rerun its exact archived bootstrap with a new acknowledgement. The bootstrap accepts this retarget only when the source checkout is still unchanged and clean, the prior receipt and marker have exact protected contents and ownership, the earlier candidate is an ancestor of the newer one, and every scheduler remains paused. It then atomically replaces the receipt without briefly reinstalling the legacy schedule. Any other partial or unrelated state fails closed.

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

### Fresh contained production bootstrap

Use `deploy/production/install-initial-production.sh` only for a fresh production host. Run every phase as root from the clean, pre-cloned `/home/deploy/business-finlynq` checkout at the exact full reviewed and attested SHA on `main`. The host must be an explicitly supported Ubuntu 24.04 or 26.04 system with synchronized time, Docker Compose 2.39.0 or newer with explicit provenance and SBOM build controls, `jq`, root-owned `/usr/bin/gh` 2.100.0 or newer at mode `0755`, and the required `deploy` account and secret group. The installer verifies the same candidate-bound keyless production signal before its first production-state mutation. Node, npm, Playwright, and browser libraries are not host prerequisites; the immutable acceptance image runs the rehearsal pair verifier.

The bootstrap is deliberately split so the shared EPM-owned edge and development public acceptance can be established before the first production database is created:

```bash
revision="<full-reviewed-production-sha>"

# Phase 1: creates and attests only business_finlynq_edge.
sudo bash deploy/production/install-initial-production.sh \
  --revision "$revision" \
  --prepare-edge-network-only

# From the exact development checkout/revision, first establish its internally
# accepted backend and external-owner ingress network. The timer stays off.
sudo bash deploy/development/install-development.sh \
  --external-edge --skip-public-acceptance
sudo /usr/local/sbin/business-finlynq-deploy-development

# Apply the separately reviewed root-owned shared-edge handoff now. It must
# promote the Business route as root:root 0444, attach the edge owner to the
# exact four-network set, recreate it, and write the protected contract source.
# The production route may return 502/503 until the production app joins.

# Phase 2: installs durable contained configuration but starts no service.
sudo bash deploy/production/install-initial-production.sh \
  --revision "$revision" \
  --prepare-configuration-only \
  --backup-age-recipient-file /root/business-finlynq-backup-age-recipient.txt \
  --external-edge-contract-file \
    /var/lib/business-finlynq-ovh-edge-handoff/active/edge-contract.env

# From the exact development checkout/revision, recreate the existing dev
# configuration with external edge plus strict public acceptance. This changes
# only the edge/public-acceptance setting; all other reviewed development gates
# retain their existing development values.
sudo bash deploy/development/install-development.sh \
  --external-edge --require-public-acceptance
sudo /usr/local/sbin/business-finlynq-deploy-development

# Phase 3: reattests dev/shared edge, runs two isolated rehearsals, and performs
# the contained initial production release.
sudo bash deploy/production/install-initial-production.sh \
  --revision "$revision" \
  --run-provisioned
```

The only age material installed on the VPS is the public recipient. Initial mode enables only synthetic demo login and demo writes. Account login/signup, email delivery, Turnstile, real business writes, bank feeds, Yahoo FX, and external providers remain disabled. It migrates a fresh database, starts and probes the pinned evidence scanner, creates and verifies a local encrypted backup, records off-site delivery as deferred, runs fresh accounting and monitor one-shots, and installs all four operation timers but leaves them disabled and inactive. Production continuous deployment is not installed or enabled, and the development deployment timer remains disabled.

Configuration preparation is journaled and retryable with the exact same recipient and edge-contract inputs. Rehearsal failures retain immutable evidence; rerunning `--run-provisioned` before any production initial attempt starts a new timestamped two-rehearsal batch. Once an initial attempt exists, never delete or alter its evidence:

- For an exact failure before production resources were created and before the full resume inventory exists, review its `99-failure.json`, then use `--retry-pristine-initial <failed-run-id>`. The installer requires an allowlisted early stage, exact checksums, an empty production runtime, and disabled deployment automation, and writes a protected authorization receipt before assigning the new run ID.
- For a later failed initial with the full input/image/rollback inventory, use `--resume-initial <failed-run-id>`. The runner binds the retry to that exact parent evidence, configuration and secret hashes, image IDs, labeled resources, and stopped/healthy container posture.
- If the runner produced checksummed accepted evidence but the wrapper could not publish `initial-install-complete.json`, use `--finalize-accepted-initial <accepted-run-id>`. This narrowly accepts a terminal `99-failure.json` only at `complete-evidence`, rechecks the exact evidence inventory, rehearsals, live image IDs, loopback port, mounts, networks, contained gates, shared edge, fresh accounting/monitor one-shots, and disabled timers before atomically recording completion.

All recovery commands take the shared deployment-host lock and fail closed if development or production automation overlaps. Do not enable any timer, continuous-deployment receiver, real/customer gate, provider credential, or off-site requirement as part of this contained initial procedure; those are separate reviewed post-migration changes.

## Deployment

The sequence below explains the controls enforced by the scripted path. Do not substitute an ad hoc copy/paste deployment for `run-release.sh`.

Normal `main` releases may be triggered by the root-managed, keyless-attestation CI/CD path documented in [Continuous deployment from main](./continuous-deployment.md). After `quality-gate` succeeds for a same-repository `main` push, GitHub OIDC/Sigstore attests a deterministic repository/revision manifest and publishes the bundle as an untrusted asset on the deliberately mutable `production-deployment-signals` release. The host anonymously downloads that bundle and uses root-owned GitHub CLI 2.100.0 or newer to verify the exact repository, workflow certificate identity, issuer, signer/source SHA, source ref, hosted-runner policy, predicate, and manifest bytes locally. It stores no GitHub credential. Missing transport or verification failure occurs before the receiver allowlist or deployment state is mutated. This trigger does not replace the release runner or any controls below; after validating the exact fast-forward `origin/main` revision, it prepares the off-server receiver allowlist and invokes this same systemd release command. A post-mutation failure is latched for explicit operator review rather than retried automatically.

The fixed signal release must remain mutable; GitHub immutable releases are incompatible with the current uploader. Before its 1,000-asset capacity is reached, perform a reviewed rotation/archive that preserves every SHA referenced by current `main`, the running revision, the failure latch, the active-finalization marker, and every recovery journal on every production host. Never prune by age alone. A reviewed per-candidate or sharded transport may instead replace both publisher and verifier before immutable releases are enabled.

1. Materialize and hash the exact Git tree, snapshot the reviewed environments, build all six commit-addressed targets, separately build and attest the stable v1 router, capture their image IDs/OCI labels, and retain the current application image ID and revision. Do not use an unreviewed working tree or a live mutable Compose file.
2. Disable and drain every installed Business Finlynq systemd timer/service, prove the legacy cron scheduler and labeled scheduled one-shot containers inactive, then atomically enter and verify durable router maintenance while the old app is healthy, stop the authentication worker, drain router-to-app connections, stop the app, prove both database sessions disconnected, and keep public application traffic in maintenance.
3. With all write surfaces still stopped, run the bounded encrypted backup and exact backup verifier, including its off-site marker. Keep the app and worker stopped through migration and every pre-traffic verifier.
4. Recreate PostgreSQL against the existing data volume with the captured immutable database image, wait for health, and retain structured evidence that the running container uses that exact image ID. Only then run the immutable-ID-pinned migrator as database owner. Before bootstrap or app startup, run the mandatory post-migration runtime, authentication-worker, and backup-role reconcilers plus schema/RLS/grant, journal-type, and accounting-evidence verifiers.
5. Run `bootstrap_demo`, retain accounting-evidence verification, start the immutable candidate with all gates disabled, and complete readiness plus shared-browser acceptance through the ephemeral private preview route. Bootstrap is idempotent while the baseline is current; a due or failed shared demo is fully reset before entry reopens.
6. Recreate the app and optional auth worker from the same captured IDs with the reviewed final gates. Verify exact IDs/labels, internal readiness, and environment stability; prove maintenance is still active, then atomically reload the existing router active.
7. After activation, verify public `/api/live`, minimal public `/api/health`, the external-edge contract when configured, loopback-only detailed readiness, response security headers, release revision, and auth-worker state. Confirm public readiness contains neither `checks` nor `revision`.
8. Install and verify the backup and systemd scheduler assets, resume that scheduler, and run fresh accounting-evidence and installed production-monitor checks. A failure here re-enters maintenance and re-pauses scheduling before candidate containment.
9. Synchronize terminal completion and checksummed evidence, bind its digest into the authorized finalization marker, persist the router's durable `active` sentinel, clear the marker, and retain the evidence links, backup checksum, and immutable image IDs. A write-capable final gate posture may be activated only after tenant isolation, posting authorization, idempotency, audit insertion, period controls, and browser acceptance pass. Link the separate external change/witness record for named operator ownership or approvals rather than representing it as runner-generated evidence.

The release runner supplies `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_MANAGED_SERVER=true`, the ephemeral release-preview token, `E2E_EXPECT_ACCOUNT_LOGIN_ENABLED`, and `E2E_EXPECT_ACCOUNT_SIGNUP_ENABLED` to the acceptance container from the snapshotted, reviewed Compose environment. Playwright adds the token only to same-origin candidate requests and removes it from cross-origin requests; the router removes it before the app. The managed-server marker prevents Playwright from trying to start a local application inside the secretless acceptance image; normal CI browser runs omit it and start the build they just reviewed. The release runner starts the container only by its captured immutable image ID, gives it no deployment secret or host bind mount, bounds it to 30 minutes, retains its timestamped output in `70-browser-acceptance.log`, and stops/removes it on success, failure, signal, or timeout. Do not replace that gate with a host `npm run test:e2e`; doing so would lose the attested image, private-preview boundary, and containment controls.

The browser test requires the previewed `/api/health` response to retain the minimal ready contract and requires Cloudflare's widget API to render its response control on the candidate signup page. Uncredentialed public health must remain `503` until the final active reload. After activation, the host monitor checks the detailed flag posture and email-worker readiness over loopback and the release verifies minimal public readiness. Managed challenges may solve without exposing a visible iframe, and Cloudflare does not guarantee that iframe as a public integration contract.

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

Use `--scheduler cron` only on the reviewed deploy-owned fallback. The rollback tool first acquires the same complete scheduler pause/drain boundary as a release and attests the evidence-authorized stable v1 router. It materializes the exact candidate Git tree, snapshots and hashes the canonical Compose environment, and requires exactly one current app container whose image ID and OCI revision match either the evidence candidate or the retained previous artifact. The latter explicitly preserves rollback after a failure that stopped the previous app before candidate creation. The tool records the observed artifact and runtime state, atomically enters and proves maintenance, stops the worker, drains in-flight router connections, stops the app, and binds the retained app to its exact local image ID with pulling/building disabled. Its `EXIT` trap keeps or restores maintenance before containing a failed rollback. The retained app is accepted internally with every login, delivery, write, Turnstile, and bank-feed gate disabled; only then is the existing router reloaded live-active, public readiness is verified, and production-scoped edge verification proves the exact previous revision. Success provides degraded read-only informational/readiness service, durably writes and fsyncs a private sibling rollback-evidence record, and persists the router's `active` sentinel last; schedulers intentionally remain paused. Preflight or evidence failures before rollback mutation leave the currently deployed runtime unchanged; once rollback mutation begins, any acceptance or evidence-publication failure leaves application traffic fail-closed. Re-enable a prior authenticated surface only through a separately reviewed compatibility decision; apply a forward repair rather than changing keys, volumes, or migration history.

### One-release f8485 credential adapter

The retained pre-file-secret app (`f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107`) predates the file-based app database password contract. Its deployed image ID was recorded as `sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5`; the one-release override hard-pins that retained local image and uses `pull_policy: never`. This override is deliberately target-server-specific: it works only while that exact recorded image remains in the target server's local image store. `deploy/rollback/docker-compose.legacy-inline-password.yml` mounts the normal app password file and replaces only the old container entrypoint with a restricted adapter. The adapter validates the file and exact revision, exports the legacy variable only inside that container, and may execute only `node server.js`. The password is never rendered into Compose, a command argument, or the new app container.

This rollback is intentionally a degraded availability mode: the override forces demo login, demo writes, real account login and signup, email delivery, Turnstile, and business writes off. It can keep readiness and the public informational surface available while a forward repair is prepared, but it cannot provide an authenticated workspace. Migration `0012` replaced the legacy demo-session function, so neither the synthetic demo nor any account workflow is compatible with f8485 after the current forward migrations.

Before the release, rehearse the retained target-server image against an isolated current-schema restore and archive the degraded readiness/disabled-login result. The legacy rehearsal shares the production restore-drill lock, requires `BUSINESS_FINLYNQ_IMAGE_REVISION` to identify the current reviewed release, captures and label-verifies the current app/migrator/operations images, and pins every restore/rehearsal service plus the retained f8485 image to immutable local IDs with pulling/building disabled. On that target server, with the restore secrets and backup manifest configured, run:

```bash
export ROLLBACK_COMPATIBILITY_ACK='f8485-one-release-only'
./deploy/rollback/run-legacy-restore-rehearsal.sh
```

The command restores only into the tmpfs-backed `restore_database`, runs current forward migrations plus all three role reconcilers, verifies restored key recovery before creating any new demo key, recreates the shared-demo baseline for the current release, starts the hard-pinned image as `rollback_rehearsal_app` on only the internal restore network, and runs `verify-legacy-app.sh`. That verifier proves readiness and that demo login remains disabled without issuing a session. It publishes no port and cleans up only the explicitly named disposable restore/rehearsal containers. A missing recorded local image fails closed because pulling and rebuilding are disabled.

During an actual rollback, confirm the availability-only limitation and invoke the same evidence-bound rollback runner used for current artifacts. The runner detects the exact f8485 revision and image in the accepted release evidence, requires the additional one-release acknowledgement, layers the adapter into its private Compose snapshot, enters and proves router maintenance, pauses schedulers, and runs the dedicated legacy acceptance check before its active-last commit:

```bash
export ROLLBACK_SCHEMA_COMPATIBLE_ACK='application-only-forward-schema'
export ROLLBACK_COMPATIBILITY_ACK='f8485-one-release-only'
bash deploy/release/run-application-rollback.sh \
  --evidence /var/lib/business-finlynq/release-evidence/<candidate-sha>/<run-id> \
  --environment /etc/business-finlynq/compose.env \
  --scheduler systemd
```

Do not start the legacy app with raw `docker compose`: that bypasses the host/release locks, scheduler drain, maintenance-first routing, exact evidence binding, and failure containment. Port 3100 belongs to the stable release router, not directly to the app. Preserve the generated rollback evidence, then move forward to a fixed current artifact. Do not advertise or enable the demo/account workspace on this fallback, reuse the adapter for another revision, or retain it beyond the next successful release.

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

`ACCOUNT_LOGIN_ENABLED` and `BUSINESS_WRITES_ENABLED` do not activate a tenant by themselves. Real writes require the global gate plus the exact active `REAL` organization layer. Completed self-service owner signup enables that organization layer atomically and audibly; operator-managed tenants and any re-enablement after an explicit disable use the owner-only operator command. Follow [Real-account activation and emergency write disable](./real-account-activation.md) for the automatic-signup boundary, staged pilots, control-organization proof, audit evidence, support triage, and emergency disable. Never update `organizations.writes_enabled_at` directly.
