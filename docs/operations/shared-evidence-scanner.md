# Shared private scanner — BUSINESS-FINLYNQ-81

Status: implementation and isolated validation. Live migration, reboot acceptance,
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
Each consumer receives only its own volume read-only. Gateway commands are limited
to VERSION and INSTREAM, 64 KiB frames, 21 MiB streams, 2 KiB replies and 45 seconds.
Path scans, shutdown, malformed/truncated input and excess capacity are refused.

Business retains `evidence_scanner:3310` on each environment's existing private
evidence network. In shared mode this is a 64 MiB, 0.25 CPU, 32-PID forwarder with
only that environment's socket volume; it has no signatures, credentials, storage
or other network. Sixteen connections and 45-second lifetimes bound forwarding.
The unchanged endpoint also supports older application images during rollback.

Consult uses the Unix socket directly as its normal UID 10001. Its coordinated
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
and in journald; connect that service to the existing operator alerting mechanism
and exercise receipt before cutover. It sends no new external notifications itself.
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
   changed root-owned deployers/finalizers through their normal installers. Refresh
   protected configuration hashes using the existing release procedure; do not
   edit an attested configuration behind the deployer's back.
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

Keep live application/API, worst-case archive load, alert receipt, update/reboot,
rollback and final RAM evidence distinct from these isolated tests. The required
Development Manager test cases stay pending until their complete criteria pass.
CI's existing local scanner exception remains disposable and is always cleaned up.
