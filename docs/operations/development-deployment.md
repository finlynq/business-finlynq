# Development and staging deployment

## Environment and promotion contract

Business Finlynq uses three long-lived branches with three distinct deployment
targets and a one-way promotion path:

| Branch | Environment | Public hostname |
| --- | --- | --- |
| `dev` | Hosted development | `dev.business.finlynq.com` |
| `stage` | Staging | `stage.business.finlynq.com` |
| `main` | Production | `business.finlynq.com` |

Promote revisions only in this direction: `dev` -> `stage` -> `main`. A request
to "deploy to dev" means deploy `origin/dev` to
`dev.business.finlynq.com`. It does **not** authorize a merge or push to
`stage`, and it must never be satisfied by deploying the staging stack. A
request to deploy or promote to staging must name `stage` or
`stage.business.finlynq.com` explicitly.

Each environment has a separate purpose:

1. Developers integrate changes on `dev`, deploy them to the hosted development
   environment, and test that the application works correctly at
   `dev.business.finlynq.com`.
2. After development acceptance, promote the exact accepted revision to
   `stage`. Staging is the production-migration rehearsal: run the same schema,
   data, grant, bootstrap, application, and verification sequence intended for
   production against isolated demo or sanitized data at
   `stage.business.finlynq.com`.
3. Only after the staging rehearsal succeeds, promote the exact accepted
   staging revision to `main` and run the separately controlled production
   deployment at `business.finlynq.com`.

If any gate fails, stop promotion, fix the issue on `dev`, and repeat the dev
and staging gates. Do not patch `stage` or `main` directly to bypass a failed
earlier environment.

Before starting a deployment, record and verify all five values: requested
environment, source branch, full revision, public hostname, and deployment
service. Stop if any configured hostname, checkout, Compose project, or service
points at a different environment. A successful response from the requested
hostname is not sufficient proof when two hostnames route to the same backend.

Each hosted environment has an independent checkout, Compose namespace,
database volume, secret set, deployment state, stable router, loopback port,
edge network, alias, public route, deployment service, and finalization
verifier. Never put `dev.business.finlynq.com` and
`stage.business.finlynq.com` in the same central-edge site block or point them
at the same upstream.

A same-repository push to `dev` must pass the complete `quality-gate` job
before CI publishes the immutable `deploy-development-<full-sha>` tag. The dev
timer accepts only that exact tag and a fast-forward `origin/dev` commit. A
push to `stage` similarly publishes `deploy-stage-<full-sha>`, which only the
staging timer consumes. Production instead accepts only the exact keyless
deployment-signal attestation for `origin/main` documented in
[Continuous deployment from main](./continuous-deployment.md).

## Development checkout

Daily work happens on `dev` in `/home/deploy/business-finlynq-dev`. This
checkout is also the only source for the hosted-development deployment. Unit,
lint, type, and static checks can run from this checkout without a long-lived database;
database integration tests should use a disposable local PostgreSQL database
through the `TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, and
`TEST_AUTH_WORKER_DATABASE_URL` settings documented in the repository README.
Never point development work or tests at the staging or production database,
and never substitute the staging deployer for the dev deployer.

## Deployment isolation contract

The three deployment targets use disjoint resources:

| Boundary | Development | Staging | Production |
| --- | --- | --- | --- |
| Branch | `dev` | `stage` | `main` |
| Checkout | `/home/deploy/business-finlynq-dev` | `/home/deploy/business-finlynq-stage` | `/home/deploy/business-finlynq` |
| Compose project | `business-finlynq-dev` | `business-finlynq-development` | `business-finlynq` |
| Configuration | `/etc/business-finlynq-dev` | `/etc/business-finlynq-development` | `/etc/business-finlynq` |
| State | `/var/lib/business-finlynq-dev` | `/var/lib/business-finlynq-development` | `/var/lib/business-finlynq` |
| Deployment service | `business-finlynq-dev-deployment.service` | `business-finlynq-development-deployment.service` | `business-finlynq-continuous-deployment.service` |
| Loopback router ingress | `3201` | `3200` | `3100` |
| Database volume | `business_finlynq_dev_pgdata` | `business_finlynq_development_pgdata` | `business_finlynq_pgdata` |
| Edge network | `business_finlynq_dev_edge` | `business_finlynq_development_edge` | `business_finlynq_edge` |
| Edge alias | `dev-app` | `development-app` | `production-app` |
| Public hostname | `dev.business.finlynq.com` | `stage.business.finlynq.com` | `business.finlynq.com` |

All three deployment services acquire
`/var/lib/business-finlynq/deployment-host.lock`, so builds and migrations
cannot overlap on the shared server. Historical resource names containing
`development` refer to this staging stack and do not make it a deployment of
the `dev` branch. The centrally owned shared edge joins each ingress network
only to reach that environment's alias; application databases and private
networks remain inaccessible from the edge and from the other environments.

Staging data is disposable and must never be restored from an unsanitized production backup. Staging starts with demo login/writes and the real-business write engine enabled, but real account login, signup, email delivery, Turnstile, and bank feeds disabled. Enable those identity gates only after installing staging-specific provider credentials; never copy production provider credentials or encryption keys.

## Installation

The central edge owns and provisions `business_finlynq_dev_edge`; the Business
installer validates its exact subnet and labels but never creates or repairs
it. For the first hosted-development deployment, provision that reviewed
network, then run from the clean `dev` checkout while the public route still
points nowhere or remains in maintenance:

```bash
sudo bash deploy/dev/install-dev.sh \
  --external-edge \
  --skip-public-acceptance
sudo systemctl start business-finlynq-dev-deployment.service
```

Verify the private loopback endpoint at `127.0.0.1:3201`, the exact running
revision, isolated database volume, and `dev-app` ownership on
`business_finlynq_dev_edge`. Then release the separately reviewed shared-edge
change that routes only `dev.business.finlynq.com` to `dev-app:3000`. Once that
route is live, require public acceptance, enable the timer, reconcile the same
accepted revision, and run the root-owned finalization verifier:

```bash
sudo bash deploy/dev/install-dev.sh \
  --external-edge \
  --require-public-acceptance \
  --enable
sudo systemctl start business-finlynq-dev-deployment.service
sudo /usr/local/sbin/business-finlynq-verify-dev-finalized
```

Do not begin the staging promotion unless the last command ends with
`FINALIZED revision=<full-sha>` for the exact `origin/dev` revision under
review.

After `stage` exists remotely and its CI run has published the immutable
staging signal, run from the clean `/home/deploy/business-finlynq-stage`
checkout:

```bash
sudo bash deploy/development/install-development.sh --enable
sudo systemctl start business-finlynq-development-deployment.service
```

Each installer creates independent random database credentials and encryption
secrets without printing them. Neither installer creates its externally
connected edge network. Each gives `deploy` narrowly scoped permission to
start, inspect, and read the journal for only its matching deployment service.

The installer also publishes a root-owned, read-only finalization verifier. It
accepts no arguments and derives the accepted revision from protected state, so
the `deploy` account can request the same complete post-deployment proof without
selecting files or subcommands:

```bash
sudo /usr/local/sbin/business-finlynq-verify-development-finalized
```

The verifier requires a successful inactive deployment service, exact parity
between the protected accepted revision, Compose environment, and immutable app
and worker image IDs, no failure or quarantine state, one healthy durably active
release router, and the complete read-only development shared-edge contract. It
also refuses stale installed verifier code by matching both root-owned verifier
blobs to the accepted Git revision. A successful run ends with
`FINALIZED revision=<full-sha>`.

If an accepted release changes either verifier blob, this command fails closed
until an operator reruns the installer from that clean accepted `stage` checkout.
Ordinary application-only releases do not require that root refresh.

This is an operational consistency check, not an attestation against a
compromised `deploy` account. On hosts where `deploy` can access the Docker
daemon, that account is already root-equivalent. Removing that broader access
requires a separate review of every deployment and troubleshooting workflow.

## Historical staging hostname cutover

Historically, staging used `dev.business.finlynq.com`. That hostname is now
reserved for the distinct hosted-development environment described above. The
following records the completed staging cutover to
`stage.business.finlynq.com`; it does not authorize reusing the current staging
backend as the dev environment. When hosted development is provisioned, replace
the legacy compatibility route only through the separately governed shared-edge
cutover and only after the new isolated dev backend is ready through a private
verification path.

The staging cutover sequence was:

1. In GoDaddy DNS, create an `A` record for `stage.business` pointing to `51.161.113.222`. Keep the existing `dev.business` record during the transition.
2. Add `https://stage.business.finlynq.com/api/auth/oidc/callback` to the staging Microsoft Entra app registration. Keep the legacy callback until the cutover is accepted. Update any enabled document-provider and Turnstile registrations to allow the new hostname.
3. Through the separately governed `/home/ubuntu/finlynq-shared-edge` release process, add the new staging hostname to the Business route while retaining the legacy route during validation. Confirm Caddy has obtained a valid certificate for the new hostname.
4. From the clean, reviewed `stage` checkout, atomically migrate the three application-origin settings and enable the existing staging deployer:

   ```bash
   sudo bash deploy/development/install-development.sh \
     --migrate-stage-hostname \
     --external-edge \
     --require-public-acceptance \
     --enable
   sudo systemctl start business-finlynq-development-deployment.service
   ```

5. Verify `/api/live`, `/api/health`, password login, Microsoft login/signup, and any enabled document OAuth flow at the new hostname. Only then replace the legacy shared-edge route with a permanent redirect to `https://stage.business.finlynq.com{uri}`. Host-only session cookies do not migrate between names, so existing staging users must sign in again.

The migration flag accepts only the exact legacy origin triplet and rewrites it to the exact staging triplet. It refuses mixed or unexpected hostname configuration.

The environment sets `BUSINESS_FINLYNQ_EDGE_MODE=external` because shared-edge contract v1 is the only supported public-ingress mode. The installer requires the pre-existing `business_finlynq_development_edge` internal bridge and never creates or repairs it. `DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE=false` permits the first internal deployment before central route activation. After central cutover, rerun the installer with `--external-edge --require-public-acceptance`. That protected update changes only `DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE`; it does not enable login, email, Turnstile, bank-feed, or other provider gates. Rerun the development deployer at the same accepted revision to force configuration reconciliation and prove public browser acceptance. When public acceptance is required, the deployer waits up to two minutes for a private-preview `/api/health` request through the exact development hostname to return `ready` before starting browser acceptance. The request carries the deployment's ephemeral preview token; uncredentialed public health and application routes remain in maintenance with `503` until activation. The acceptance container marks that public target as an already managed server so Playwright cannot fall back to starting a second local Next.js process; ordinary CI browser runs still start their own reviewed build.

## Enable every staging feature

Keep the initial fail-closed installation until staging-specific provider credentials exist. Create a separate Resend sending-access key and a separate Cloudflare Turnstile widget restricted to `stage.business.finlynq.com`; using the same verified sending domain is acceptable, but never copy a production API key or Turnstile secret into staging. Treat the sender address domain as an exact provider contract: if Resend lists only `finlynq.com` as verified, use an address ending in `@finlynq.com`, such as `noreply-stage-business@finlynq.com`. Do not assume an unlisted nested sender domain such as `stage.business.finlynq.com` is covered; verify the intended `From` address with one delivery to an operator-owned mailbox before enabling automated delivery.

Install each one-line secret without placing its value in shell history, then make it readable only by the deployment secret group:

```bash
sudo install -o root -g business-finlynq-secrets -m 0440 /dev/null \
  /etc/business-finlynq-development/secrets/resend-api-key
read -rsp "Development Resend API key: " development_resend_key; printf '\n'
printf '%s\n' "$development_resend_key" | sudo tee \
  /etc/business-finlynq-development/secrets/resend-api-key >/dev/null
unset development_resend_key

sudo install -o root -g business-finlynq-secrets -m 0440 /dev/null \
  /etc/business-finlynq-development/secrets/turnstile-secret-key
read -rsp "Development Turnstile secret key: " development_turnstile_key; printf '\n'
printf '%s\n' "$development_turnstile_key" | sudo tee \
  /etc/business-finlynq-development/secrets/turnstile-secret-key >/dev/null
unset development_turnstile_key
sudo chown root:business-finlynq-secrets \
  /etc/business-finlynq-development/secrets/{resend-api-key,turnstile-secret-key}
sudo chmod 0440 \
  /etc/business-finlynq-development/secrets/{resend-api-key,turnstile-secret-key}
for secret_file in \
  /etc/business-finlynq-development/secrets/{resend-api-key,turnstile-secret-key}; do
  sudo awk 'END { print FNR, FILENAME }' "$secret_file"
done
sudo stat -c '%U:%G:%a %n' -- \
  /etc/business-finlynq-development/secrets/{resend-api-key,turnstile-secret-key}
```

The two `awk` results must each be `1`, and both `stat` results must begin with `root:business-finlynq-secrets:440`; these checks do not print either secret. When entering a secret through a browser-hosted server console, confirm the console keyboard layout before the masked prompt—on a US layout, underscore is `Shift`+`-`. Never omit or substitute a character that the console renders unexpectedly; verify the installed credential with its provider before enabling the feature gates.

From a clean, reviewed `stage` checkout, opt in explicitly with the non-secret sender metadata and Turnstile site key:

```bash
sudo bash deploy/development/install-development.sh \
  --enable \
  --enable-all-features \
  --auth-email-from 'Business Finlynq Staging <noreply-stage-business@finlynq.com>' \
  --auth-email-reply-to 'support@finlynq.com' \
  --turnstile-site-key '<development-site-key>'
sudo systemctl start business-finlynq-development-deployment.service
```

The installer refuses provider secrets with unsafe ownership, mode, symlink status, or line structure. The opt-in atomically enables demo and real-account login, signup, email delivery, Turnstile, business writes, bank feeds, and public acceptance. The development deployer compares the running container with the reviewed Compose environment, so a gate or provider-metadata change forces recreation even when the Git revision is unchanged.

## Official central-bank FX modes

`BANK_OF_CANADA` and `EUROPEAN_CENTRAL_BANK` need no provider secret, OAuth
registration, API key, installer option, or deployment-wide feature flag. They
become selectable after the reviewed application revision and FX-policy
migration are deployed. Each organization remains `STORED_ONLY` until one of
its administrators selects a mode, sets the bounded one-to-seven-calendar-day
lookback, records a reason, and completes the normal permission and MFA checks.

The application container needs outbound HTTPS access to
`www.bankofcanada.ca` and `data-api.ecb.europa.eu`. Do not add a general proxy
fallback or copy provider responses into deployment configuration. Stored
organization rates retain automatic priority, and an authorized invoice or
settlement request can supply explicit FX evidence for a rate-sensitive
transaction.

Ordinary CI uses mocked provider transport. After deployment, validate each
official source in development with recent direct, inverse, and common-date
cross cases, plus a weekend/holiday lookback and an unavailable case. Compare
the saved source legs and formula with the official response and confirm failure
occurs before any accounting or cloud-file write. Record the revision, mode,
pair, request date, observation date, and outcome without tokens or full
responses. Keep production untouched until the revision is deliberately
promoted through its separate process. See the
[FX rate provider runbook](fx-rate-providers.md) for the formulas, attribution
and reuse conditions, source caveats, and complete validation procedure.

## Experimental Yahoo FX gate

Yahoo FX is independent of `--enable-all-features` and defaults off. It uses an
undocumented Finance chart route whose availability and data rights are not
established by a Yahoo consumer subscription. Read the
[FX rate provider runbook](fx-rate-providers.md) and complete its operator
licensing, retention, display, and attribution review before enabling it.

Enable the operator gate in development and apply the configuration immediately:

```bash
sudo bash deploy/development/install-development.sh \
  --enable-yahoo-fx-experimental \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

This sets only the deployment-wide `YAHOO_FX_ENABLED` gate. Each organization
continues to use `STORED_ONLY` until one of its administrators explicitly
acknowledges and selects `YAHOO_FINANCE_EXPERIMENTAL`. Both gates must be active
before FinLynQ makes a request. Stored organization rates always have priority.

Disable provider calls and recreate the app at the current reviewed revision:

```bash
sudo bash deploy/development/install-development.sh \
  --disable-yahoo-fx \
  --enable
sudo systemctl start business-finlynq-development-deployment.service
```

Disabling the operator gate preserves organization policy, stored rates, and
immutable historical snapshots. Production remains off by default and has no
activation procedure in this guide. Provider tests in ordinary CI use mocks;
optional live checks are non-production, explicitly authorized, and never a
release-gate dependency.

## Direct-to-staging acceptance and automatic recovery

Every signalled candidate is installed directly on the staging stack; there is no second shadow stack, and the PostgreSQL volume remains mounted throughout deployment and recovery. With `DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE=true`, browser acceptance targets `https://stage.business.finlynq.com` through the private-preview token and is attempted twice before the candidate is rejected. With the flag false, the deployer performs only its private/internal candidate checks and does not claim public browser acceptance.

For router-aware routine releases, candidate images are built before the maintenance interval. The existing stable router is then atomically reloaded to maintenance, so uncredentialed staging traffic receives deterministic `503` responses while the old app is stopped, migration/bootstrap dependencies and the candidate start, and any required two-attempt browser gate runs. A candidate that passes every private and public check reloads the same listener live-active while durable state remains maintenance; the accepted-revision record is atomically published, then the router's durable `active` sentinel is committed last. A failed finalization restores the prior accepted pointer and fail-closes the router, so a restarted listener cannot select an unaccepted candidate. The one-time legacy transition cannot enter router maintenance until the old app releases port `3200`; that bootstrap may briefly refuse connections before the stable router starts fail-closed in maintenance.

The deployer records the last fully accepted SHA in the root-only `accepted-revision` state file. If checkout, build, migration/startup, public acceptance, or final health verification fails, it attempts to restore that exact checkout and image revision. Recovery is considered successful only after the restored app reports the expected revision on its internal detailed health endpoint and the public HTTPS health endpoint remains ready. Before a newer candidate mutates an installation already held in fail-closed maintenance, the candidate's immutable external-edge verifier accepts only the complete deterministic maintenance contract (`/api/live` ready, application/readiness routes `503`, `Retry-After: 5`, and the reviewed security boundaries); active routing still requires the complete ready contract. If an accepted runtime image tag is no longer present, recovery rebuilds only the required runtime images from that exact accepted checkout and verifies their embedded revision labels before starting them.


After verified recovery, the failed SHA is quarantined rather than globally latching all future deployments. The deployer removes only containers from the staging Compose project (historically named `business-finlynq-development`) whose image label matches that SHA, removes the exact Finlynq image tags for that SHA, prunes dangling images with the same revision label, and bounds BuildKit cache to 8 GB. It never runs `docker system prune`, never removes a volume, and preserves an image revision if another Compose project still uses it. The quarantine is a single atomic state file, not an artifact directory, so repeated failures cannot accumulate retained release folders.

The same quarantined SHA is not retried. Its cleanup is retried automatically when needed, and a newer fast-forward SHA with its own successful CI signal is evaluated without operator acknowledgement. Only an inability to verify the restored runtime creates `deployment-hard-failed` and stops subsequent candidates for manual recovery; this is the safety boundary for potentially incompatible persistent-database changes.

On the one-time transition from the old global latch, the latch’s `sourceRevision` is treated as the recovery authority. The deployer restores and verifies that revision, quarantines and removes the recorded failed candidate, and only then evaluates the newer CI-approved SHA.

## Promotion

Promotion requires evidence from all three gates:

1. **Development acceptance:** deploy the candidate from `origin/dev` only to
   `dev.business.finlynq.com`. Run the required automated suite and functional
   smoke tests there, verify health and authentication boundaries, and record
   the accepted full Git revision.
2. **Staging migration rehearsal:** promote that exact revision to `stage` with
   a normal fast-forward or reviewed pull request. Deploy it only to
   `stage.business.finlynq.com`. Execute the same ordered migration and rollout
   procedure planned for production, including schema and data migrations,
   database grants, application startup, health checks, critical workflows,
   and recovery or rollback checks. Use only isolated demo or sanitized data;
   never restore an unsanitized production backup. Record the accepted revision
   and rehearsal result.
3. **Production migration:** promote the exact staging-accepted revision to
   `main` with a normal fast-forward or reviewed pull request. Confirm that the
   Git revision and migration set match the successful staging rehearsal, then
   use the separately controlled production deployment and validation process.

Never use a staging deployment as evidence that `dev` was deployed, never skip
an environment, never introduce unreviewed migration steps between staging and
production, and never force-push a long-lived branch. Production remains
unchanged until the resulting `main` commit passes its own quality gate and
receives its separate production deployment signal.

Inspect the historically named staging automation with:

```bash
systemctl status business-finlynq-development-deployment.timer
systemctl start business-finlynq-development-deployment.service
journalctl -u business-finlynq-development-deployment.service --since today
```

Ordinary candidate failures do not need a manual latch-clear command. The service restores the last accepted revision, verifies it internally and through the live development HTTPS route, removes the failed revision’s development containers and image tags, bounds build cache, and waits for a newer CI-approved SHA. Inspect `/var/lib/business-finlynq-development/quarantined-candidate` and the journal for the compact failure record; no failed release directory is retained.

Manual acknowledgement is reserved for `deployment-hard-failed`, which is written only when the prior accepted runtime cannot be restored and verified. Candidate artifacts are retained in that case because they may be required to diagnose or recover the persistent database. After recovery and review, clear only the exact recorded SHA:

```bash
failed_revision=<full-failed-sha>
sudo env \
  "DEVELOPMENT_DEPLOYMENT_FAILURE_ACK=clear:$failed_revision" \
  /usr/local/sbin/business-finlynq-deploy-development \
    --clear-failure "$failed_revision"
```
