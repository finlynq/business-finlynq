# Business Finlynq off-server backup receiver

These assets provision a dedicated Ubuntu 24.04 host as an encrypted-backup receiver. The receiver never receives an age identity, organization root key, identity secret, database password, or plaintext database content. It accepts only SFTP uploads from one source network and moves completed sets into a root-only vault.

## Storage and account boundary

The provisioner creates one explicitly named sparse image:

`/var/lib/business-finlynq-backup-receiver/business-finlynq-backup-vault-10GiB.ext4.img`

It is exactly 10 GiB, formatted ext4 only when that exact path is newly created, labeled `bf_backup_vault`, and loop-mounted at `/srv/business-finlynq-backup` with `nodev,nosuid,noexec`. If that mount point already contains data, is another mount, or the existing image does not have the exact expected metadata, type, label, and size, provisioning stops. It never formats, unmounts, resizes, or reuses another device or mount.

The `finlynq-backup` system user has `/usr/sbin/nologin`, no supplementary or sudo group, no password authentication, no PTY, and no forwarding. OpenSSH forces `internal-sftp` into the root-owned chroot. Its key is root-owned outside the chroot and includes both a `from=` CIDR and a forced SFTP command. The uploader can write only `/incoming`; it cannot list or retrieve `/processing`, `/vault`, or `/quarantine`.

## Provisioning

On a trusted administrator workstation, make a dedicated SSH key for uploads. Keep the private key only on the Business Finlynq application server. Put the public key in a file on the receiver administrator account. Also create a file containing the exact deployed application revision, one full lowercase Git SHA per line. Keeping prior known-good revisions in the file allows retained sources to finish a backup during a controlled release transition.

From a protected checkout on the receiver:

```bash
printf '%s\n' 'da2d89d3e4f1a905c6317ae7c25af523ba21c3d1' > /root/business-finlynq-allowed-revisions.txt
sudo bash deploy/backup-receiver/provision-ubuntu-24.04.sh \
  --public-key-file /root/business-finlynq-backup.pub \
  --source-cidr 91.99.53.52/32 \
  --allowed-revisions-file /root/business-finlynq-allowed-revisions.txt
```

The public key is intentionally read from a file, never a command-line value. The script validates `sshd` syntax and the effective matched-user policy before reloading SSH. Keep the current administrator SSH session open and test a second session after provisioning. Configure the receiver firewall/provider security group to permit TCP 22 from the same source CIDR only; the provisioner does not alter firewall policy.

On its first signing-aware run, the provisioner also generates a dedicated Ed25519 receipt-attestation key at `/etc/business-finlynq/backup-receiver-receipt-signing-key.pem` (root-owned mode `0400`) and derives `/etc/business-finlynq/backup-receiver-receipt-signing-public-key.pem` (mode `0644`). The private key never leaves the receiver and is unrelated to SSH, age encryption, or organization encryption. If a configured signing key later disappears, provisioning fails instead of silently generating a new trust identity. Copy only the public key to the isolated recovery host over an independently authenticated administrator path, record the exact PEM SHA-256 printed by the provisioner in the change ticket, and configure recovery with:

```dotenv
BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_FILE=/etc/business-finlynq/recovery/backup-receiver-receipt-signing-public-key.pem
BACKUP_RECEIVER_RECEIPT_PUBLIC_KEY_SHA256=<exact-lowercase-64-character-sha256>
```

Changing either pin is a reviewed receiver-key rotation. Keep the prior public key and its operational record for as long as a receipt signed by it remains eligible for recovery; take and verify a new signed backup before retiring the old pin.

When deploying a new application revision, append its full SHA to a protected revision file and rerun the provisioner with the same three inputs. The image and filesystem are reused only after exact validation. Remove old revision entries only after no source at that revision can legitimately upload.

## Source rclone configuration

Configure a minimal SFTP remote on the application server using its dedicated private key and pinned receiver host key. Do not put the age identity or any Business Finlynq recovery key on the receiver. An illustrative rclone remote is:

```ini
[backup-receiver]
type = sftp
host = 89.167.36.176
user = finlynq-backup
port = 22
key_file = /run/secrets/business_finlynq_backup_receiver_ssh_private_key
known_hosts_file = /run/secrets/business_finlynq_backup_receiver_known_hosts
host_key_algorithms = ssh-ed25519
shell_type = none
```

The Compose backup service mounts the transport files only at the two `/run/secrets/...` paths shown above. On the application host, configure:

```dotenv
BACKUP_RECEIVER_SSH_PRIVATE_KEY_FILE=/etc/business-finlynq/secrets/backup-receiver-ssh-private-key
BACKUP_RECEIVER_KNOWN_HOSTS_FILE=/etc/business-finlynq/backup/receiver-known-hosts
```

Both host files must be regular, root/operator-managed files readable by the configured `BUSINESS_FINLYNQ_SECRET_GID`; use mode `0440` or stricter. Pin the key returned through an independently verified receiver console or provider panel—do not build `known_hosts` by blindly trusting an initial network connection. Constraining `host_key_algorithms` to the pinned ED25519 key prevents an SFTP client from negotiating a different valid server key and then correctly rejecting it as a mismatch.

Set the production backup environment to use the chroot-relative incoming directory:

```dotenv
BACKUP_RCLONE_REMOTE=backup-receiver:/incoming
BACKUP_REQUIRE_OFFSITE=true
```

The existing Business Finlynq backup uploader sends the encrypted archive and checksum first, verifies the remote encrypted stream, and uploads the manifest last. The receiver treats that manifest as the completed-set marker. Both key paths above are backup-container secrets, not host paths. Confirm the configuration from the same image and secret boundary used by scheduled backups:

```bash
docker compose --profile operations run --rm --no-deps --entrypoint rclone backup \
  --config /run/secrets/business_finlynq_rclone_config \
  lsd backup-receiver:/incoming
```

## Ingestion rules and retention

The five-minute root service waits at least 60 seconds after a manifest appears and then atomically renames each member of the uploaded triplet into `/processing`, outside uploader reach. It accepts only strict `business_finlynq_<UTC>_<database>` names and validates:

- exactly three regular, single-link files owned by the upload account;
- the age v1 header and bounded checksum/manifest files;
- the exact JSON schema, product, database, formats, archive name, byte count, SHA-256, source-application revision, and backup-tool revision (legacy manifests without the split remain accepted);
- a valid UTC completion timestamp from the filename's backup-start time through a bounded 24-hour compatibility window;
- the independent checksum line; and
- membership of both the source-application and backup-tool revisions in the root-managed allowlist.

After claiming an upload, the receiver copies every artifact with reflinks disabled into a newly created root-owned inode, unlinks the uploader-owned originals, and validates only the sealed copies. An SFTP process that held a writable descriptor before the rename can therefore change only its now-unlinked source inode, never a hashed or vaulted artifact. After validation, the receiver creates a root-owned schema-v2 `*.receiver-receipt.json` bound to the manifest name, encrypted archive SHA-256 and byte count, source application revision, backup-tool revision, receiver acceptance time, Ed25519 algorithm, and pinned public-key fingerprint. It signs the exact receipt bytes into `*.receiver-receipt.json.sig`, requires the 64-byte detached signature to verify immediately with the local matching public key, and only then publishes the claim. The claim directory is renamed atomically into `/vault/YYYY/MM/DD/<prefix>` so the triplet, receipt, and signature become visible together, with files mode `0400` beneath mode `0700` directories. Invalid or incomplete manifest-marked sets move to root-only quarantine with a non-sensitive reason. Stale interrupted processing claims are also quarantined. Valid and quarantined sets are retained for 60 days and then removed only from their fixed roots. The separate 10 GiB image bounds receiver-side storage exhaustion without affecting another mount.

## Verification and retrieval

An independent receiver-health timer runs every five minutes. It requires the signed recovery-point `createdAt` in the newest cryptographically verified receipt to be strictly younger than six hours; neither the verifier argument nor receiver configuration may weaken that ceiling. Receipt acceptance time and filesystem modification time never reset that recovery clock, so a delayed stale upload remains unhealthy. The verifier also rehashes the newest complete five-file vault set and rejects a missing archive/checksum, altered bytes, size mismatch, extra entry, unsafe ownership/link count, or broken receipt signature. Health atomically publishes aggregate-only metrics to `/var/lib/business-finlynq-backup-receiver-metrics/receiver.prom`. The compatibility metric named `business_finlynq_backup_receiver_latest_accepted_receipt_age_seconds` therefore carries signed recovery-point age, not receipt-delivery age. Scrape that file from the receiver with a local textfile collector; do not make it publicly reachable. Both ingestion and receiver-health failures invoke the local failure notifier. For an independent notification path, place exactly one HTTPS webhook URL in `/etc/business-finlynq/backup-receiver-alert-webhook-url`, owned by `root:root` with mode `0400`. The notifier requires exactly one metacharacter-free HTTPS line and feeds it to curl over protected standard input, never through process arguments. Without that file, the failure remains in journald but is not externally delivered.

Every new quarantine pages until an administrator has inspected the retained set and its journal, opened an incident/change record, and writes one immutable acknowledgment:

```bash
sudo /usr/local/libexec/business-finlynq-backup-receiver/acknowledge-quarantine.sh \
  20260831T120000Z_archive_hash_mismatch.ABC123 operator@example.com INC-1234
```

The command accepts only the exact direct-child quarantine name, requires a stable reviewer and ticket identifier, and creates a root-owned mode-`0400` `.acknowledged.json` inside that retained quarantine. A valid acknowledgment stops repeated paging but does not delete, move, or mark the set valid; total and acknowledged gauges preserve visibility until normal 60-day pruning removes the complete directory. Missing, malformed, future-dated, symbolic, or rewritten acknowledgment state fails health.

Check provisioning and status:

```bash
sudo /usr/local/libexec/business-finlynq-backup-receiver/verify-receiver.sh
sudo /usr/local/libexec/business-finlynq-backup-receiver/verify-receiver.sh --require-backup --max-age-hours 6
systemctl status business-finlynq-backup-receiver.timer
systemctl status business-finlynq-backup-receiver-health.timer
journalctl -u business-finlynq-backup-receiver.service --since today
journalctl -u business-finlynq-backup-receiver-health.service --since today
```

The verifier checks the exact image, backing loop device, mount flags, chroot permissions, no-shell/no-supplementary-group account, key restrictions, effective `sshd` policy, systemd timer, queue/quarantine counts, filesystem utilization, signing-key pair/fingerprint, every vaulted receipt's binding and detached signature through the fingerprint-selected trusted public-key ring, and the newest signed recovery point's age and complete-set checksum.

For a reviewed receipt-signing rotation, generate and activate the new receiver-only Ed25519 private key through a change window, derive its public key, and add the public PEM as `/etc/business-finlynq/backup-receiver-trusted-receipt-keys/<pem-sha256>.pem` owned by `root:root` mode `0644`. Update the active key paths/fingerprint together and run the verifier before accepting another upload. Keep each old public key in the trusted public-key ring for at least the full 60-day receipt retention plus any longer evidence hold; provisioning adds the active key but never deletes older pins. Remove an old pin only after proving no retained receipt names that fingerprint and recording that review. Losing an old public key while its receipt remains is an evidence-integrity incident, not a reason to skip verification.

Only a receiver administrator can retrieve a vaulted recovery set. Copy the encrypted archive, checksum, manifest, receiver-generated acceptance receipt, and matching `*.receiver-receipt.json.sig` to an isolated recovery host and use the normal Business Finlynq restore drill. Provision the independently transferred public key and its separately recorded fingerprint there; do not copy the receiver private key. A drill that claims production off-site evidence rejects a missing, unsigned, unpinned, or checksum/revision-mismatched receipt. Unsigned historical receipts can be inspected only with the explicit no-off-site diagnostic mode and can never satisfy G0 signoff. A local uploader marker is not a substitute for receiver acceptance. The age identity and application recovery material must come from separate escrow. Never enable SFTP access to the vault and never restore or decrypt on this receiver.

For repository-only validation, run:

```bash
bash deploy/backup-receiver/test-static.sh
```
