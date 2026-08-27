# Production release runbook

Use this checklist for every Business Finlynq release. Releases are commit-addressed and migrations are forward-only.

## Required evidence before deployment

- CI passed lint, type checking, all unit/PostgreSQL tests, production build, high-severity production dependency audit, and Playwright release gates.
- The candidate image was built from the exact reviewed Git SHA and `BUSINESS_FINLYNQ_IMAGE_REVISION` is that full SHA.
- An encrypted off-site backup completed and its remote checksum was verified.
- The most recent restore drill is within 30 days and includes separate key recovery.
- Database capacity, disk, TLS, external uptime monitor, alert delivery, and auth email worker health are green.
- Any migration was reviewed for locks, runtime-role grants, backup-role grants, rollback compatibility, and required forward repair.
- The last demo-sandbox nightly reconciliation passed, no slot is unexpectedly quarantined or overdue, and the single nightly scheduler is enabled on hosts that allow writable demos.
- The mandatory operations environment contains the full release SHA, matching monitor revision, exact five app-gate expectations, and reviewed demo-pool thresholds.
- A named operator owns the release and another owns rollback/acceptance.

## Deployment

1. Record the current SHA and container image digests. Retain the prior application artifact.
2. Put the application in the appropriate maintenance/write state. Never leave writes enabled while migrating. Stop `business-finlynq-backup.timer`, `business-finlynq-monitor.timer`, and `business-finlynq-demo-reconcile.timer` before changing the checkout or schema so a backup, monitor, or old reset artifact cannot overlap migration or emit false alerts.
3. Run `deploy/backup/run-scheduled-backup.sh` and verify its off-site marker.
4. Build all required targets from the pinned SHA. Do not use an unreviewed working tree.
5. Run the one-shot migrator as the database owner. Before bootstrap or app startup, run the mandatory post-migration runtime and authentication-worker grant reconciliations; then re-run the backup-role provisioner so new relations are covered. A migration is incomplete until all three explicit grant matrices succeed.
6. Recreate the app. If real login is enabled, recreate the `auth-email` worker profile with the same SHA. Normal `bootstrap_demo` prepares only additive dirty slots and preserves assigned claims; do not run full reconciliation as an ordinary deploy step. Restart the nightly, backup, and monitor schedulers. Run destructive full-pool acceptance only in an explicit maintenance window or for a fresh install.
7. Verify container state, `/api/live`, `/api/health`, response security headers, release revision, auth worker, and external monitoring.
8. Run the browser acceptance path: public site, protected redirect, isolated demo-sandbox claim, workspace route, logout/session revocation, pool exhaustion behavior, recovery delivery, and mobile navigation.
9. Re-enable writes only after tenant isolation, posting authorization, idempotency, audit insertion, and period controls pass against the deployed release.
10. Record completion, evidence links, backup checksum, image digest, and operator approvals.

When running the release gate against production, export explicit expectations so an accidentally disabled launch gate cannot pass merely because the Playwright runner does not share the server environment:

```text
PLAYWRIGHT_BASE_URL=https://business.finlynq.com
E2E_EXPECT_ACCOUNT_LOGIN_ENABLED=true
E2E_EXPECT_ACCOUNT_SIGNUP_ENABLED=true
E2E_EXPECT_AUTH_EMAIL_WORKER=true
npm run test:e2e
```

The browser test also reads `/api/health`, checks that enabled signup implies ready authentication and email delivery, and requires Cloudflare's widget API to render its response control on the live signup page. Managed challenges may solve without exposing a visible iframe, and Cloudflare does not guarantee that iframe as a public integration contract.

## Rollback

- If the schema remains compatible, redeploy the prior immutable application artifact and repeat acceptance.
- If the schema is incompatible, keep writes disabled and apply a reviewed forward repair migration. Do not run an ad hoc down migration.
- Never delete the PostgreSQL volume, restore over the live database, or replace an encryption key to make an old artifact start.
- A database restore is a disaster-recovery operation into an isolated empty destination, not the normal application rollback mechanism.

### One-release f8485 credential adapter

The retained pre-file-secret app (`f8485ca86fef5b5fb4a38be9cb4cf3bea5ac2107`) predates the file-based app database password contract. Its deployed image ID was recorded as `sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5`; the one-release override hard-pins that retained local image and uses `pull_policy: never`. This override is deliberately target-server-specific: it works only while that exact recorded image remains in the target server's local image store. `deploy/rollback/docker-compose.legacy-inline-password.yml` mounts the normal app password file and replaces only the old container entrypoint with a restricted adapter. The adapter validates the file and exact revision, exports the legacy variable only inside that container, and may execute only `node server.js`. The password is never rendered into Compose, a command argument, or the new app container.

This rollback is intentionally a degraded availability mode: the override forces demo login, demo writes, real account login and signup, email delivery, Turnstile, and business writes off. It can keep readiness and the public informational surface available while a forward repair is prepared, but it cannot provide an authenticated workspace. Migration `0012` replaced the legacy demo-session function, so neither the synthetic demo nor any account workflow is compatible with f8485 after the current forward migrations.

Before the release, rehearse the retained target-server image against an isolated current-schema restore and archive the degraded readiness/disabled-login result. On that target server, with the restore secrets and backup manifest configured, run:

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
