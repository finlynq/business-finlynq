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

The five-minute root service waits at least 60 seconds after a manifest appears and then atomically renames each member of the triplet into `/processing`, outside uploader reach. It accepts only strict `business_finlynq_<UTC>_<database>` names and validates:

- exactly three regular, single-link files owned by the upload account;
- the age v1 header and bounded checksum/manifest files;
- the exact JSON schema, product, database, formats, archive name, byte count, SHA-256, and full application revision;
- a valid UTC completion timestamp from the filename's backup-start time through a bounded 24-hour compatibility window;
- the independent checksum line; and
- membership of the application revision in the root-managed allowlist.

Valid sets move to `/vault/YYYY/MM/DD/<prefix>` and become root-owned mode `0400` beneath mode `0700` directories. Invalid or incomplete manifest-marked sets move to root-only quarantine with a non-sensitive reason. Stale interrupted processing claims are also quarantined. Valid and quarantined sets are retained for 60 days and then removed only from their fixed roots. The separate 10 GiB image bounds receiver-side storage exhaustion without affecting another mount.

## Verification and retrieval

Check provisioning and status:

```bash
sudo /usr/local/libexec/business-finlynq-backup-receiver/verify-receiver.sh
sudo /usr/local/libexec/business-finlynq-backup-receiver/verify-receiver.sh --require-backup --max-age-hours 8
systemctl status business-finlynq-backup-receiver.timer
journalctl -u business-finlynq-backup-receiver.service --since today
```

The verifier checks the exact image, backing loop device, mount flags, chroot permissions, no-shell/no-supplementary-group account, key restrictions, effective `sshd` policy, systemd timer, queue/quarantine counts, filesystem utilization, and latest accepted backup age.

Only a receiver administrator can retrieve a vaulted encrypted triplet. Copy all three files to an isolated recovery host and use the normal Business Finlynq restore drill. The age identity and application recovery material must come from separate escrow. Never enable SFTP access to the vault and never restore or decrypt on this receiver.

For repository-only validation, run:

```bash
bash deploy/backup-receiver/test-static.sh
```
