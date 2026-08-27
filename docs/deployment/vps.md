# VPS deployment outline

Target hostname: `business.finlynq.com`.

## Isolated runtime

- Linux service account: `business-finlynq` with no access to personal Finlynq directories.
- Application directory: `/opt/business-finlynq/current` with read-only release artifacts.
- Data directory: `/var/lib/business-finlynq`; uploads are never served directly.
- Loopback listener: `127.0.0.1:3100`; Caddy/Nginx terminates TLS for the exact host.
- PostgreSQL database: `business_finlynq` with a database owner used only by bootstrap/migrations, a non-owner/non-`BYPASSRLS` app role, a separate function-only/non-`BYPASSRLS` authentication-email worker role, and a separately provisioned read-only `BYPASSRLS` backup role. `BYPASSRLS` is limited to the backup role because a complete cross-tenant logical dump cannot be produced through tenant RLS.
- Host-only secure cookie named `__Host-business_finlynq_session`; do not use a `.finlynq.com` domain cookie.
- Root wrapping key mounted as a read-only Docker secret file; it is never placed in the application environment.

## Release sequence

1. Build and test a pinned commit in CI.
2. Produce Next.js standalone output and a migration artifact from the same commit.
3. Run the encrypted backup workflow and confirm its remote checksum/off-site marker plus separate recovery-key availability. Follow [the backup and recovery runbook](../operations/backups-and-recovery.md).
4. Run migrations in the one-shot `migrate` container using the database owner, then require both post-migration runtime-role reconciliation services to succeed before bootstrap or application startup. Never grant migration privileges to a runtime role.
5. Install the immutable release directory and restart only this service.
6. Verify `/api/health`, exact origin/security headers, tenant RLS, audit insertion, and a read-only smoke query. Readiness fails closed if PostgreSQL or either mounted encryption secret is unavailable.
7. Roll back the application artifact if needed; database rollback uses an explicit forward repair migration.

## P0 demo deployment and rollback

The interactive demo remains a read-only release even though every visible route and control is functional. Keep `BUSINESS_WRITES_ENABLED=false` before, during, and after deployment, and verify that browser previews never reach a persistent write service.

Deploy only a pinned commit that passed lint, type checking, unit tests, fresh migration replay, PostgreSQL integration tests, production build, and the browser checklist. Record the commit and image digest, retain the previous immutable application artifact, back up PostgreSQL off the VPS, and confirm that the separately escrowed wrapping key is recoverable before running the one-shot migrator. Keep the edge proxy running while replacing only the application release.

After deployment, verify HTTPS and HTTP redirection, security headers, health, read-only database access, forced tenant RLS, every interactive route, search, export, validation previews, and the absence of persistent state changes. If acceptance fails, restore the previous application artifact when it is compatible with the migrated schema. Repair an incompatible schema with a reviewed forward migration; do not run an ad hoc down migration, delete the PostgreSQL volume, or replace the wrapping key. Keep writes disabled throughout rollback.

## Initial container deployment

The included Compose stack always binds the application to loopback port `3100`. It supports two edge arrangements while keeping the database, credentials, networks, and lifecycle isolated from personal Finlynq.

### Shared host reverse proxy

When an existing host Caddy or Nginx owns ports `80` and `443`, leave the `edge` profile disabled and run Business Finlynq as a distinct Compose project:

```bash
docker compose -p business-finlynq build
docker compose -p business-finlynq up --detach --wait app
```

Install [deploy/Caddyfile.example](../../deploy/Caddyfile.example) into the host proxy, validate it, and reload only that proxy. The example forwards to `127.0.0.1:3100`.

### Dedicated server with containerized Caddy

On a clean dedicated server where this stack should own public ports `80` and `443`, enable the optional `edge` profile:

```bash
docker compose -p business-finlynq build
docker compose -p business-finlynq --profile edge up --detach --wait app edge
docker compose -p business-finlynq --profile edge ps
```

The `edge` service uses [deploy/Caddyfile.container](../../deploy/Caddyfile.container), reaches the application only over `business_finlynq_edge`, and obtains and renews TLS certificates automatically. It publishes TCP `80`/`443` and UDP `443`; make sure the host firewall allows those ports and no host service or other container is already listening on them. Set `BUSINESS_FINLYNQ_HOSTNAME=business.finlynq.com`, and point the hostname's DNS records to the server before starting the profile. Do not install the host-proxy example in this arrangement.

Before the first run:

1. Create a root-controlled Compose environment file containing the owner `POSTGRES_PASSWORD` and paths to independent, one-line app and authentication-worker database password files through `APP_DATABASE_PASSWORD_FILE` and `AUTH_WORKER_DATABASE_PASSWORD_FILE`. The files must be 24–1024 characters, root-owned, and readable only by the deployment secret group. Set `BUSINESS_FINLYNQ_HOSTNAME` to the exact public hostname, `SESSION_COOKIE_NAME=__Host-business_finlynq_session`, and explicitly choose `DEMO_LOGIN_ENABLED=true` or `false`. Keep `ACCOUNT_LOGIN_ENABLED=false` for the hosted preview. Do not put encryption keys or runtime database passwords inline in this file.
2. Create `/etc/business-finlynq/secrets/organization-root-kek` containing exactly one base64-encoded 32-byte key and `/etc/business-finlynq/secrets/identity-secret` containing one base64-encoded 64-byte secret. The first wraps organization DEKs. The second is independently split for identity-field encryption and blind indexes.
3. Make both files root-owned, mode `0440`, with a dedicated numeric group recorded as `BUSINESS_FINLYNQ_SECRET_GID`. Set `ORGANIZATION_ROOT_KEK_FILE` and `IDENTITY_SECRET_FILE` to those host paths. The app receives them as read-only Compose secrets.
4. Mount a one-line Resend key through `AUTH_RESEND_API_KEY_FILE` into the `auth_email_worker` service only, configure the non-secret email provider/sender settings for app and worker, enable the `auth-email` profile, and exercise a one-use reset link before onboarding real users. The public app and invitation service must not mount or read the provider key. Never place the provider key inline in the production environment. Reset tokens are carried in URL fragments and posted to the server so Caddy request logs never receive them.
5. Keep both `ACCOUNT_LOGIN_ENABLED=false` and `BUSINESS_WRITES_ENABLED=false`. The current artifact is suitable for the protected demo surface only; enabling real identities or accounting mutations is prohibited until tenant-scoped persistence, recovery delivery, backup/key restore, authorization, and source-workflow launch gates are complete.

For a dedicated, single-administrator demo host without a privileged provisioning path, `deploy/bootstrap-demo-secrets.sh` creates the ignored Compose environment and a separate user-private key file without printing either secret. It refuses to overwrite existing material. This is a bootstrap convenience only: before accepting real accounting data, move the key to the root-controlled location described above and establish separate off-server key escrow.

On a fresh database volume, the initialization script creates the non-owner/non-`BYPASSRLS` `business_finlynq_app` role. Before migrations, a one-shot provisioner creates `business_finlynq_auth_worker`. After every canonical migration run, Compose must re-run `deploy/postgres/010-runtime-role.sh` followed by `deploy/postgres/015-auth-worker-role.sh`; these scripts revoke blanket/default privileges and apply the reviewed current-object function/table matrices before bootstrap. The worker keeps only its heartbeat and claim/complete/fail functions with no direct auth-table access. The migration container connects as `business_finlynq_owner`; the app and worker use their separate file-mounted credentials. The operations profile provisions `business_finlynq_backup` with read-only relation access and no create/replication/superuser capabilities. Never reuse personal Finlynq credentials or key material. Rotating a database password requires changing the matching database role and deployment secret together. Replacing the wrapping-key file requires a versioned DEK rewrap procedure, not a blind file replacement.

Compose fixes the project namespace to `business-finlynq` and applies initial ceilings of 1 CPU/1 GiB to PostgreSQL, 0.5 CPU/512 MiB to migrations, 1 CPU/768 MiB to the app, and 0.5 CPU/256 MiB to the optional edge, with PID and log-rotation limits. Tune these only from observed production load and preserve explicit limits.

Do not expose PostgreSQL or container port `3000` publicly. The loopback `3100` mapping exists for the shared-proxy path and local host diagnostics only.

## Moving to another server

The deployment is portable because Business Finlynq does not share a database, role, Docker network, volume, credential, wrapping key, or release directory with another application. Treat the database backup and wrapping-key backup as separate, equally required recovery artifacts.

1. Put the application in maintenance mode and keep `BUSINESS_WRITES_ENABLED=false` during the move.
2. Create and verify a logical PostgreSQL backup with an explicitly provisioned least-privilege backup role. Copy the encrypted backup off the source server.
3. Transfer the Compose environment through a secret channel and transfer the separately escrowed organization root wrapping key. Preserve the key bytes, ownership, mode, and `BUSINESS_FINLYNQ_SECRET_GID`; never place the key in Git or inside the database backup.
4. Check out the same pinned Git commit on the destination, recreate `/etc/business-finlynq/secrets`, and start a fresh database volume.
5. Restore the backup as the database owner, run any newer migrations once, reapply both explicit runtime-role grant matrices, then start `app` and either the shared-proxy path or the `edge` profile.
6. Verify the application, tenant isolation, audit chain, TLS, and backup restore before switching DNS. Lower DNS TTL ahead of the cutover when possible.
7. Keep the source database and key available but offline until the destination passes the acceptance window; then retire them according to the retention policy.

The named volumes are `business_finlynq_pgdata`, `business_finlynq_caddy_data`, and `business_finlynq_caddy_config`. PostgreSQL moves should use a logical backup/restore rather than copying `business_finlynq_pgdata` between hosts. Caddy state may be copied if desired, but it is not application data and can normally be recreated after DNS points to the destination.

## Required launch gates

Operational procedures and implemented automation are described in the [release](../operations/release-runbook.md), [backup/recovery](../operations/backups-and-recovery.md), [monitoring](../operations/monitoring-and-alerting.md), and [container hardening](../operations/container-hardening.md) runbooks. A gate is complete only after the environment-specific external service and operator drill have produced evidence; committed scripts alone are not evidence.

- Restore drill from off-VPS encrypted database and separately stored root-key backup.
- PostgreSQL tests using a non-owner, non-`BYPASSRLS` runtime role after fresh migration replay.
- A non-superuser schema owner/migrator distinct from the PostgreSQL bootstrap administrator, with explicit grants instead of blanket default CRUD privileges.
- A dedicated least-privilege backup role before automated production backups are enabled.
- TLS renewal, disk, service, database, audit, backup-age, and failed-recovery alerts.
- Rate-limited email recovery with generic responses and step-up controls.
- A partition/archive and retention policy for real account sessions and immutable authentication security events.
- Encrypted party/address persistence using the active organization DEK, plus key provision, rotation, recovery, and restore drills.
- Authenticated session-to-membership resolution at every business write boundary; never construct tenant context from request body fields.
- Secure, host-only session cookies, CSRF/origin enforcement, content security policy, private/no-store caching for authenticated responses, and rate limits for sensitive operations.
- End-to-end coverage for authorization, maker/approver separation, posting and idempotency concurrency, reversal, period locks, multi-currency, tax, AR/AP, and browser accessibility.
- Immutable, commit-addressed release artifacts with a tested application rollback and forward-only database repair procedure.
- No production MCP write scope beyond draft creation.
