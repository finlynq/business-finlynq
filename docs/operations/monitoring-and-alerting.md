# Monitoring and alerting runbook

Business Finlynq exposes two deliberately different probes:

- `/api/live` confirms that the Node process can answer HTTP. It does not touch secrets or PostgreSQL and is used by the container health check that gates Caddy startup.
- `/api/health` is readiness. Its public response is only `{"status":"ready"}` or `{"status":"unavailable"}`, with HTTP `200` or `503`. It returns `503` unless PostgreSQL, the organization root wrapping key, and the independent identity secret are available and valid. When real accounts are enabled it also requires valid non-secret delivery metadata and a fresh database heartbeat from the authentication email worker, with no expired lease or seriously delayed due item.

Both endpoints are non-cacheable and excluded from indexing. Detailed readiness component state and the configured release revision are available only on the loopback/private-network application listener when the probe supplies `X-Business-Finlynq-Internal-Health: 1`. Both reviewed Caddy configurations remove that header from every proxied request, so a public client cannot request the detailed representation by spoofing it or any forwarding header. The marker is not a secret: the security boundary is the non-public app listener plus unconditional edge removal. Never expose container port `3000` or loopback port `3100` beyond the host.

## Correlation and structured logs

Caddy removes every client-supplied `X-Request-Id`, generates a UUID at the public edge, passes it to the application, returns it on the response, and writes JSON access logs. The application validates that value and generates a UUID only for a direct loopback or test request. Every API handler writes a bounded JSON `route.access` event containing only the allowlisted operation, request ID, method, status, and duration. Contained failures additionally write a `route.failure` event containing only operation, request ID, and a bounded error class; exception messages, stacks, request bodies, identities, tenant identifiers, and accounting content are prohibited.

Mutation transactions set the same request context used by both `audit_events.request_id` and `outbox_events.request_id`. A database trigger rejects new outbox rows without that context and makes the value immutable. The accounting-evidence verifier checks durable request → audit → outbox lineage. Search centralized logs by the opaque request UUID, then use restricted database evidence tooling; never add customer, identity, currency, amount, or document text as log or metric labels.

## Internal metrics

`/api/metrics` returns Prometheus text only on the loopback/private-network application listener with `X-Business-Finlynq-Internal-Metrics: 1`. Caddy unconditionally strips that marker, and a public request receives a minimal `404`. The aggregate-only database function and the handler expose API request/error/latency, authentication failures, outbox count/age/lineage, email queue/delivery/heartbeat, and demo pool/reset signals. Metric labels are prohibited except the fixed Prometheus histogram boundary.

The five-minute host monitor atomically replaces `MONITOR_METRICS_FILE` (default `/var/lib/business-finlynq/host.prom`) with its outcome, isolated backup-verification result, and the allowlisted `encrypted_backup` and `demo_reconciliation` timer/job results. A separate four-hour accounting-evidence job performs the deliberately full-history audit/outbox verification under both an advisory lock and hard query/process timeouts, then atomically writes aggregate success, duration, last-run, and last-success gauges to `/var/lib/business-finlynq/accounting-evidence.prom`. The systemd units create `/var/lib/business-finlynq`; for the cron fallback, create the configured textfile directory in advance and grant the `deploy` user write access. Configure node_exporter's textfile collector, or an equivalent host agent, to read both files and scrape the application endpoint over loopback. Do not proxy any telemetry surface to the public network.

The independent backup receiver has its own five-minute health timer, failure webhook, and aggregate textfile at `/var/lib/business-finlynq-backup-receiver-metrics/receiver.prom`. It fails if receiver verification fails, a completed set is quarantined, or the newest signed accepted receipt reaches six hours. Scrape and route this signal from the receiver itself; the application host must not treat a local `.uploaded` marker as receiver acceptance.

Load `deploy/monitoring/prometheus-alerts.yml` into the production Prometheus-compatible rule engine and route its `critical`, `high`, and `moderate` severities according to [the incident response and severity policy](incident-response.md). Systemd backup, demo reconciliation, and monitor failures also route immediately through `business-finlynq-monitor-notify@.service`; Prometheus is the independent stale/threshold path. Set `MONITOR_EXPECT_OUTBOX_PUBLISHER=true` only when the publisher is deployed so the 15-minute outbox-lag alert activates; lineage violations alert regardless of that gate. A synthetic failed check and alert delivery to both required operators must be recorded before pilot traffic.

### Synthetic failure and correlation acceptance

Run the drill only with a controlled organization session and a harmless, unique mutation known to emit both audit and outbox evidence. Store the JSON body and curl-compatible cookie jar in mode-`0600` files; the runner never prints either file or the response. Configure absolute, fresh receipt/evidence paths and the host textfile path, then run:

```bash
export OBSERVABILITY_DRILL_MUTATION_URL=https://business.finlynq.com/api/<controlled-paired-mutation>
export OBSERVABILITY_DRILL_MUTATION_METHOD=POST
export OBSERVABILITY_DRILL_MUTATION_BODY_FILE=/run/business-finlynq-drill/body.json
export OBSERVABILITY_DRILL_COOKIE_FILE=/run/business-finlynq-drill/cookies.txt
export OBSERVABILITY_DRILL_METRICS_FILE=/var/lib/business-finlynq/observability-drill.prom
export OBSERVABILITY_DRILL_ALERTMANAGER_URL=http://127.0.0.1:9093
export OBSERVABILITY_DRILL_RECEIPT_FILE=/var/lib/business-finlynq/drills/alert-receipt.txt
export OBSERVABILITY_DRILL_EVIDENCE_FILE=/var/lib/business-finlynq/drills/observability-evidence.json
bash deploy/monitoring/run-observability-drill.sh
```

The runner executes `promtool check rules` and the committed rule unit tests, sends the controlled mutation through public Caddy, validates its edge-generated UUID in both audit and outbox using aggregate counts only, runs the complete accounting-evidence verifier, raises `BusinessFinlynqSyntheticFailure`, and waits for Alertmanager. After both required operators actually receive the routed notification, write the single word `delivered` to the fresh receipt file. The runner then writes mode-`0600` JSON evidence and atomically clears the synthetic signal even on failure. The alert metric has no request-ID or tenant label; only the restricted evidence file contains the opaque request UUID.

This procedure does not install a scraper, rule engine, Alertmanager, notification receiver, or external uptime probe. Those production integrations and the first signed drill output remain release-evidence blockers until independently configured and witnessed.

## Host monitor

`deploy/monitoring/check-production.sh` is a five-minute synthetic/host check. It validates:

- public HTTPS liveness and minimal readiness, the absence of public readiness details, and required no-store/HSTS headers;
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
install -m 0644 deploy/systemd/business-finlynq-accounting-evidence.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-accounting-evidence.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now business-finlynq-monitor.timer business-finlynq-accounting-evidence.timer
systemctl start business-finlynq-monitor.service
systemctl start business-finlynq-accounting-evidence.service
```

The unit files invoke the scripts from `/home/deploy/business-finlynq`; the optional `/usr/local/sbin` copies above are useful for administrators but are not used unless the unit is customized. Release resume installs all four committed service/timer pairs—backup, monitor, accounting evidence, and demo reconciliation—performs `systemctl daemon-reload`, and records `verify-backup-schedule.sh` output before starting any timer. The verifier byte-compares all eight installed units and checks every loaded fragment path, timer target, calendar/cadence, jitter, persistence, `ExecCondition`, `ExecStart`, working directory, mandatory environment file, and timeout. The recurring production monitor emits `business_finlynq_backup_schedule_contract` and repeats this full check. Every service also requires the common scheduler-boundary condition, which rejects the wrong scheduler mode, a release-maintenance marker, a mismatched checkout revision, or a dirty checkout. If the checkout moves, update the condition, `WorkingDirectory`, and `ExecStart` together before reloading the units so neither execution nor `OnFailure` points at a stale release.

Configure the mandatory `/etc/business-finlynq/operations.env` with thresholds and every explicit expected gate from `.env.example`. Backup runtime is capped at 5,400 seconds and its active-job threshold at 4,800 seconds; larger values fail closed. The backup, monitor, accounting-evidence, and nightly demo-maintenance services refuse to start without the operations file; only the failure notifier treats it as optional so it can still report a missing file. For webhook delivery, put one HTTPS URL in `/etc/business-finlynq/secrets/monitor-webhook-url`, mode `0400`. The notification contains only the failed unit and host name. If no webhook exists, the failure remains in journald, which is safe but is **not** an external alert.

If root-managed systemd timers are temporarily unavailable, the reviewed fallback is the `deploy` user's UTC crontab. Copy the same operations settings to `/home/deploy/.config/business-finlynq/operations.env`, set `MONITOR_MAINTENANCE_SCHEDULER=cron`, make the file owned by `deploy` with mode `0600`, then run `bash deploy/cron/install.sh` as `deploy`. The idempotent installer replaces only its marked block and preserves unrelated entries, including removing the retired five-minute reset and hourly due-check. The allowlisted schedule invokes reconciliation at 08:15 and 09:15 UTC; the wrapper verifies exact `04:15` `America/Toronto` time so one invocation resets across EST/EDT and the other exits. A success-only local-date stamp prevents duplicates. Backup and accounting-evidence verification run every four hours, while monitoring runs every five minutes. Each wrapper checks the shared release-maintenance marker and scheduler lock, starts its child from `env -i`, sources only the mode-`0600` canonical operations file, rejects Docker/Compose routing selectors, and refuses a dirty or revision-mismatched checkout. Atomic mode-`0600` records under `/home/deploy/.local/state/business-finlynq/cron/job-status/` retain the latest real backup and reconciliation result/time; the host monitor exports those records through the same scheduler-neutral metrics used for systemd, so a healthy cron fallback does not page forever with timestamp zero. The monitor requires the exact four-job block and also proves all four unselected systemd timers are disabled/inactive; in systemd mode it strictly reads the deploy crontab and requires the managed block absent. Before a release, `bash deploy/cron/remove.sh` drains active wrappers under an exclusive scheduler lock and removes only the marked block; rerun the installer after acceptance. Prefer the DST-aware systemd timers once root operator access is available.

Set `MONITOR_EXPECT_REVISION` to the same full reviewed Git SHA as `BUSINESS_FINLYNQ_IMAGE_REVISION` during each release. Both are mandatory, must match exactly, and are checked against the running container and the loopback-only detailed readiness response.

Set `MONITOR_EXPECT_AUTH_EMAIL_WORKER=true` at the same cutover that enables real account email delivery. Before that cutover it stays false so the intentionally absent profile is not reported as an outage.

The production writable-demo boundary requires the reviewed login/write gates and `MONITOR_EXPECT_DEMO_MAINTENANCE=true`. The host monitor fails if the app differs, the selected scheduler is missing or altered, the pool is not exactly 128 slots, any slot is quarantined, a reset is stranded or overdue, or ready capacity falls below four outside an active maintenance pass. Set maintenance false only when demo login and writes are intentionally disabled, such as during rollback to an artifact that predates sandbox resets.

The database readiness contract intentionally reports delivery dead-letter count separately from worker availability: one permanently failed address must not disable every account login. Controlled cancellation, MFA invalidation, and supersession states also use the durable `DEAD` terminal state, so the delivery-failure metric and page exclude those reviewed error codes. Configure centralized worker-log/provider telemetry to page on actual delivery exhaustion, and retain a metric for oldest pending age. When the worker is expected, the host metric makes a missing first heartbeat alert just like a stale heartbeat. The public readiness endpoint catches a stopped worker, stuck lease, or materially delayed due queue without exposing counts or recipients.

Production requires an independent external uptime/alerting service that calls `https://business.finlynq.com/api/health` from outside the VPS and pages at least two operators. That minimal public response retains the full readiness status without revealing component posture or revision. A local timer cannot report a total VPS, network, or provider failure. Configure alerts for:

- two consecutive readiness failures;
- TLS expiry below 21 days;
- disk use at or above 85%;
- backup reaches 6 hours or lacks off-site verification;
- database/container unhealthy or restart loop;
- demo reset/reconciliation timer inactive, reset failure, quarantined slot, or repeated pool exhaustion;
- auth email worker stopped, repeated delivery failures, and password-recovery abuse rate;
- sustained 5xx responses and abnormal latency;
- audit-chain verification failure.

Readiness, TLS, disk, backup, container, revision, app-gate, demo-timer, quarantine, stranded-reset, minimum-capacity, backup-verification, and key-job checks are implemented by the five-minute host script. Audit-graph and audit/outbox-lineage integrity are implemented by the separate four-hour bounded verifier; its six-hour alert threshold safely covers the schedule, random delay, and execution timeout. Both systemd and reviewed-cron scheduler modes invoke that same verifier. Reviewed Prometheus thresholds are committed, but the production scraper/rule engine, Alertmanager-equivalent routing, centralized JSON log storage, provider delivery webhook, receiver textfile scrape, and off-host uptime probe remain external services that operators must configure and test. Production-scale `EXPLAIN (ANALYZE, BUFFERS)` evidence for the bounded hot metric queries and full verifier must be captured on representative cardinality before pilot traffic. The generalized business-outbox publisher is not built yet; its lag alert is deliberately gated while request/audit/outbox lineage remains enforced and monitored. Repeated claim exhaustion still requires centralized service-log telemetry. Demo maintenance notifications must be tested before writable demo traffic; identity-provider notifications must be tested before real account login or business writes.

## Incident triage

Use the full [incident response and severity policy](incident-response.md) for declaration, routing, containment, and the authentication, write-shutdown, migration, connector-credential, and accounting-discrepancy procedures.

1. Acknowledge the page and record UTC time, hostname, release SHA, and failing check.
2. Inspect `systemctl status` for the monitor, backup, accounting-evidence, and single nightly demo-reconciliation timers, then run `docker compose --profile edge --profile auth-email ps`.
3. Read bounded logs with `docker compose logs --since 30m <service>`; never paste secret files or full identity/accounting records into a ticket.
4. If readiness fails but liveness passes, check database health and secret mounts before restarting the app. Do not rotate or replace encryption keys as a troubleshooting step.
5. If backup freshness/checksum fails, preserve the newest artifacts, repair the destination or credentials, rerun a backup, and verify off-site checksum. Do not prune the only recoverable set.
6. Escalate suspected data exposure, unauthorized posting, audit mismatch, or key loss through the security incident process in `SECURITY.md`.

After resolution, attach monitor output, the relevant backup/restore report, and corrective action to the incident record.
