# Development deployment from `dev`

Business Finlynq keeps two long-lived deployment branches with disjoint targets:

- `dev` deploys to the development stack at `dev.business.finlynq.com`;
- `main` deploys to production at `business.finlynq.com`.

A same-repository push to `dev` must pass the complete `quality-gate` job before CI publishes the immutable `deploy-development-<full-sha>` tag. The development timer accepts only that exact tag and a fast-forward `origin/dev` commit. Production continues to accept only `deploy-production-<full-sha>` tags for `origin/main`.

## Isolation contract

The development stack uses its own checkout, Compose project, loopback port, database volume, networks, secrets, state directory, and failure latch:

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

The environment initially sets `DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE=false` so the first internal deployment can be validated before Caddy/DNS activation. After the A record for `dev.business.finlynq.com` resolves to the application host and the shared edge has been recreated from the promoted Compose/Caddy configuration, change that value to `true`, run the browser acceptance container once, and keep it true for later automatic deployments.

## Promotion

Develop and test on `dev`, then merge the exact accepted `dev` revision into `main` with a normal fast-forward or reviewed pull request. Never force-push either deployment branch. Production remains unchanged until the resulting `main` commit passes its own quality gate and receives its separate production deployment signal.

Inspect the development automation with:

```bash
systemctl status business-finlynq-development-deployment.timer
systemctl start business-finlynq-development-deployment.service
journalctl -u business-finlynq-development-deployment.service --since today
```

If a mutated deployment fails, later attempts remain latched. Review the journal and current development containers, then clear only the matching revision:

```bash
failed_revision=<full-failed-sha>
sudo env \
  "DEVELOPMENT_DEPLOYMENT_FAILURE_ACK=clear:$failed_revision" \
  /usr/local/sbin/business-finlynq-deploy-development \
    --clear-failure "$failed_revision"
```

