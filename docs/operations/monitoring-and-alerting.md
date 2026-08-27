# Monitoring and alerting runbook

Business Finlynq exposes two deliberately different probes:

- `/api/live` confirms that the Node process can answer HTTP. It does not touch secrets or PostgreSQL and is used by the container health check that gates Caddy startup.
- `/api/health` is readiness. It returns `503` unless PostgreSQL, the organization root wrapping key, and the independent identity secret are available and valid. When real accounts are enabled it also requires valid non-secret delivery metadata and a fresh database heartbeat from the authentication email worker, with no expired lease or seriously delayed due item.

Both endpoints are non-cacheable and excluded from indexing. Readiness returns only component state and the configured release revision; it does not expose credentials, host details, database timings, or exception messages.

## Host monitor

`deploy/monitoring/check-production.sh` is a five-minute synthetic/host check. It validates:

- public HTTPS readiness and required no-store/HSTS headers;
- certificate validity beyond the configured threshold;
- expected app, database, and edge container state;
- exact app-container demo/account/business write gates for the reviewed release;
- the selected systemd or deploy-owned cron reset/reconciliation scheduler when writable sandboxes are expected;
- the full externally served, configured, and container release revision;
- aggregate sandbox capacity and state, including size, minimum ready capacity, stranded reset work, and quarantine;
- backup filesystem utilization;
- newest backup age, internally consistent manifest/artifact/checksum, and verified off-site marker.

Install the committed service and timer:

```bash
install -m 0555 deploy/monitoring/check-production.sh /usr/local/sbin/business-finlynq-check-production
install -m 0555 deploy/monitoring/notify-failure.sh /usr/local/sbin/business-finlynq-notify-failure
install -m 0644 deploy/systemd/business-finlynq-monitor.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor-notify@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now business-finlynq-monitor.timer
systemctl start business-finlynq-monitor.service
```

The unit files invoke the scripts from `/home/deploy/business-finlynq`; the optional `/usr/local/sbin` copies above are useful for administrators but are not used unless the unit is customized. If the checkout moves, update the service paths before reloading the units so an `OnFailure` notification never points at a stale release.

Configure the mandatory `/etc/business-finlynq/operations.env` with thresholds and every explicit expected gate from `.env.example`. The backup, monitor, and nightly demo-maintenance service refuse to start without it; only the failure notifier treats it as optional so it can still report a missing file. For webhook delivery, put one HTTPS URL in `/etc/business-finlynq/secrets/monitor-webhook-url`, mode `0400`. The notification contains only the failed unit and host name. If no webhook exists, the failure remains in journald, which is safe but is **not** an external alert.

If root-managed systemd timers are temporarily unavailable, the reviewed fallback is the `deploy` user's UTC crontab. Copy the same operations settings to `/home/deploy/.config/business-finlynq/operations.env`, set `MONITOR_MAINTENANCE_SCHEDULER=cron`, make the file owned by `deploy` with mode `0600`, then run `bash deploy/cron/install.sh` as `deploy`. The idempotent installer replaces only its marked block and preserves unrelated entries, including removing the retired five-minute reset and hourly due-check. The allowlisted schedule invokes reconciliation at 08:15 and 09:15 UTC; the wrapper verifies exact `04:15` `America/Toronto` time so one invocation resets across EST/EDT and the other exits. A success-only local-date stamp prevents duplicates. Backup remains every six hours and monitoring every five minutes. The production monitor requires the exact three-job block. Before a release, `bash deploy/cron/remove.sh` drains active wrappers under an exclusive scheduler lock and removes only the marked block; rerun the installer after acceptance. Prefer the DST-aware systemd timer once root operator access is available.

Set `MONITOR_EXPECT_REVISION` to the same full reviewed Git SHA as `BUSINESS_FINLYNQ_IMAGE_REVISION` during each release. Both are mandatory, must match exactly, and are checked against the running container and readiness response.

Set `MONITOR_EXPECT_AUTH_EMAIL_WORKER=true` at the same cutover that enables real account email delivery. Before that cutover it stays false so the intentionally absent profile is not reported as an outage.

The production writable-demo boundary requires the reviewed login/write gates and `MONITOR_EXPECT_DEMO_MAINTENANCE=true`. The host monitor fails if the app differs, the selected scheduler is missing or altered, the pool is not exactly 128 slots, any slot is quarantined, a reset is stranded or overdue, or ready capacity falls below four outside an active maintenance pass. Set maintenance false only when demo login and writes are intentionally disabled, such as during rollback to an artifact that predates sandbox resets.

The database readiness contract intentionally reports dead-letter count separately from worker availability: one permanently failed address must not disable every account login. Configure centralized worker-log/provider telemetry to page on any transition to `DEAD`, and retain a metric for oldest pending age. The public readiness endpoint catches a stopped worker, stuck lease, or materially delayed due queue without exposing counts or recipients.

Production requires an independent external uptime/alerting service that calls `https://business.finlynq.com/api/health` from outside the VPS and pages at least two operators. A local timer cannot report a total VPS, network, or provider failure. Configure alerts for:

- two consecutive readiness failures;
- TLS expiry below 21 days;
- disk use at or above 85%;
- backup older than 8 hours or without off-site verification;
- database/container unhealthy or restart loop;
- demo reset/reconciliation timer inactive, reset failure, quarantined slot, or repeated pool exhaustion;
- auth email worker stopped, repeated delivery failures, and password-recovery abuse rate;
- sustained 5xx responses and abnormal latency;
- audit-chain verification failure.

Readiness, TLS, disk, backup, container, revision, app-gate, demo-timer, quarantine, stranded-reset, and minimum-capacity checks are implemented by the host script. Repeated claim exhaustion still requires centralized service-log telemetry. Provider delivery telemetry, centralized log alerting, audit-chain scheduling, and off-host uptime paging require the selected monitoring vendor. Demo maintenance notifications must be tested before writable demo traffic; identity-provider notifications must be tested before real account login or business writes.

## Incident triage

1. Acknowledge the page and record UTC time, hostname, release SHA, and failing check.
2. Inspect `systemctl status` for monitor, backup, and both demo-maintenance timers, then run `docker compose --profile edge --profile auth-email ps`.
3. Read bounded logs with `docker compose logs --since 30m <service>`; never paste secret files or full identity/accounting records into a ticket.
4. If readiness fails but liveness passes, check database health and secret mounts before restarting the app. Do not rotate or replace encryption keys as a troubleshooting step.
5. If backup freshness/checksum fails, preserve the newest artifacts, repair the destination or credentials, rerun a backup, and verify off-site checksum. Do not prune the only recoverable set.
6. Escalate suspected data exposure, unauthorized posting, audit mismatch, or key loss through the security incident process in `SECURITY.md`.

After resolution, attach monitor output, the relevant backup/restore report, and corrective action to the incident record.
