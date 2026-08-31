# Container hardening review

This review documents the intended boundaries of the Compose deployment.

| Service | Identity and filesystem | Network | Privilege boundary | Persistent data |
| --- | --- | --- | --- | --- |
| `app` | Non-root `nextjs`, read-only root, bounded tmpfs | private DB, egress, edge | all capabilities dropped, no-new-privileges, PID/CPU/memory limits | none |
| `auth_email_worker` | Non-root `node`, read-only root, bounded tmpfs | private DB and egress only | all capabilities dropped, no-new-privileges, no port, dedicated function-only/NOBYPASSRLS database role, PID/CPU/memory limits | none |
| `migrate` / role reconcilers | Non-root, read-only root | private DB only | all capabilities dropped, one-shot, owner DB credential; app/worker/backup passwords are distinct mounted files | none |
| `database` | Official PostgreSQL entrypoint, isolated named volume | internal private network only | no public port, no-new-privileges, graceful stop and resource/log limits | PostgreSQL volume only |
| `edge` | Read-only root with Caddy data/config volumes | public ports and edge network only | only `NET_BIND_SERVICE` added, other capabilities dropped | TLS/config volumes |
| `release_acceptance` | Non-root `pwuser`, read-only root, bounded private tmpfs | host network only for the reviewed public origin and rehearsal loopback listener | all capabilities dropped, no-new-privileges, noninteractive commit-addressed one-shot, no secrets or host mounts | none |
| `backup` | Non-root UID/GID 70, read-only root, plaintext only in tmpfs/pipe | private DB and egress only | all capabilities dropped, dedicated read-only DB role, one-shot | encrypted backup bind mount only |
| `reset_demo_sandboxes` / `reconcile_demo_sandboxes` | Non-root Node operator, read-only root, bounded tmpfs | private DB only | all capabilities dropped, owner-only one-shot, no caller-selected tenant or slot | none |
| `restore_*` | Disposable services; verifiers non-root | separate internal drill network only | no production network, egress, or public port; explicit host/database safety checks; current migrations and app/worker ACL reconciliation required | database uses tmpfs only; non-sensitive report persists |

Secrets are mounted as files. Organization wrapping, identity encryption, Resend, app database, auth-worker database, backup database, age, rclone, and restore credentials are distinct. The production app never receives the Resend key, age private identity, worker credential, or backup database credential. The email worker is the only provider-key consumer and never receives the application database credential or organization wrapping key. Its database role can execute only the heartbeat and claim/complete/fail delivery functions and has no direct auth-table grants. The owner-only invitation container has no egress and does not receive the provider key. The backup container never receives either application encryption key.

Demo reset is the narrow exception that receives both migration-owner database access and the organization wrapping key because every synthetic sandbox baseline must be encrypted under its own organization DEK. It has no egress, public port, runtime-role credential, provider key, identity secret, or backup secret. Its CLI rejects all tenant/slot arguments; only the database selects registered sandbox rows.

## Accepted constraints

- The PostgreSQL container uses the upstream entrypoint and starts with the privileges it needs to initialize/chown its data volume before dropping to postgres. It is therefore not configured with `cap_drop: ALL` or a read-only root. It remains internal-only and has no Docker socket.
- The authentication email worker is bundled during the image build. Its runtime image contains the single worker artifact plus production npm dependencies; it does not contain project source, TypeScript, `tsx`, ESLint, test tooling, or other development dependencies.
- The release-acceptance image is built from the immutable official Playwright image whose version exactly matches `@playwright/test`. It contains only the lockfile dependency tree, browser configuration, and E2E sources needed for acceptance. Its host network mode is required so isolated rehearsals can reach their loopback-only listener; the service receives no deployment secret, Docker socket, host bind mount, or published port and is removed after the bounded release gate.
- `postgres:16-alpine`, `node:24-alpine`, and the Caddy tag are committed as readable tag-plus-immutable-index-digest references in the Dockerfile and Compose file. Renovating a digest requires resolving it from the official registry and passing the complete gate; tag-only deployments are prohibited for real accounting data.
- Docker daemon access is root-equivalent. Only administrators may install/run systemd units or access the Docker group/socket.
- The egress networks do not themselves enforce destination allowlists. Apply host/provider firewall policy where supported and monitor unexpected outbound connections.
- Compose startup is deliberately gated: canonical migrations must complete, then the explicit app-role, worker-role, and read-only backup-role grant matrices must reconcile successfully, and only then may demo bootstrap or the web app start. The restore drill also reconciles all three roles before key recovery, sandbox reconstruction, and isolated runtime acceptance.

## Review commands

Before each launch, render and archive `docker compose config`, inspect final image digests, and verify that PostgreSQL has no published port, restore services have only the restore-drill network, the app is loopback-only, and no inline encryption/provider key appears in `docker inspect`. Run an image/container scanner and remediate critical/high findings before release.
