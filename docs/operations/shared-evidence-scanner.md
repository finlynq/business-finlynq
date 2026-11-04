# Shared private scanner — BUSINESS-FINLYNQ-81

Status: shared owner commissioned; Business dev/stage and all three local Consult
environments accepted. Production cutover, wider owner recovery, alert receipt,
reboot acceptance and ticket closure remain separate gates. Scope is this server's
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
return as an application no-op. The completed dev/stage acceptance, redeploy, outage and rollback evidence is
recorded below; production and Consult remain separate gates.

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

## Business non-production acceptance, 2026-10-28

The operator-approved dev/stage phase completed through normal deployment and
root finalization. Both paused deployment timers were restored and verified active
afterward. The shared-owner minute monitor passed again after restart.

| Environment | Accepted revision | Evidence |
| --- | --- | --- |
| Development | `58ba11fbf73c2a57d1844e8dff24b65dfb743b0f` | Required CI 40760400769, normal release, exact root finalizer, public upload checks |
| Staging | `2ea825b6e774e6730133d2bd397b387cc6b641fd` | PR 246, required CI 40763341689, normal release accepted 20:58:05 UTC, exact root finalizer, public upload checks |

Every deployment/rehearsal passed 25 browser checks, with one pre-existing check
requiring a separately authorized reviewer skipped. Public synthetic demos in
both environments accepted clean PDF evidence (201 with scan version/time/hash),
reused the same asset on replay (200), refused the verified EICAR carrier and
encrypted PDF (409/no asset), and retained the 2 MiB upload limit (400/no asset).

Development also returned to its retained environment-local ClamAV scanner via
the protected installer and normal release path. The exact-revision finalizer and
public clean/replay/rejection checks passed at 20:37 UTC. Returning to shared mode
passed the same gates again at 20:47 UTC. Old signature volumes were retained;
application/accounting storage was not altered by the scanner configuration change.

Ordinary app deployments and this rollback/rejoin preserved owner ID
`75b7c2c16b4b27d6088f577c11b8a51c68e01a0b3e47d07b6e1bf46827c44ccd` and
gateway ID `49e6a4edf1e9c889d0365ed91c8aee4c0bb72acc3e1cff6b297b64d5e1c1b9c8`.
The separately approved explicit owner restart then intentionally recreated them.
At 20:59:44 UTC both public APIs had refused uploads during observed unavailability
(409/no asset), accepted the same requests after recovery (201), and reused the
assets on replay (200). Both root finalizers subsequently passed against the new
owner `c8090a644c1f027a8aff4f87fbef355d9542debdd71228a1619662dd2a3e9e1f` and
gateway `34cbc5b0093d06571cc5def677c84b1ed0ca837bd5d07b94b44ea468ffb586cc`,
with fresh loaded database 28167. Existing forwarder IDs remained unchanged by
that owner restart. Synthetic review evidence follows normal demo retention.

The 21:01 UTC idle snapshot was 948.9 MiB shared daemon, 15.84 MiB gateway,
16.39 MiB dev forwarder, 21.95 MiB stage forwarder and 904.4 MiB production's
retained local daemon: 1,907.48 MiB total. Compared with the earlier three local
daemons' 2,768.6 MiB snapshot, this phase reduced observed scanner working memory
by 861.12 MiB (about 0.84 GiB). These are comparable snapshots, not a peak budget
guarantee. Two persistent ClamAV daemons remain deliberately: shared and production
local. The final one-daemon count and full memory saving remain unproven.

Remaining operational gates: separately approved local Consult and Business
production cutovers, every Consult public ingestion/redeploy/recovery path, operator
alert activation and actual receipt, an approved host reboot, and final one-daemon
idle/load measurements. Remote Consult production remains excluded.


## Consult development acceptance, 2026-10-28 (Toronto)

The separately approved Consult development switch completed at 2026-10-29
00:57:44 UTC on tested source c12dfe64 after private backup/restore rehearsal and
28 migrations. Sixteen public upload/browser checks passed, including malware,
encrypted/oversize and unauthorized rejection, scanned email attachments and
work-item retention. Busy-slot refusal/retry and an ordinary independent redeploy
passed. Owner c8090a644c1f and gateway 34cbc5b0093d remained unchanged; both Business
app identities remained unchanged and healthy. The redeployed Consult app retained
its scanner configuration automatically and previously accepted evidence read back
with matching hashes and scan metadata.

The actual public Consult workspace import also accepted a 2,097,177,770-byte
fictive archive using 251 chunks of at most 8 MiB. Seven expected artifacts and the
bounded archive scan receipt were retained. EICAR and expanded-member-limit inputs
were refused without imports, and upload staging files were removed. Sampled peaks
were 585.7 MiB Consult app, 1,011 MiB shared scanner and 39.83 MiB gateway. This is
actual application-path evidence; the earlier concurrent reserved-slot load remains
the separate contention proof. Details and harness corrections are recorded in
Consult PR 1's SCANNING.md. No remote Consult production changes occurred.

Both Business public scanner probes passed again at 01:07 UTC: clean/replay,
EICAR/encrypted refusal and the unchanged size limit. Both deployment timers and
the scanner minute monitor are active. However, same-revision scheduled browser
rechecks before the Consult switch reported two settlement/logout timeouts
(23 passed, one existing reviewer skip). Those failures are unresolved; neither
the earlier accepted releases nor these focused scanner probes waive them.
Investigate before a subsequent promotion relying on the full browser gate.

Consult dev2/stage and Business production remain pending separate rollout
approval. Dev2 has no pending migrations; staging needs 56 and its own private
backup/upgrade rehearsal. The current host still intentionally has the shared
daemon and production's local daemon. Actual Consult owner-outage checks, operator
alert activation/receipt, approved reboot and final one-daemon measurements remain
open. No external notification was sent.

### Browser workflow budget correction

Follow-up diagnostics reproduced both long workflows completing all unchanged
assertions in 32.130 and 30.132 seconds, beyond the global 30-second test budget.
Only the SHAREHOLDER_ADVANCE lifecycle and payment-filter lifecycle now receive
60 seconds for their complete sequence. Per-step expectations, upload deadlines,
security checks, other tests and the global budget remain unchanged.

Using the edited test source against public development, with no command-line
budget override, both passed (38.436 and 37.638 seconds). Targeted ESLint and the
full TypeScript check passed. The host lacks npx, so those checks used the installed
Node entry points directly. Metadata-only diagnostic reports are retained with
this task's temporary evidence. This source correction still needs normal PR/CI
promotion and the full release suite; it does not retroactively pass the earlier
failed scheduled runs. Consult source and the reviewed next rollout are unchanged.

## Consult completion and rehearsal isolation follow-up, 2026-10-29 UTC

Consult development 2 and staging completed their separately approved rollouts at
`fef7038b4f8c9fe014b8f24711f4f5d2fab41d8a`. Staging's guarded transaction deleted
exactly 1,830 approved orphan records, then a fresh clean backup/restore and all
56 pending migrations passed. The original forensic backup and clean post-repair
backup remain private and retained. No runtime role was newly enabled.

Both environments passed public file/email/work-item ingestion, access and
malware/limit refusals, bounded workspace imports and rejected-upload cleanup,
capacity refusal/retry, independent redeployment and retained-file integrity.
The exact normal development 2 image passed all 51 release gates. Its initial
image-identity mismatch and reviewed packaging differences remain in the evidence;
no failed attempt was relabeled. Consult PR 1 at `b3fea6cd` records the full details.
A subsequent independent development 2 release at `df28efe8` preserved the scanner
integration and passed its normal root verifier and public retained-file readback.

Business development revision `ff0eb853` passed its normal deployment: 25 browser
checks passed with one existing reviewer-dependent skip. Its independent root
finalizer returned the exact revision and attested the shared owner and forwarder.
Staging promotion PR 248 passed CI and its normal deployment at 04:03 UTC:
25 browser checks passed with the same existing skip. The independent root finalizer
returned exact revision `e10d9de5` and attested the unchanged owner and forwarder.
Production promotion PR 249 remains a draft and does not authorize cutover.

Final preparation found that the release and initial-install rehearsal validators
still required the shared scanner channel name to have the rehearsal's own prefix.
The corrected boundary permits only the pinned forwarder's read-only staging
socket; every writable volume and every network must remain owned by that isolated
run. Other external resources, production/development channels, writable socket
mounts, mutable forwarder images and access from another service are refused.
Actual local/shared Compose regression checks reproduce the original rejection and
verify the corrected boundary. They do not replace full release-rehearsal evidence.

The wider owner restart has not occurred: automatic approval review required a new
explicit maintenance approval now that all three Consult consumers are live.
Business production remains on its local scanner. Operator notification activation
and receipt, an approved reboot and final one-daemon memory measurements remain
pending. The existing notification script has no local deduplication; confirm the
receiving route's repeat/escalation policy before activating scanner alerts.
