# Development deployment from `dev`

Business Finlynq keeps two long-lived deployment branches with disjoint targets:

- `dev` deploys to the development stack at `dev.business.finlynq.com`;
- `main` deploys to production at `business.finlynq.com`.

A same-repository push to `dev` must pass the complete `quality-gate` job before CI publishes the immutable `deploy-development-<full-sha>` tag. The development timer accepts only that exact tag and a fast-forward `origin/dev` commit. Production continues to accept only `deploy-production-<full-sha>` tags for `origin/main`.

## Isolation contract

The development stack uses its own checkout, Compose project, loopback port, database volume, networks, secrets, and deployment state:

| Boundary | Development | Production |
| --- | --- | --- |
| Checkout | `/home/deploy/business-finlynq-development` | `/home/deploy/business-finlynq` |
| Compose project | `business-finlynq-development` | `business-finlynq` |
| Configuration | `/etc/business-finlynq-development` | `/etc/business-finlynq` |
| State | `/var/lib/business-finlynq-development` | `/var/lib/business-finlynq` |
| Loopback app port | `3200` | `3100` |
| Database volume | `business_finlynq_development_pgdata` | `business_finlynq_pgdata` |
| Public hostname | `dev.business.finlynq.com` | `business.finlynq.com` |

Both deployment services acquire `/var/lib/business-finlynq/deployment-host.lock`, so builds and migrations cannot overlap on the shared server. The shared Caddy edge joins the development edge network only to reach the `development-app` alias; the application database and private network remain inaccessible from production containers.

Development data is disposable and must never be restored from an unsanitized production backup. Development starts with demo login/writes and the real-business write engine enabled, but real account login, signup, email delivery, Turnstile, and bank feeds disabled. Enable those identity gates only after installing development-specific provider credentials; never copy production provider credentials or encryption keys.

## Installation

After `dev` exists remotely and its first CI run has published the immutable signal, run from a clean reviewed checkout:

```bash
sudo bash deploy/development/install-development.sh --enable
sudo systemctl start business-finlynq-development-deployment.service
```

The installer creates independent random database credentials and encryption secrets without printing them. It also creates the external development edge network and gives `deploy` narrowly scoped permission to start, inspect, and read the journal for the development deployment service.

The environment initially sets `DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE=false` so the first internal deployment can be validated before Caddy/DNS activation. After the A record for `dev.business.finlynq.com` resolves to the application host and the shared edge has been recreated from the promoted Compose/Caddy configuration, change that value to `true`, run the browser acceptance container once, and keep it true for later automatic deployments. On later releases, the deployer waits up to two minutes for the exact public `/api/health` response to return `ready` before starting browser acceptance. The acceptance container marks that public target as an already managed server so Playwright cannot fall back to starting a second local Next.js process; ordinary CI browser runs still start their own reviewed build.

## Enable every development feature

Keep the initial fail-closed installation until development-specific provider credentials exist. Create a separate Resend sending-access key and a separate Cloudflare Turnstile widget restricted to `dev.business.finlynq.com`; using the same verified sending domain is acceptable, but never copy a production API key or Turnstile secret into development. Treat the sender address domain as an exact provider contract: if Resend lists only `finlynq.com` as verified, use an address ending in `@finlynq.com`, such as `noreply-dev-business@finlynq.com`. Do not assume an unlisted nested sender domain such as `dev.business.finlynq.com` is covered; verify the intended `From` address with one delivery to an operator-owned mailbox before enabling automated delivery.

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

From a clean, reviewed `dev` checkout, opt in explicitly with the non-secret sender metadata and Turnstile site key:

```bash
sudo bash deploy/development/install-development.sh \
  --enable \
  --enable-all-features \
  --auth-email-from 'Business Finlynq Development <noreply-dev-business@finlynq.com>' \
  --auth-email-reply-to 'support@finlynq.com' \
  --turnstile-site-key '<development-site-key>'
sudo systemctl start business-finlynq-development-deployment.service
```

The installer refuses provider secrets with unsafe ownership, mode, symlink status, or line structure. The opt-in atomically enables demo and real-account login, signup, email delivery, Turnstile, business writes, bank feeds, and public acceptance. The development deployer compares the running container with the reviewed Compose environment, so a gate or provider-metadata change forces recreation even when the Git revision is unchanged.

## Direct-to-development acceptance and automatic recovery

Every signalled candidate is installed directly on the development stack and validated against `https://dev.business.finlynq.com`; there is no second shadow stack. Public browser acceptance is attempted twice before the candidate is rejected. The PostgreSQL volume remains mounted throughout deployment and recovery.

The deployer records the last fully accepted SHA in the root-only `accepted-revision` state file. If checkout, build, migration/startup, public acceptance, or final health verification fails, it attempts to restore that exact checkout and image revision. Recovery is considered successful only after the restored app reports the expected revision on its internal detailed health endpoint and the public HTTPS health endpoint remains ready.

After verified recovery, the failed SHA is quarantined rather than globally latching all future deployments. The deployer removes only containers from the development Compose project whose image label matches that SHA, removes the exact Finlynq image tags for that SHA, prunes dangling images with the same revision label, and bounds BuildKit cache to 8 GB. It never runs `docker system prune`, never removes a volume, and preserves an image revision if another Compose project still uses it. The quarantine is a single atomic state file, not an artifact directory, so repeated failures cannot accumulate retained release folders.

The same quarantined SHA is not retried. Its cleanup is retried automatically when needed, and a newer fast-forward SHA with its own successful CI signal is evaluated without operator acknowledgement. Only an inability to verify the restored runtime creates `deployment-hard-failed` and stops subsequent candidates for manual recovery; this is the safety boundary for potentially incompatible persistent-database changes.

## Promotion

Develop and test on `dev`, then merge the exact accepted `dev` revision into `main` with a normal fast-forward or reviewed pull request. Never force-push either deployment branch. Production remains unchanged until the resulting `main` commit passes its own quality gate and receives its separate production deployment signal.

Inspect the development automation with:

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
