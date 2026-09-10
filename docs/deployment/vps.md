# VPS deployment outline

Target hostname: `business.finlynq.com`.

## Isolated runtime

- Linux service account: `business-finlynq` with no access to personal Finlynq directories.
- Application directory on the current target: `/home/deploy/business-finlynq`; deploy only a reviewed commit and keep the checkout non-writable to service processes.
- Data directory: `/var/lib/business-finlynq`; uploads are never served directly.
- Loopback ingress: the stable release router owns `127.0.0.1:3100`; the replaceable app is reachable only as `release-app:3000` on its private frontend network. Caddy/Nginx terminates TLS for the exact host.
- Trusted request-IP boundary: set `TRUSTED_PROXY_HOPS=1` for either reviewed Caddy arrangement. Leave it unset or `0` when Next.js is reached directly.
- PostgreSQL database: `business_finlynq` with a database owner used only by bootstrap/migrations, a non-owner/non-`BYPASSRLS` app role, a separate function-only/non-`BYPASSRLS` authentication-email worker role, and a separately provisioned read-only `BYPASSRLS` backup role. `BYPASSRLS` is limited to the backup role because a complete cross-tenant logical dump cannot be produced through tenant RLS.
- Host-only secure cookie named `__Host-business_finlynq_session`; do not use a `.finlynq.com` domain cookie.
- Root wrapping key mounted as a read-only Docker secret file; it is never placed in the application environment.

## Release routing and availability

The separately versioned `business-finlynq-release-router:v2` image owns both the loopback listener and the production edge alias. It remains running while application releases are replaced. Routine application releases must not retag it with the application revision or force-recreate it; a router contract change requires its own version, review, rehearsal, and rollout. Version 2 removes the upstream low-port Caddy file capability because this non-root router listens on port 3000 and runs with every capability dropped. Its dedicated control bridge disables inter-container communication and IP masquerading: Docker can publish the host-loopback diagnostic port, but the router does not gain normal outbound Internet access.

The router persists an `active` or `maintenance` sentinel in its dedicated state volume. Missing, malformed, or unsafe state starts in maintenance. Entry to maintenance is persisted before Caddy reloads through its private Unix admin socket. Activation uses the reverse ordering deliberately: Caddy reloads the accepted active configuration while the durable sentinel remains `maintenance`; only after public, edge, scheduler, monitor, and terminal-evidence checks pass does the runner atomically and synchronously commit `active` as its last acceptance step. A restart during unfinished acceptance therefore fails closed. Continuous deployment can finish the narrow crash window after terminal evidence only when the exact accepted app/router identities, detailed revision health, and live active route all still match; it never reloads or promotes deliberate live maintenance. Public `/api/live` stays available in either state. Maintenance returns deterministic, non-cacheable `503` responses with `Retry-After: 5` for public readiness and application routes. If maintenance cannot be proven during failure handling, the scoped router is stopped rather than allowing unverified application traffic.

For an ordinary release, the runner first pauses and drains scheduled work, then switches to maintenance while the old app is still healthy. It stops the authentication worker, waits for in-flight router-to-app connections to drain, stops the app, and proves both database sessions are gone. The candidate is reachable during acceptance only through an ephemeral 256-bit bearer credential supplied to bounded release probes and the contained browser test. The router removes the authorization header before proxying to the app, the browser removes it from cross-origin requests, and the edge keeps Caddy's default credential redaction enabled. It is not an operator or customer access mechanism.

After all candidate and final-gate checks pass, an atomic reload returns the existing listener to active routing; the router container is not restarted. When the authentication worker is absent and the database has no active client transaction, online-unsafe relation, or prepared-transaction state, the runner attempts the encrypted backup before maintenance and reuses it only if the database container, system identifier, timeline, database name, eligibility, and WAL insert LSN are unchanged after every write surface and client session stops. Otherwise it creates one quiesced backup with a five-minute ceiling. Each verifier is bound to the exact manifest emitted by that backup, so a newer unrelated artifact cannot satisfy the release. This removes the proxy restart gap and normally moves the longest backup work outside the public maintenance interval, but migration, grant reconciliation, bootstrap, app startup, and acceptance still occur in maintenance. True near-zero application downtime would additionally require expand/contract schema migrations and simultaneous old/new compatible application versions with blue-green switching.

## Release sequence

1. Build and test a pinned commit in CI.
2. Produce Next.js standalone output and a migration artifact from the same commit.
3. Use the commit-addressed [scripted release flow](../operations/release-runbook.md#scripted-release-contract). It verifies the stable router, records the prior immutable app and exact worker, pauses and drains schedulers, provisions the backup role, and attempts the eligible online backup before maintenance.
4. Enter durable maintenance, drain in-flight requests, stop every write surface, then either prove the online artifact is an exact unchanged recovery point or create and verify a quiesced backup within five minutes. Keep public application traffic in maintenance through the one-shot migration, all three role reconcilers, exact schema/RLS/grant verification, journal-registry verification, and candidate acceptance.
5. Accept the candidate privately, recreate it with the final reviewed gate posture, then reload the existing router to live active service while its durable state remains fail-closed. Verify public readiness and, when configured, the production-scoped external edge; install and resume the selected scheduler; run fresh accounting and production-monitor checks; seal terminal evidence; and commit the durable `active` sentinel last.
6. A failure before database mutation automatically restores the exact prior app and worker state. After mutation, keep maintenance in place and use only a forward-schema-compatible application rollback or a reviewed forward repair; never roll the database backward in place.

## Writable demo deployment and rollback

The hosted release serves both daily-claimed synthetic sandboxes and private organizations. Treat demo, real login, signup, real-organization writes, email delivery, and bank feeds as independent gates: enabling one must never authorize another.

Deploy only a pinned commit that passed lint, type checking, unit tests, fresh migration replay, PostgreSQL integration tests, production build, and the browser checklist. Record the commit and image digest, retain the previous immutable application artifact, back up PostgreSQL off the VPS, and confirm that the separately escrowed wrapping key is recoverable before running the one-shot migrator. Keep the edge proxy running while replacing only the application release.

For a fresh install, seed and verify the fixed shared demo before accepting traffic. For an ordinary forward deployment, bootstrap is idempotent while the current baseline is ready and performs a full reset only when due or failed. Verify HTTPS redirection, security headers, health, the read-only backup role, forced tenant RLS, two-browser shared visibility, logout/re-entry continuity, every supported GL/AR/AP/tax/reporting/period workflow, and the nightly reset boundary. If acceptance fails before database mutation, let the release handler restore and verify the exact prior app; after mutation, keep the router in maintenance and restore only a confirmed forward-schema-compatible application artifact. Repair schema incompatibility with a reviewed forward migration; never run an ad hoc down migration, delete the PostgreSQL volume, replace the wrapping key, or mark failed reset state ready by hand.

## Initial container deployment

The included Compose stack binds the stable release router, not the application container, to loopback port `3100`. It supports two edge arrangements while keeping the database, credentials, networks, and lifecycle isolated from personal Finlynq.

### Shared host reverse proxy

When an existing host Caddy or Nginx owns ports `80` and `443`, leave the `edge` profile disabled and run Business Finlynq as a distinct Compose project. Do not bootstrap it with a generic `docker compose build` or `up app`: that bypasses the router's canonical build-project attestation and a new router state volume deliberately starts in maintenance. Use the [scripted release flow](../operations/release-runbook.md#scripted-release-contract) for an existing accepted installation. The supplied [fresh contained production bootstrap](../operations/release-runbook.md#fresh-contained-production-bootstrap) currently provisions the externally managed edge arrangement described below; retaining a host-owned proxy for a new production installation requires an equivalently reviewed initial-mode wrapper rather than an improvised Compose start. The reviewed paths build and attest the stable router, privately accept the app, and perform the explicit active reload.

Install [deploy/Caddyfile.example](../../deploy/Caddyfile.example) into the host proxy, validate it, and reload only that proxy. The example forwards to `127.0.0.1:3100` and unconditionally removes the internal-health detail marker from public requests.

Set `TRUSTED_PROXY_HOPS=1` in the application deployment environment. The host Caddy is the only trusted hop and its default `reverse_proxy` handling replaces untrusted client-supplied forwarding values before sending `X-Forwarded-For` upstream. Do not expose `127.0.0.1:3100` beyond the local host.

### Dedicated multi-deployment server with containerized Caddy

On the production server, exactly one Caddy container in the `business-finlynq` Compose project owns public ports `80` and `443`. It joins only the explicitly named external edge networks for Business Finlynq production, Business Finlynq development, EPM Finlynq, and Consult Finlynq; every sibling project retains its own containers, private networks, volumes, and lifecycle.

Create all four external networks through their owning installation procedures, keep every referenced backend healthy, and install the EPM console password include at `/home/deploy/epm-finlynq/secrets/external-basic-auth.caddy` as a non-empty `root:root` mode-`0400` regular file. Then reconcile the shared edge from the canonical production checkout:

```bash
sudo bash /home/deploy/business-finlynq/deploy/edge/reconcile-shared-edge.sh
```

The reconciler holds the cross-deployment host lock, validates the reviewed Caddyfile and exact read-only secret mount in a disposable container, verifies every sibling backend before touching the listener, and runs a no-build/no-dependency Compose convergence for `edge` only. It deliberately does not use `down`, delete networks or volumes, restart sibling services, or force-recreate an unchanged edge. Production continuous deployment runs the same reconciliation after release acceptance and on no-op checks, so reviewed route or mount drift is repaired without coupling the sibling deployments.

The `edge` service uses [deploy/Caddyfile.container](../../deploy/Caddyfile.container), reaches each application only over its external edge network, and obtains and renews TLS certificates automatically. It publishes TCP `80`/`443` and UDP `443`; make sure the host firewall allows those ports and no host service or second container is listening on them. Set the four hostname variables in `/etc/business-finlynq/compose.env` and point their DNS records to the server before reconciliation. Do not install the host-proxy example in this arrangement.

This arrangement also has exactly one trusted hop. Set `TRUSTED_PROXY_HOPS=1`; each application container must remain reachable only from its own edge network and any reviewed loopback diagnostic mapping. The containerized Caddy also removes the internal-health detail marker from every Business Finlynq request.

### Externally managed container edge

When the EPM Compose project already owns the only public Caddy listener, set `BUSINESS_FINLYNQ_EDGE_MODE=external` and include `deploy/edge/docker-compose.external.yml` in every Business Compose invocation. The override marks the application ingress network external and uses a profile override plus reset resources, `network_mode: none`, and `/bin/false` so even an accidental Business `--profile edge` cannot claim ports 80/443. `MONITOR_EXPECT_EDGE` remains `true`; set `MONITOR_EDGE_MODE=external` and identify the same EPM project, service, and production ingress network in the protected operations environment.

The EPM owner must create `business_finlynq_edge` and `business_finlynq_development_edge` as local, internal bridge networks with label `com.business-finlynq.edge-owner=external`, and attach Caddy through an additive Compose overlay. Promote [deploy/edge/Caddyfile.business-external](../../deploy/edge/Caddyfile.business-external) to a separate root-owned mode-`0444` file outside both repositories, record its reviewed SHA-256 in `BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256`, mount it read-only at `/etc/caddy/business-finlynq-routes.caddy`, and import that exact path from EPM's root-owned Caddyfile. A Git checkout is not the live trust root for this mount. The protected Compose environment also pins the external Caddy image reference and runtime image ID, public listener IPv4 values, Caddy source/volumes, EPM authentication mount, and loaded admin-configuration SHA-256. Never put password contents in these metadata fields.

The accepted OVH network set is exactly `business_finlynq_edge`, `business_finlynq_development_edge`, `epm_finlynq_edge`, `epm_finlynq_edge_egress`, and `consult_finlynq_edge`. After development is accepted and before production exists, run `verify-external-edge.sh --scope preflight`; a temporary production 502 is required and proves the route is active without silently reaching another backend. After production starts, run the default/full scope for shared-edge changes and operator audits. Full verification checks owner labels, image and mount identity, exact host bindings and networks, loaded Caddy state, both Business backends and public security boundaries, TLS, preserved EPM authentication, and positive/negative access-log controls for all OAuth callbacks. The installed production monitor uses production scope: it retains the shared static image/config/listener safety checks but requires only the production ingress network, production route mount, and production backend. Unrelated development, EPM, or Consult health can no longer block a Business production release. It is not valid to disable the edge expectation.

Public `/api/health` performs the complete readiness check but returns only status. Operators retrieve checks and revision directly from `http://127.0.0.1:3100/api/health` with `X-Business-Finlynq-Internal-Health: 1`; never send that marker through the public hostname and never authorize health details from `X-Forwarded-For` or `X-Real-IP`. Caddy's active `/api/health` upstream probe needs no marker because it consumes only the HTTP status.

`TRUSTED_PROXY_HOPS` is a fail-closed trust contract, not a general header toggle. When it is unset, blank, `0`, invalid, or larger than the received chain, the application ignores `X-Forwarded-For` and uses the shared `unknown` rate-limit bucket. With a positive value, it validates the entire bounded IP chain and selects that many positions from the right: `1` selects the address written by the immediate trusted proxy, while `2` is appropriate only when two controlled proxies append in a fixed path. Malformed, empty, or overlong chains also resolve to `unknown`; `X-Real-IP` is never a fallback. If a CDN or load balancer is later added, first prevent direct access around every trusted hop, review how each hop sanitizes/appends the header, then change the count to match the proven topology.

Before the first run:

1. Create a root-controlled Compose environment file containing the owner `POSTGRES_PASSWORD` and paths to independent, one-line app, authentication-worker, and backup database password files through `APP_DATABASE_PASSWORD_FILE`, `AUTH_WORKER_DATABASE_PASSWORD_FILE`, and `BACKUP_DATABASE_PASSWORD_FILE`. The files must be 24–1024 characters, root-owned, and readable only by the deployment secret group. Set `BUSINESS_FINLYNQ_HOSTNAME=business.finlynq.com`, `TRUSTED_PROXY_HOPS=1`, `SESSION_COOKIE_NAME=__Host-business_finlynq_session`, `DEMO_LOGIN_ENABLED=true`, and `DEMO_WRITES_ENABLED=true`. Keep `ACCOUNT_LOGIN_ENABLED=false`, `ACCOUNT_SIGNUP_ENABLED=false`, `BUSINESS_WRITES_ENABLED=false`, and `BANK_FEEDS_ENABLED=false` until their separate launch gates pass. Do not put encryption keys or runtime database passwords inline in this file.
2. Create `/etc/business-finlynq/secrets/organization-root-kek` containing exactly one base64-encoded 32-byte key and `/etc/business-finlynq/secrets/identity-secret` containing one base64-encoded 64-byte secret. The first wraps organization DEKs. The second is independently split for identity-field encryption and blind indexes.
3. Make both files root-owned, mode `0440`, with a dedicated numeric group recorded as `BUSINESS_FINLYNQ_SECRET_GID`. Set `ORGANIZATION_ROOT_KEK_FILE` and `IDENTITY_SECRET_FILE` to those host paths. The app receives them as read-only Compose secrets.
4. Mount a one-line Resend key through `AUTH_RESEND_API_KEY_FILE` into the `auth_email_worker` service only, configure the non-secret email provider/sender settings for app and worker, enable the `auth-email` profile, and exercise a one-use reset link before onboarding real users. The public app and invitation service must not mount or read the provider key. Never place the provider key inline in the production environment. Reset tokens are carried in URL fragments and posted to the server so Caddy request logs never receive them. Before enabling self-service signup, also mount a root-controlled Turnstile secret through `TURNSTILE_SECRET_KEY_FILE`, configure `SIGNUP_TURNSTILE_SITE_KEY` for a widget restricted to `business.finlynq.com`, and set `SIGNUP_TURNSTILE_ENABLED=true`.
5. Bootstrap and verify the fixed shared demo, install the single nightly reconciliation schedule, and create the mandatory operations environment with the full release SHA, exact app-gate expectations, and `MONITOR_EXPECT_DEMO_MAINTENANCE=true`. Enable later account, write, backup, and bank-feed flags only after their independent evidence gates.

The authoritative DNS zone for `finlynq.com` is managed at GoDaddy. Cloudflare is used only for the Turnstile challenge in this deployment; it is not the DNS or reverse-proxy authority. Keep the `business.finlynq.com` record pointed at the intended host and let the dedicated Caddy service terminate TLS.

For a dedicated, single-administrator demo host without a privileged provisioning path, `deploy/bootstrap-demo-secrets.sh` creates the ignored Compose environment and a separate user-private key file without printing either secret. It refuses to overwrite existing material. This is a bootstrap convenience only: before accepting real accounting data, move the key to the root-controlled location described above and establish separate off-server key escrow.

On a fresh database volume, the initialization script creates the non-owner/non-`BYPASSRLS` `business_finlynq_app` role. Before migrations, a one-shot provisioner creates `business_finlynq_auth_worker`. After every canonical migration run, Compose re-runs `deploy/postgres/010-runtime-role.sh`, `deploy/postgres/015-auth-worker-role.sh`, and `deploy/postgres/020-backup-role.sh` in that order; these scripts revoke stale privileges and apply the reviewed current-object matrices before bootstrap. The worker keeps only its heartbeat and claim/complete/fail functions with no direct auth-table access. The dedicated `business_finlynq_backup` role gets cross-tenant `SELECT` through `BYPASSRLS`, but no write, create, role, replication, or superuser capability. The migration container connects as `business_finlynq_owner`; all three non-owner roles use separate file-mounted credentials. The operations profile retains a manual backup-role reconciliation command for scheduled backups, but it is no longer the only provisioning path. Never reuse personal Finlynq credentials or key material. Rotating a database password requires changing the matching database role and deployment secret together. Replacing the wrapping-key file requires a versioned DEK rewrap procedure, not a blind file replacement.

Compose fixes the project namespace to `business-finlynq` and applies initial ceilings of 1 CPU/1 GiB to PostgreSQL, 0.5 CPU/512 MiB to migrations, 1 CPU/768 MiB to the app, and 0.5 CPU/256 MiB to the optional edge, with PID and log-rotation limits. Tune these only from observed production load and preserve explicit limits.

Do not expose PostgreSQL or container port `3000` publicly. The loopback `3100` mapping exists for the shared-proxy path and local host diagnostics only.

## Moving to another server

The deployment is portable because Business Finlynq does not share a database, role, Docker network, volume, credential, wrapping key, or release directory with another application. Treat the database backup and wrapping-key backup as separate, equally required recovery artifacts.

1. Put the application in maintenance mode and keep `BUSINESS_WRITES_ENABLED=false` during the move.
2. Create and verify a logical PostgreSQL backup with an explicitly provisioned least-privilege backup role. Copy the encrypted backup off the source server.
3. Transfer the Compose environment through a secret channel and transfer the separately escrowed organization root wrapping key. Preserve the key bytes, ownership, mode, and `BUSINESS_FINLYNQ_SECRET_GID`; never place the key in Git or inside the database backup.
4. Check out the same pinned Git commit on the destination, recreate `/etc/business-finlynq/secrets`, and start a fresh database volume.
5. Restore the backup as the database owner, run any newer migrations once, reapply the app, authentication-worker, and backup-role grant matrices, then start `app` and either the shared-proxy path or the `edge` profile.
6. Verify the application, tenant isolation, audit chain, TLS, and backup restore before switching DNS. Lower DNS TTL ahead of the cutover when possible.
7. Keep the source database and key available but offline until the destination passes the acceptance window; then retire them according to the retention policy.

On a host that enables the writable shared demo, install the Toronto nightly reconciliation timer only after the current migration and shared baseline bootstrap succeed. Follow [the shared demo maintenance runbook](../operations/demo-sandbox-maintenance.md); never bypass a failed or overdue reset state.

The core named volumes are `business_finlynq_pgdata`, its derived ClamAV signature cache `business_finlynq_pgdata_clamav`, `business_finlynq_caddy_data`, `business_finlynq_caddy_config`, and `business_finlynq_private-release-router-state-v2`. PostgreSQL moves should use a logical backup/restore rather than copying `business_finlynq_pgdata` between hosts. Caddy certificate state and the ClamAV cache are reproducible. The router volume contains only its `active`/`maintenance` sentinel: do not copy an `active` sentinel to a destination that has not passed acceptance. Let a new destination volume start in maintenance and use the reviewed installer/release flow to activate it; if the volume is deliberately transferred, set and verify maintenance before starting the listener.

## Required launch gates

Operational procedures and implemented automation are described in the [release](../operations/release-runbook.md), [backup/recovery](../operations/backups-and-recovery.md), [monitoring](../operations/monitoring-and-alerting.md), and [container hardening](../operations/container-hardening.md) runbooks. A gate is complete only after the environment-specific external service and operator drill have produced evidence; committed scripts alone are not evidence.

- Restore drill from off-VPS encrypted database and separately stored root-key backup.
- PostgreSQL tests using a non-owner, non-`BYPASSRLS` runtime role after fresh migration replay.
- A non-superuser schema owner/migrator distinct from the PostgreSQL bootstrap administrator, with explicit grants instead of blanket default CRUD privileges.
- A dedicated least-privilege backup role before automated production backups are enabled.
- A passing full demo-sandbox reconciliation, logout/re-entry claim continuity, nightly-only reset, quarantine/overdue alerting, pool-exhaustion acceptance, and an active maintenance scheduler for every writable-demo release.
- TLS renewal, disk, service, database, audit, backup-age, and failed-recovery alerts.
- Rate-limited email recovery with generic responses and step-up controls.
- A partition/archive and retention policy for real account sessions and immutable authentication security events.
- Encrypted party/address persistence using the active organization DEK, plus key provision, rotation, recovery, and restore drills.
- Authenticated session-to-membership resolution at every business write boundary; never construct tenant context from request body fields.
- Secure, host-only session cookies, CSRF/origin enforcement, content security policy, private/no-store caching for authenticated responses, and rate limits for sensitive operations.
- End-to-end coverage for authorization, maker/approver separation, posting and idempotency concurrency, reversal, period locks, multi-currency, tax, AR/AP, and browser accessibility.
- Immutable, commit-addressed release artifacts with a tested application rollback and forward-only database repair procedure.
- No production MCP write scope beyond draft creation.
