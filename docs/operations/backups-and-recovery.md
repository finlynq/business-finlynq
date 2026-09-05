# Backups and recovery runbook

This runbook covers the encrypted logical PostgreSQL backup shipped with Business Finlynq. It is designed so the production VPS holds only an age **recipient** (public key). The corresponding age identity, organization wrapping key, and identity-encryption secret must be escrowed separately. A database dump by itself is not a recoverable Business Finlynq system.

## Recovery objectives and retention

- Baseline logical-backup recovery point objective (RPO): under 6 hours between the selected completed, checksum-valid off-site recovery point and declaration of recovery. The supplied systemd timer starts every four hours with up to ten minutes of jitter; the remaining 1 hour 50 minutes is an operational completion/alert buffer, not permission to skip a run. The five-minute monitor alerts when the newest completed recovery point reaches 6 hours.
- Baseline recovery time objective (RTO): no more than 4 hours from starting the documented restore sequence with the encrypted set and escrowed secrets available until restored runtime acceptance completes.
- Local encrypted sets: 14 days by default.
- Off-site encrypted sets: configure an immutable/object-lock bucket lifecycle for at least 35 daily recovery points and 12 monthly recovery points.
- Restore drill: monthly, before enabling real accounting writes, after any key procedure change, and before a server move.
- Migration backup: take and verify a separate backup immediately before every production migration.

The earlier six-hour schedule plus jitter and 8-hour freshness alert did not satisfy the recorded under-six-hour objective. Both schedules now run every four hours and the alert/evidence thresholds are six hours. A lower RPO or point-in-time recovery requires archived PostgreSQL WAL or a managed PostgreSQL service; logical dumps do not provide PITR. The local script never deletes remote objects. Remote retention and immutability are enforced by the storage provider.

## One-time provisioning

1. On a secured administrator workstation, install `age` and run `age-keygen`. Store the generated identity in an offline password vault or recovery medium. Copy only its `age1...` recipient to `/etc/business-finlynq/backup/age-recipients.txt` on the VPS.
2. Create a unique 32-or-more-character database password at `/etc/business-finlynq/secrets/backup-db-password`. This credential is only for `business_finlynq_backup`.
3. Configure an rclone remote backed by a different provider/account or failure domain. Store its minimal-scope config at `/etc/business-finlynq/secrets/rclone.conf`. Limit it to the Business Finlynq backup prefix and enable provider-side object lock/versioning.
4. Create `/var/backups/business-finlynq`, owned by container UID/GID `70:70`, mode `0700`. The backup container runs without root and must be able to create files there.
5. Put the following in the root-readable Compose/operations environment, with real paths and remote name:

   ```dotenv
   BACKUP_DATABASE_PASSWORD_FILE=/etc/business-finlynq/secrets/backup-db-password
   BACKUP_AGE_RECIPIENT_FILE=/etc/business-finlynq/backup/age-recipients.txt
   BACKUP_RCLONE_CONFIG_FILE=/etc/business-finlynq/secrets/rclone.conf
   BACKUP_RCLONE_REMOTE=offsite:business-finlynq/database
   BACKUP_LOCAL_DIR=/var/backups/business-finlynq
   BACKUP_LOCAL_RETENTION_DAYS=14
   BACKUP_REQUIRE_OFFSITE=true
   MONITOR_MAX_BACKUP_AGE_HOURS=6
   MONITOR_REQUIRE_OFFSITE=true
   ```

6. Build the `operations` target and run the first backup manually:

   ```bash
   docker compose --profile operations build provision_backup backup
   ./deploy/backup/run-scheduled-backup.sh
   ```

The first step provisions a dedicated login role with `SELECT`, `CONNECT`, and schema usage only. It has `BYPASSRLS` because a complete logical database dump must include every tenant; it is not a superuser and cannot create databases, roles, or replication slots. It has no inherited roles, is capped at two connections, defaults every transaction to read-only, and the reconciler first removes stale direct grants before restoring the reviewed `SELECT` matrix. Normal Compose startup also runs this reconciler after every migration and refuses to bootstrap the demo or start the app when the backup credential or grant reconciliation is unavailable.

The `backup` build also tags the exact-release operations image used by `verify_latest_backup`. The production monitor runs that no-network, no-secret UID-70 service with the backup directory mounted read-only; the host deploy account never needs permission to read encrypted archives, manifests, checksums, or upload markers. Host execution is noninteractive and bounded by `MONITOR_BACKUP_VERIFY_TIMEOUT_SECONDS` (90 seconds by default), below the two-minute systemd monitor limit.

## Backup completion criteria

Every successful run produces one atomic set:

- `business_finlynq_<UTC>_<database>.dump.age`: age-encrypted custom-format dump.
- `...manifest.json`: format, source-application revision, backup-tool revision, timestamp, size, retention, and encrypted-archive SHA-256. `applicationRevision` remains the backward-compatible source revision.
- `...sha256`: independently checkable SHA-256 line.
- `...uploaded`: local marker written only after rclone uploaded the archive/checksum, downloaded the remote archive stream, matched its checksum, and uploaded the manifest last.

The backup fails on lock contention, an incomplete dump, encryption failure, remote copy failure, or remote checksum mismatch. Plaintext database bytes stream directly from `pg_dump` into age and are never written to persistent storage. Local pruning only targets manifest-named Business Finlynq sets, stays inside the resolved backup directory, and retains an old set without a successful off-site marker whenever a remote is configured.

Check the most recent run:

```bash
systemctl status business-finlynq-backup.service
journalctl -u business-finlynq-backup.service --since today
ls -l /var/backups/business-finlynq
```

Do not treat a `.dump.age` file without its manifest and matching checksum as a successful backup.

## Installing automation

The supplied systemd timer runs at 00:17, 04:17, 08:17, 12:17, 16:17, and 20:17 UTC with up to ten minutes of jitter. Both systemd and the reviewed cron fallback call the same wrapper, which enforces an end-to-end `SCHEDULED_BACKUP_TIMEOUT_SECONDS` of at most 5,400 seconds. The systemd service has a 95-minute outer safety timeout. Thus a worst-case 4-hour-10-minute launch delay plus a 90-minute backup leaves 20 minutes for receiver acceptance and alerting before the strict six-hour RPO threshold. `MONITOR_MAX_BACKUP_ACTIVE_SECONDS` is capped at 4,800 seconds so a stuck run alerts before the hard kill; an active run never substitutes for freshness of the last completed recovery point.

```bash
install -m 0644 deploy/systemd/business-finlynq-backup.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-backup.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-accounting-evidence.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-accounting-evidence.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor-notify@.service /etc/systemd/system/
systemctl daemon-reload
./deploy/systemd/verify-backup-schedule.sh
systemctl enable --now business-finlynq-backup.timer
systemctl start business-finlynq-backup.service
```

The committed units run from the target checkout at `/home/deploy/business-finlynq` and require `/etc/business-finlynq/operations.env`; a missing release revision or operations file fails scheduled work instead of recording an ambiguous artifact. Release automation installs all four candidate service/timer pairs, runs `systemctl daemon-reload`, and retains verifier output before scheduler resume. The production monitor repeats the byte/property comparison for every pair, including fragment, target, calendar/cadence, jitter, `ExecCondition`, `ExecStart`, `EnvironmentFile`, and timeout. If the checkout moves to an immutable release symlink, update the common condition, `WorkingDirectory`, and `ExecStart` together. Docker access is root-equivalent; keep the deployment account, units, checkout, and Docker socket restricted to administrators.

### Backup-role rollback notes

The role and grants are backward-compatible with an application-only rollback because no application service receives or inherits `business_finlynq_backup`. Keep the password file and role in place while any retained artifact or timer can still take backups. If a release must temporarily disable automated backups, stop and disable `business-finlynq-backup.timer`, record the resulting RPO exception, and use a separately approved backup path before migration or write activity. Do not drop the role merely to make an old Compose file start; an old artifact can ignore it, while dropping it silently breaks recovery coverage. Re-enable by deploying the current operations image, running `provision_backup`, taking a new encrypted backup, and verifying the off-site checksum marker.

## Isolated restore drill

The quality gate performs an additional unencrypted logical-format regression check after the main CI database has been migrated, demo-bootstrapped, reconciled, and exercised by the database tests. `scripts/operations/verify-ci-database-lifecycle.sh restore` uses the read-only backup role for a custom-format `pg_dump`, actually restores the archive transactionally into the fixed loopback sibling `business_finlynq_test_restore_verify`, reruns the canonical migrations and all three role reconcilers, compares populated organization data and the demo sentinel, and runs the schema/grant verifier. The same explicit CI guard and exact cleanup restrictions as the predecessor-upgrade check apply.

That CI check proves PostgreSQL dump/restore compatibility and restored-data presence; it does not exercise age encryption, off-site transfer, escrowed key recovery, or the restored application. It therefore supplements—but never replaces—the production-equivalent encrypted drill below.

Run this on a recovery host, not on the production VPS. The drill uses a dedicated internal Docker network and a PostgreSQL data directory backed only by tmpfs. Its wrapper addresses only the explicitly named `restore_*` services; it never stops, removes, or connects to the production database service.

1. Fetch one completed encrypted set from the receiver vault into a protected recovery-host staging directory: encrypted archive, checksum, manifest, root-generated `*.receiver-receipt.json`, and its 64-byte `*.receiver-receipt.json.sig`. The application host's `.uploaded` marker and an unsigned historical receipt are not receiver-acceptance evidence for G0. The host recovery operator must own the staging tree, group `70` must be the restore-container group, the staging directory must be mode `0750`, and every five artifact files must be single-link regular files mode `0440`. Pre-create `restore-reports/` with the same owner/group and mode `0770`; UID/GID `70` can then read artifacts and write reports without receiving directory-write access over the evidence inputs. For example: `install -d -o deploy -g 70 -m 0750 /secure/recovery/business-finlynq`, `install -o deploy -g 70 -m 0440 <each-artifact> /secure/recovery/business-finlynq/`, then `install -d -o deploy -g 70 -m 0770 /secure/recovery/business-finlynq/restore-reports`. The wrapper validates this contract before any restore container starts. Keep age identities, organization/identity secrets, database passwords, and the receipt public key outside this directory under their existing root/secret-group modes; do not weaken a secret file to satisfy the artifact check.
2. Temporarily supply the age identity, the separately escrowed organization root key, and the separately escrowed identity secret. Create a unique disposable restore database password. Create the host lock directory once for the dedicated recovery operator (normally `deploy`) with `install -d -m 0700 -o deploy -g deploy /var/lib/business-finlynq`; the wrapper opens `/var/lib/business-finlynq/restore-drill.lock` before any Docker work and holds it exclusively for its complete lifetime so another checkout or operator cannot remove or mix the same host's disposable restore services.
3. Set:

   ```dotenv
   BACKUP_LOCAL_DIR=/secure/recovery/business-finlynq
   BACKUP_AGE_IDENTITY_FILE=/secure/recovery/age-identity.txt
   RESTORE_DATABASE_PASSWORD_FILE=/secure/recovery/restore-db-password
   APP_DATABASE_PASSWORD_FILE=/secure/recovery/app-db-password
   AUTH_WORKER_DATABASE_PASSWORD_FILE=/secure/recovery/auth-worker-db-password
   BACKUP_DATABASE_PASSWORD_FILE=/secure/recovery/backup-db-password
   BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE=/etc/business-finlynq/recovery/backup-receiver-receipt-signing-public-key.pem
   BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256=<exact-receiver-public-key-pem-sha256>
   ORGANIZATION_ROOT_KEK_FILE=/secure/recovery/organization-root-kek
   IDENTITY_SECRET_FILE=/secure/recovery/identity-secret
   RESTORE_BACKUP_MANIFEST=business_finlynq_YYYYMMDDTHHMMSSZ_business_finlynq.manifest.json
   RESTORE_REQUIRE_WRAPPED_KEYS=true
   RESTORE_ALLOW_EMPTY_SECRET_FIXTURES=false
   RESTORE_DRILL_LOCK_FILE=/var/lib/business-finlynq/restore-drill.lock
   RESTORE_DRILL_LOCK_WAIT_SECONDS=0
   RESTORE_RPO_SECONDS=21600
   RESTORE_RTO_SECONDS=14400
   RESTORE_REQUIRE_OFFSITE_EVIDENCE=true
   ```

   These are production ceilings, not suggestions: the wrapper and evidence recorder reject `RESTORE_RPO_SECONDS` above `21600` or `RESTORE_RTO_SECONDS` above `14400`. An operator may tighten either objective for a drill, but cannot weaken the recorded under-6-hour RPO or 4-hour RTO through environment configuration. Copy only the receiver's Ed25519 public key over an independently authenticated administrator path and compare its exact lowercase 64-character PEM SHA-256 with both the selected receipt's `signingKeySha256` and the separately recorded receiver provisioning/change ticket before setting the pin; never copy the receiver private key. After a reviewed receiver signing-key rotation, an older retained receipt must be verified with its fingerprint-selected old public key from the retained trusted ring, not whichever key is currently active. Keep the lock at its host-persistent default; only change it to another dedicated-recovery-operator-owned, non-symbolic host path when the recovery host layout requires that. A lock wait of zero fails a concurrent drill immediately; a bounded positive value waits that many seconds.

4. Run:

   ```bash
   docker compose --profile operations --profile auth-email build app migrate backup
   ./deploy/backup/run-restore-drill.sh
   ```

The wrapper rejects ambient Docker daemon/context and Compose file/project/profile selectors, acquires the host-wide lock, and requires the canonical checkout to have an exact `HEAD == BUSINESS_FINLYNQ_IMAGE_REVISION` with no tracked or untracked changes. It then materializes a private `git archive` of that exact commit and resolves every Compose file, relative bind source, and project path from the snapshot with automatic dotenv loading disabled. A release, checkout, or editor changing the live tree after that point cannot alter the drill model. The wrapper proves that every application-owned restore service resolves to the same commit-addressed app, migrator, or operations image, that each local image carries the matching OCI revision label, and that the disposable PostgreSQL image remains digest-pinned. It captures the three immutable image IDs, creates a private no-build/no-pull Compose override that pins all eleven application-owned restore services to those IDs, re-renders and checks every binding, and uses only that snapshot and override for cleanup and execution. Concurrently moving a tag can therefore only make an ID unavailable and fail the drill; it cannot change executed recovery code or the IDs recorded in evidence. The legacy application compatibility rehearsal uses the same restore lock, clean exact-commit snapshot, and immutable current-image boundary. The database verifier refuses any database name outside the `business_finlynq_restore_drill*` namespace, refuses any host other than its explicitly allowed disposable host, refuses a non-empty target, checks the encrypted checksum, decrypts only into container tmpfs, validates the archive, restores in one transaction, and checks schema/migration presence. The drill then applies reviewed forward migrations, recreates the app, authentication-worker, and backup roles, and reapplies the explicit current-object grant matrices that an ACL-free restore deliberately omits.

Immediately after those migrations and grant reconciliations—and before key verification, demo bootstrap, or nightly reset can write anything—the read-only backup role recomputes every audit hash and verifies the strict graph plus request/outbox lineage. The aggregate-only result is atomically retained as `accounting-prebootstrap_<drill-id>.json`. The final recorder requires that exact checksum-bound report, its explicit passing hash/graph/lineage checks, and its pre-bootstrap phase. The later restored-runtime verifier repeats the same accounting check after demo reconciliation; both checks are required.

Before any new demo key can be created, the secret verifier unwraps every restored organization DEK and validates exact referenced key versions. It reads every user rather than filtering by an accepted prefix: only the explicitly identified synthetic demo marker is classified as non-secret, while an unsupported real identity or display-name envelope fails closed. It decrypts at least one authenticated identity, party-name, and party-address envelope with the escrowed secrets, then decrypts every additional present master-data or banking envelope without printing plaintext. The key report sets a decryption check true only when its count is positive. Banking may be explicitly absent when the connector has never been used; the recorder accepts only the consistent pair of a false banking-decryption check and zero banking rows. It rejects missing identity/party/address checks, their zero counts, unsupported envelopes, diagnostic results, or an absent exact key version.

Finally, an internal-only restored application must pass `/api/health`, issue and resolve a demo session, prove that the app, worker, and read-only backup roles have their intended access, and run the aggregate-only accounting-evidence verifier. That verifier checks one connected root-to-leaf audit graph per organization, no missing predecessor/fork/unreachable event, and request/organization/entity lineage from every business outbox record to audit; it checks paired audit/outbox counts only for event families contractually required to emit both. It also recomputes every event digest from its database-assigned hash-material version: generic tenant events use the exact canonical `jsonb::text` metadata formula, while the original journal-posting and period-transition families use their exact metadata-free formulas. An unsupported action/version pairing or any digest mismatch fails recovery acceptance. Metadata is used only inside the one-way digest and is never projected or emitted; the verifier likewise never outputs outbox payloads, email data, financial values, or customer text. The runtime verifier writes explicit check results. No provider credential is mounted and no email is sent. A database created before the G0-03 graph-leaf writer and monotonic-timestamp migration must pass that migration's graph preflight first; a historical branch, orphan, cycle, multiple-leaf result, or hash mismatch blocks recovery acceptance and requires a reviewed migration exception rather than being normalized as healthy evidence.

After all steps succeed, the no-network `restore_evidence` service validates the receiver-generated, checksum/revision-bound schema-v2 acceptance receipt, its detached Ed25519 signature, and the exact pinned public-key fingerprint before validating the database, pre-bootstrap accounting, key, and runtime reports for the selected checksum and drill window. It writes `restore-rehearsal_<UTC>_<checksum-prefix>.json` under `restore-reports/` with the selected recovery-point age, full drill duration, under-6-hour RPO, 4-hour RTO, source/recovery revisions, immutable recovery-image IDs, receipt/signature filenames, signing-key fingerprint, and objective results. The command exits nonzero after preserving the report if either objective is missed. Retain that report, receiver receipt and signature, pinned public-key fingerprint record, and all four referenced component reports; a console success line alone is not recovery evidence. Keep `RESTORE_REQUIRE_OFFSITE_EVIDENCE=true` for production evidence. Missing, invalid, unsigned, or unpinned receipts fail that mode. Setting it false produces only `result: "verified-diagnostic-no-offsite"` with `productionRecoveryEvidence: false`; it can help inspect a local or historical unsigned restore but cannot be mistaken for or satisfy G0 signoff.

`RESTORE_REQUIRE_WRAPPED_KEYS` must remain true. `RESTORE_ALLOW_EMPTY_SECRET_FIXTURES=true` is an explicit diagnostic escape only for an isolated fixture archive that genuinely has no representative row in one or more encrypted categories. It must reach both the key verifier and evidence recorder through the restore wrapper. It never bypasses malformed ciphertext, authentication failure, or a missing referenced key. The key report is marked `verified-diagnostic`, names exactly the missing category kinds, and leaves their checks false. The recorder accepts that report only in the explicit diagnostic mode, emits `result: "verified-diagnostic-empty-secret-fixtures"`, leaves `checks.keyRecovery` and `productionRecoveryEvidence` false, and cannot satisfy G0 even when the receiver receipt is valid. Never set it for production signoff or G0 evidence.

After the drill, securely remove the temporary key copies from the recovery host according to the escrow procedure. Keep the JSON report and operator/ticket reference as evidence. Never copy the age identity into the normal production backup configuration.

For a non-mutating production integrity check between drills, run the commit-addressed one-shot with the read-only backup role:

```bash
docker compose --profile operations run --rm --no-deps verify_accounting_evidence
```

The command emits one JSON object containing only aggregate organization/audit/outbox/error counts and fails on any graph or request-lineage anomaly. Treat failure as SEV-1, disable affected writes, and follow the [accounting discrepancy/write-shutdown procedure](incident-response.md); do not “repair” the chain directly.

For the one-release rollback window, the target server also has a separate hard-pinned prior-image rehearsal. Follow the release runbook and run `deploy/rollback/run-legacy-restore-rehearsal.sh`; it repeats the tmpfs restore/current-migration/role-reconciliation sequence, then proves the retained f8485 image can become ready through its restricted credential adapter while every login and write gate remains disabled. It must pass before the live migration and does not replace the current-image restore drill above.

## Full disaster recovery sequence

1. Declare the incident, stop accounting writes, and record the chosen recovery point/checksum.
2. Provision an isolated destination with the same pinned application revision and supported PostgreSQL major version.
3. Restore and verify using the drill above.
4. Run reviewed forward migrations, then reconcile the non-owner runtime role with `deploy/postgres/010-runtime-role.sh`, reconcile the authentication worker with `deploy/postgres/015-auth-worker-role.sh`, and re-run the backup-role provisioner. Recreate the verified shared-demo baseline when demo login is enabled. The migration and all three role reconciliations are mandatory after an ACL-free restore.
5. Start the application and email worker with production secret mounts. Verify public `/api/live`, minimal public `/api/health`, detailed internal readiness, tenant isolation, key unwrap/decryption, authentication delivery, and browser release tests.
6. Switch DNS only after operator sign-off. Keep the old system offline and recoverable through the acceptance window.
7. Take a new encrypted off-site backup from the recovered system and verify its remote checksum.

Never recover by copying the live PostgreSQL volume between machines, replacing a wrapping key, or restoring over a non-empty production database.
