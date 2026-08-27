# Backups and recovery runbook

This runbook covers the encrypted logical PostgreSQL backup shipped with Business Finlynq. It is designed so the production VPS holds only an age **recipient** (public key). The corresponding age identity, organization wrapping key, and identity-encryption secret must be escrowed separately. A database dump by itself is not a recoverable Business Finlynq system.

## Recovery objectives and retention

- Baseline logical-backup RPO: less than 6 hours when the supplied timer is enabled and monitored.
- Initial restore target: less than 4 hours for a database that fits the documented single-VPS profile.
- Local encrypted sets: 14 days by default.
- Off-site encrypted sets: configure an immutable/object-lock bucket lifecycle for at least 35 daily recovery points and 12 monthly recovery points.
- Restore drill: monthly, before enabling real accounting writes, after any key procedure change, and before a server move.
- Migration backup: take and verify a separate backup immediately before every production migration.

The local script never deletes remote objects. Remote retention and immutability are enforced by the storage provider. A lower RPO or point-in-time recovery requires archived PostgreSQL WAL or a managed PostgreSQL service; logical dumps do not provide PITR.

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
   MONITOR_MAX_BACKUP_AGE_HOURS=8
   MONITOR_REQUIRE_OFFSITE=true
   ```

6. Build the `operations` target and run the first backup manually:

   ```bash
   docker compose --profile operations build provision_backup backup
   ./deploy/backup/run-scheduled-backup.sh
   ```

The first step provisions a dedicated login role with `SELECT`, `CONNECT`, and schema usage only. It has `BYPASSRLS` because a complete logical database dump must include every tenant; it is not a superuser and cannot create databases, roles, or replication slots. The provisioner re-applies grants after migrations so new tables are included.

## Backup completion criteria

Every successful run produces one atomic set:

- `business_finlynq_<UTC>_<database>.dump.age`: age-encrypted custom-format dump.
- `...manifest.json`: format, revision, timestamp, size, retention, and encrypted-archive SHA-256.
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

The supplied systemd timer runs at 00:17, 06:17, 12:17, and 18:17 UTC with up to ten minutes of jitter.

```bash
install -m 0644 deploy/systemd/business-finlynq-backup.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-backup.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor-notify@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now business-finlynq-backup.timer
systemctl start business-finlynq-backup.service
```

The committed unit assumes the immutable release symlink is `/opt/business-finlynq/current` and configuration is `/etc/business-finlynq/operations.env`. Adjust both paths together if the host layout differs. Docker access is root-equivalent; keep the unit and Docker socket restricted to administrators.

## Isolated restore drill

Run this on a recovery host, not on the production VPS. The drill uses a dedicated internal Docker network and a PostgreSQL data directory backed only by tmpfs. Its wrapper addresses only the explicitly named `restore_*` services; it never stops, removes, or connects to the production database service.

1. Fetch one completed encrypted set from the remote into a protected local backup directory.
2. Temporarily supply the age identity, the separately escrowed organization root key, and the separately escrowed identity secret. Create a unique disposable restore database password.
3. Set:

   ```dotenv
   BACKUP_LOCAL_DIR=/secure/recovery/business-finlynq
   BACKUP_AGE_IDENTITY_FILE=/secure/recovery/age-identity.txt
   RESTORE_DATABASE_PASSWORD_FILE=/secure/recovery/restore-db-password
   APP_DATABASE_PASSWORD_FILE=/secure/recovery/app-db-password
   AUTH_WORKER_DATABASE_PASSWORD_FILE=/secure/recovery/auth-worker-db-password
   ORGANIZATION_ROOT_KEK_FILE=/secure/recovery/organization-root-kek
   IDENTITY_SECRET_FILE=/secure/recovery/identity-secret
   RESTORE_BACKUP_MANIFEST=business_finlynq_YYYYMMDDTHHMMSSZ_business_finlynq.manifest.json
   RESTORE_REQUIRE_WRAPPED_KEYS=true
   RESTORE_REQUIRE_ENCRYPTED_IDENTITIES=true
   ```

4. Run:

   ```bash
   docker compose --profile restore-drill build restore_verify restore_migrate restore_runtime_grants restore_auth_worker_grants restore_key_verify restore_app restore_runtime_verify
   ./deploy/backup/run-restore-drill.sh
   ```

The verifier refuses any database name outside the `business_finlynq_restore_drill*` namespace, refuses any host other than its explicitly allowed disposable host, refuses a non-empty target, checks the encrypted checksum, decrypts only into container tmpfs, validates the archive, restores in one transaction, and checks schema/migration presence. The drill then applies reviewed forward migrations, recreates the app and authentication-worker roles, and reapplies the explicit current-object grant matrices that an ACL-free restore deliberately omits. It unwraps every organization DEK and decrypts every real-user identity envelope without printing plaintext. Finally, an internal-only restored application must pass `/api/health`, issue and resolve a demo session, and prove that the app and worker roles have their intended function access while the worker remains unable to read the outbox or issue sessions. No provider credential is mounted and no email is sent. A non-sensitive JSON report is written under `restore-reports/`.

For the synthetic demo, the two `RESTORE_REQUIRE_*` settings may remain false because it may contain no real-user envelope or provisioned organization DEK. They must both be true before real organizations are accepted.

After the drill, securely remove the temporary key copies from the recovery host according to the escrow procedure. Keep the JSON report and operator/ticket reference as evidence. Never copy the age identity into the normal production backup configuration.

For the one-release rollback window, the target server also has a separate hard-pinned prior-image rehearsal. Follow the release runbook and run `deploy/rollback/run-legacy-restore-rehearsal.sh`; it repeats the tmpfs restore/current-migration/role-reconciliation sequence, then proves the retained f8485 image can become ready and resolve a demo session through its restricted credential adapter. It must pass before the live migration and does not replace the current-image restore drill above.

## Full disaster recovery sequence

1. Declare the incident, stop accounting writes, and record the chosen recovery point/checksum.
2. Provision an isolated destination with the same pinned application revision and supported PostgreSQL major version.
3. Restore and verify using the drill above.
4. Run reviewed forward migrations, then reconcile the non-owner runtime role with `deploy/postgres/010-runtime-role.sh`, reconcile the authentication worker with `deploy/postgres/015-auth-worker-role.sh`, and re-run the backup-role provisioner. The migration and both runtime reconciliations are mandatory after an ACL-free restore.
5. Start the application and email worker with production secret mounts. Verify `/api/live`, `/api/health`, tenant isolation, key unwrap/decryption, authentication delivery, and browser release tests.
6. Switch DNS only after operator sign-off. Keep the old system offline and recoverable through the acceptance window.
7. Take a new encrypted off-site backup from the recovered system and verify its remote checksum.

Never recover by copying the live PostgreSQL volume between machines, replacing a wrapping key, or restoring over a non-empty production database.
