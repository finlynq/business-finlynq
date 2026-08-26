# VPS deployment outline

Target hostname: `business.finlynq.com`.

## Isolated runtime

- Linux service account: `business-finlynq` with no access to personal Finlynq directories.
- Application directory: `/opt/business-finlynq/current` with read-only release artifacts.
- Data directory: `/var/lib/business-finlynq`; uploads are never served directly.
- Loopback listener: `127.0.0.1:3100`; Caddy/Nginx terminates TLS for the exact host.
- PostgreSQL database: `business_finlynq` with a database owner used only by bootstrap/migrations and a non-owner, non-`BYPASSRLS` runtime role. The current Compose slice does not yet create worker or backup roles.
- Host-only secure cookie named `business_finlynq_session`; do not use a `.finlynq.com` domain cookie.
- Root wrapping key mounted as a read-only Docker secret file; it is never placed in the application environment.

## Release sequence

1. Build and test a pinned commit in CI.
2. Produce Next.js standalone output and a migration artifact from the same commit.
3. Back up the database and confirm off-VPS backup/key availability.
4. Run migrations in the one-shot `migrate` container using the database owner; never grant migration privileges to the runtime role.
5. Install the immutable release directory and restart only this service.
6. Verify health, exact origin/security headers, tenant RLS, audit insertion, and a read-only smoke query.
7. Roll back the application artifact if needed; database rollback uses an explicit forward repair migration.

## Initial container deployment

The included Compose stack binds the application to loopback port `3100`; the existing VPS reverse proxy owns public TLS. Run it as a distinct Compose project so names, networks, and lifecycle remain separate from personal Finlynq:

```bash
docker compose -p business-finlynq build
docker compose -p business-finlynq run --rm migrate
docker compose -p business-finlynq up -d app
```

Before the first run:

1. Create a root-controlled Compose environment file containing independent `POSTGRES_PASSWORD` and `APP_DATABASE_PASSWORD` values. Do not put the wrapping key in this file.
2. Create `/etc/business-finlynq/secrets/organization-root-kek` containing exactly one base64-encoded 32-byte key. Make it root-owned, mode `0440`, with a dedicated numeric group recorded as `BUSINESS_FINLYNQ_SECRET_GID` in the Compose environment file. The app container receives that supplementary group and reads the mounted file at `/run/secrets/business_finlynq_root_kek`.
3. Set `ORGANIZATION_ROOT_KEK_FILE=/etc/business-finlynq/secrets/organization-root-kek`. Compose exposes only this host path during interpolation, not the secret value.
4. Keep `BUSINESS_WRITES_ENABLED=false`. The current artifact is suitable for the demo surface only; enabling real accounting mutations is prohibited until the recovery, encryption, authentication, and source-workflow launch gates are complete.

On a fresh database volume, the initialization script creates the non-owner/non-`BYPASSRLS` `business_finlynq_app` role. The one-shot migration container connects as `business_finlynq_owner`; the long-running app connects only as `business_finlynq_app`. There is currently no separate migrator, worker, or backup role. Never reuse personal Finlynq credentials or key material. Rotating either database password requires changing the database role and deployment secret together. Replacing the wrapping-key file requires a versioned DEK rewrap procedure, not a blind file replacement.

Compose fixes the project namespace to `business-finlynq` and applies initial ceilings of 1 CPU/1 GiB to PostgreSQL, 0.5 CPU/512 MiB to migrations, and 1 CPU/768 MiB to the app, with PID and log-rotation limits. Tune these only from observed production load and preserve explicit limits.

Install [deploy/Caddyfile.example](../../deploy/Caddyfile.example) into the existing Caddy configuration, validate it, and reload Caddy. Do not expose PostgreSQL or container port 3000 publicly.

## Required launch gates

- Restore drill from off-VPS encrypted database and separately stored root-key backup.
- PostgreSQL tests using a non-owner, non-`BYPASSRLS` runtime role after fresh migration replay.
- A dedicated least-privilege backup role before automated production backups are enabled.
- TLS renewal, disk, service, database, audit, backup-age, and failed-recovery alerts.
- Rate-limited email recovery with generic responses and step-up controls.
- Encrypted party/address persistence using the active organization DEK, plus key provision, rotation, recovery, and restore drills.
- Authenticated session-to-membership resolution at every business write boundary; never construct tenant context from request body fields.
- No production MCP write scope beyond draft creation.
