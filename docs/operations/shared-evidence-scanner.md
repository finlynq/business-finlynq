# Shared private scanner — BUSINESS-FINLYNQ-81

Status: shared owner commissioned; Business dev/stage migration in progress. Reboot acceptance,
operator approval and ticket closure are separate gates. Scope is this server's
Business production/stage/dev and Consult dev/dev2/stage. Remote Consult production
is excluded. No Caddy route, public port, VPN or application credential is needed.

## Owner and access

`deploy/evidence/shared/compose.yml` owns one ClamAV daemon and one small protocol
gateway. Install a clean reviewed revision with `sudo bash
deploy/evidence/shared/install.sh`. Installation copies protected files to
`/opt/finlynq-shared-scanner` and installs disabled systemd units; it starts nothing.
After operational approval, start/enable `finlynq-shared-scanner.service` and
`finlynq-shared-scanner-monitor.timer`. Inspect the service journal on failure.

The scanner retains the reviewed ClamAV digest, UID/GID 100:101, 3 GiB memory
ceiling, read-only root, no capabilities, bounded 128 MiB temporary storage,
signature freshness check and original content limits. It has a Unix socket and
its own signature-update network, with no TCP listener. Only this daemon's
FreshClam updates its independent signature volume, initially and 12 times/day.
No old signature directory is shared writable. `ConcurrentDatabaseReload no`
retains the original reload-memory behavior.

The pinned Node gateway has no network access, 128 MiB memory, 0.5 CPU and 32 PIDs.
It mounts the upstream socket read-only and exposes six sockets in six separate
named volumes. Directories are UID/GID 10001:10001 mode 0700, sockets mode 0600.
Consult staging alone uses directory 0710/socket 0660 so its legacy UID 1001 can
use supplemental group 10001 without changing application data ownership.
Each consumer receives only its own volume read-only. Gateway commands are limited
to VERSION and INSTREAM, 64 KiB frames, 21 MiB streams, 2 KiB replies and 45 seconds.
Path scans, shutdown, malformed/truncated input and excess capacity are refused.

Business retains `evidence_scanner:3310` on each environment's existing private
evidence network. In shared mode this is a 64 MiB, 0.25 CPU, 32-PID forwarder with
only that environment's socket volume; it has no signatures, credentials, storage
or other network. Sixteen connections and 45-second lifetimes bound forwarding.
The unchanged endpoint also supports older application images during rollback.

Consult uses the Unix socket directly as UID 10001, or legacy staging UID 1001
with the dedicated supplemental group. Its coordinated
source and policy are documented in that repository's
`deploy/server04/SCANNING.md`. Large workspace ZIPs use bounded member/metadata
scans while retaining the 2 GiB package ceiling; ordinary/email files fit 21 MiB.
Business upload limits and 15/45-second client deadlines remain unchanged.

## Capacity and failure behavior

Two gateway slots are reserved for Business production; all other channels share
one slot. There is no waiting queue. ClamAV has three threads and six queue entries.
A non-production upload cannot take a production slot, including while a large
Consult import submits successive members. Busy callers receive an unavailable
scan, never a clean result. Business durable email retry handles retryable failures;
interactive uploads must be submitted again. Consult staging cleanup remains owned
by its upload lifecycle.

CPU, signature reloads, temporary storage and the daemon remain shared resources.
Slot reservation is not a hard real-time guarantee. Complex archives may exhaust
their bounded scan/expansion budget and must fail closed. Preserve those limits;
do not raise them to make a fixture pass. Capture latency, memory and refusals
under representative peak archive/PDF workloads before production migration.

The monitor verifies running image IDs, configuration hashes and commands,
capabilities, mounts, socket ownership, networks, resources, health and loaded
signature freshness every minute. It reports failures as a failed systemd service
and in journald. The opt-in `operator-alerts.conf` drop-in connects failures to
the existing Business operator notification route; install it only after that
route and test delivery are explicitly approved. The base installation does not
send external notifications.
Application clients also refuse unavailable, stale, future-dated, malformed or
incomplete verdicts. An owner outage stops new accepted files in every consumer.

## Staged migration

1. Record current scanner/container IDs, image/configuration hashes, healthy scan
   results and comparable RAM/latency. Coordinate active deployments and use the
   existing global deployment lock. Do not alter running deployments to skip gates.
2. Provision and attest the independent owner while existing scanners remain live.
   `sudo /opt/finlynq-shared-scanner/manage.sh verify` must pass. Its fixed subnet
   `10.240.12.0/28` must be free on this host. No application is switched by install.
3. Through each environment's protected-configuration review, set
   `BUSINESS_FINLYNQ_SCANNER_MODE=shared` for development, then staging. Reinstall
   changed root-owned deployers/finalizers through their normal installers with
   `--scanner-mode shared` (respectively `deploy/dev/install-dev.sh` and
   `deploy/development/install-development.sh`). The installers take the deployment
   lock, attest the healthy shared owner, and atomically change only the requested
   scanner setting. Omit `--enable` while timers are deliberately paused. The normal
   deployer then reconciles the changed configuration. Use `--scanner-mode local`
   through the same installers for the reviewed rollback; do not edit protected
   configuration behind the deployer's back.
4. Each normal deployment verifies the owner before migration, starts only its
   private forwarder, verifies that forwarder, then starts the app. Run real clean,
   EICAR, outage/retry, restart and redeploy acceptance. Shared rehearsals use the
   staging channel. Explicitly select shared mode in protected rehearsal environments
   too; default local mode exists for isolated CI and rollback, not steady state.
5. Migrate local Consult through its own reviewed release sequence. Its managed
   deployment needs `CONSULT_EVIDENCE_SCANNER_MODE=shared`. The older manually
   created dev/stage containers must first receive reviewed deployment definitions
   and UID/storage compatibility checks; do not copy the dev2 container configuration
   or change storage ownership blindly. Verify each actual upload/API boundary.
6. Only after isolation, peak load and non-production acceptance, approve Business
   production's protected configuration change. Release mode drains writes before
   starting the production forwarder; full attestation and clean/EICAR probes precede
   application acceptance. Initial, resume, rollback and terminal-recovery paths
   verify the same owner and forwarder contract.
7. Retain old signature volumes/configuration for at least seven days and until
   rollback has passed. Do not delete evidence, backups or application data. Verify
   exactly one persistent ClamAV daemon, ordinary redeploy independence, signature
   update, owner restart and an approved host reboot before closing the ticket.

## Restart, upgrades and rollback

Use `sudo /opt/finlynq-shared-scanner/manage.sh restart` only in an approved shared
maintenance window. It takes the Business deployment lock and recreates the two
owner containers from protected definitions, preserves signatures and all socket
volumes, waits for health and requires full attestation. Drain Consult uploads as
well. Existing application processes recover on their next connection. Docker
restart policies restore containers after reboot; the owner unit reconciles and
attests them. Applications continue to require successful scans during recovery.

Ordinary application Compose commands cannot stop/recreate the owner or delete
its external volumes. Never run a broad Docker cleanup. For a reviewed owner
upgrade, drain all consumers, take the deployment lock, save the prior protected
source and revision, stop/remove only the two owner containers, install the new
reviewed files and recreate through the same fixed Compose project/volumes. Require
full attestation and clean/EICAR probes before restoring uploads. Restore the saved
files and recreate again if acceptance fails. Never downgrade signature formats
blindly or run two updaters against the same directory.

Business can return to environment-local scanning: review protected mode `local`,
restore the original local scanner using its retained signature volume, require
fresh healthy scan probes, then accept the app through the normal release path.
The endpoint remains unchanged and no evidence/accounting data is modified.
Keep the shared owner serving other consumers throughout that rollback.

Consult has no pre-existing local scanner to restore. Its rollback retains the
scan-gated client and restores the last verified shared-owner version/channel;
uploads remain unavailable until it passes. Do not deploy the former unscanned
ingestion path as an availability workaround. Any separate environment-local
Consult scanner requires its own reviewed private socket and runtime attestation.

## Isolated validation recorded 2026-10-28

Disposable namespace `codex-bf81-scanner` uses independent signature/channel volumes,
an independent network and synthetic fixtures. Public signature files were copied
read-only into the test volume; only its updater writes that copy. Production
application configuration and scanners were not switched.

- Actual owner and Business forwarder attestation passed with ClamAV 1.5.4 and
  database 28167, dated 2026-10-28 06:24:17 UTC.
- Six channels accepted clean data and rejected EICAR; 21 MiB passed, 21 MiB plus
  one byte failed. Unit transport checks cover command restrictions, incomplete
  replies, admission separation and deadlines.
- The actual Business client passed clean/EICAR/metadata checks through the private
  forwarder and refused an engine outage. Restart restored full attestation.
  Runtime checks rejected CPU drift, permissive socket modes and an unrelated
  container added to the signature network; that container had no client socket.
- Baseline existing scanners: 924.9 + 941.6 + 921.0 MiB. Isolated owner idle:
  964.8 MiB daemon + 39.89 MiB gateway, before per-environment forwarder overhead.
  These are comparable snapshots, not a measured post-cutover saving.
- Two production workers completed 64 2-MiB scans while the non-production slot
  processed sixteen 21-MiB streams: maximum 492 ms, p95 175 ms. Sampled peaks were
  976.8 MiB daemon and 62.4 MiB gateway; no resource cap was lowered.
- The real Consult client scanned a 36-MiB, three-member synthetic ZIP in 5.63 s
  cold and about 0.5 s warm. Concurrent production scans: maximum 100 ms, p95 86 ms.
- A 294-KiB ZIP expanding to 72 MiB scanned in 2.29 s while concurrent production
  scans stayed below 429 ms. Sampled daemon peak was 1003 MiB at 198% CPU; gateway
  peak was 51.57 MiB. The original 128 MiB scanner tmpfs and all content limits
  remained unchanged.

Keep live application/API, worst-case archive load, alert receipt, update/reboot,
rollback and final RAM evidence distinct from these isolated tests. The required
Development Manager test cases stay pending until their complete criteria pass.
CI's existing local scanner exception remains disposable and is always cleaned up.

## Operational checkpoint, 2026-10-28

The operator separately approved shared-owner installation and Business dev/stage
integration. Production scanner cutover and live Consult deployment remain pending.
The root-owned service and its minute monitor are enabled; fresh signatures were
initialized independently and full attestation plus all six clean/EICAR/stream-limit
channel probes passed. Business production continues using its local scanner.

Before switching consumers, both public non-production upload APIs accepted clean
PDF evidence with scanner version/time, reused the original asset on replay, and
refused a verified EICAR carrier, encrypted PDF and the existing 2 MiB limit. The
EICAR carrier contains the standard harmless test file in a small ZIP with a PDF
prefix, so it reaches scanning through the existing file-signature gate; simply
appending the string to an arbitrary PDF is not a reliable test of this engine.
Fixtures and accepted assets were confined to the synthetic public demos.

The first dev transition stopped during preflight while the previous runtime stayed
healthy. The deployer had depended on a helper absent from pre-scanner checkouts.
The follow-up recognizes the exact historical Git tree, uses its existing local
scanner only for predecessor inspection/recovery, and refuses missing/substituted
helpers in scanner-aware revisions. Recovery starts and verifies the selected
scanner before its app. Namespace checks accept only the environment's exact
external read-only channel; other projects and writable/substituted mounts fail.
The acceptance predicate also compares the running scanner image/user/health
with the rendered mode, so a same-revision cutover or rollback cannot silently
return as an application no-op. Actual dev/stage acceptance, redeploy, outage
and rollback remain gates.

## Operator alert activation (separate approval)

Before production cutover, verify the existing
`business-finlynq-monitor-notify@.service` is loaded and its protected webhook
configuration is present. Reuse that route; do not introduce recipients or put
webhook values into source, command arguments, logs or ticket evidence. The
notification unit's success without a configured webhook is not delivery proof.

After explicit approval to activate that route and perform the notification
drill, install `deploy/evidence/shared/operator-alerts.conf` as root-owned mode
0644 at both of these paths, preserving any unrelated drop-ins:

- `/etc/systemd/system/finlynq-shared-scanner.service.d/10-operator-alerts.conf`
- `/etc/systemd/system/finlynq-shared-scanner-monitor.service.d/10-operator-alerts.conf`

Create the directories root-owned 0755, refuse symlinked paths or conflicting
existing files, and reload systemd. No application or owner restart is needed.
Verify both units' effective `OnFailure` points to the existing notification
template with their own service names. The monitor checks every minute; repeated
failures follow the existing route's delivery policy, so confirm its deduplication
or escalation behavior with its owner before activation.

Exercise the route with a separately named synthetic failed service whose
`OnFailure` uses the same template; do not corrupt scanner configuration or halt
production uploads merely to raise an alert. Record the UTC trigger and actual
operator receipt through the existing channels, then remove only that temporary
drill unit. A journal entry or successful webhook request alone is not proof that
the required operators received it. Restore normal monitoring and verify fresh
loaded signatures after the drill. Alert activation and receipt remain pending.
