# Demo sandbox maintenance

Writable public demos use a bounded database-defined pool of synthetic sandbox organizations. A visitor never chooses a tenant or slot: session issuance atomically leases one `READY` slot, and logout or expiry makes that slot `DIRTY`. Dirty, resetting, or quarantined sandboxes are not claimable.

The immutable public demo organization is not part of this reset pool. Real organizations are not eligible for any reset operation.

## Safety contract

`npm run demo:reset` accepts no command-line arguments. Its only mode input is `DEMO_RESET_MODE=incremental|nightly`:

- `incremental` claims only database-selected dirty or expired sandbox slots;
- `nightly` revokes remaining sandbox sessions, marks every pool slot dirty, resets the full pool, and verifies the canonical baseline.

The database operation accepts no organization ID or slot selector. It locks pool rows, verifies that each target is registered as a synthetic `SANDBOX`, re-encrypts baseline values under that organization's DEK, increments the generation, and returns the slot to `READY` only after baseline verification. A failure rolls back partial work and leaves the slot `QUARANTINED`; do not make it ready manually. For the child-first purge only, the verified database-owner maintenance transaction sets `session_replication_role=replica`, then restores `origin` before reseeding and verification. The normal application role cannot bypass triggers, and the failure path restores `origin` before quarantining the slot.

Because per-organization encryption is required, the maintenance container is an owner-only one-shot with the organization root KEK mounted as a file. It has no published port or egress network, uses a read-only root filesystem, and is attached only to the private PostgreSQL network. The public application role cannot invoke this operator path.

## Manual acceptance

After applying current migrations and allowing the normal `bootstrap_demo` dependency to provision the pool, build and exercise both modes:

```bash
docker compose --profile demo-maintenance build reset_demo_sandboxes reconcile_demo_sandboxes
docker compose --profile demo-maintenance run --rm --no-deps reset_demo_sandboxes
docker compose --profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes
```

Do not append an organization, UUID, or slot argument. Both commands fail if the database owner settings or root-key file are unavailable. The nightly command is the release acceptance gate because it proves that all slots can return to the canonical baseline.

## Scheduling on the target

The committed units run from `/home/deploy/business-finlynq`. The host needs Docker Compose and `flock` from `util-linux`. Install the frequent reset and nightly reconciliation units with the shared failure notifier:

```bash
install -m 0644 deploy/systemd/business-finlynq-demo-reset.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reset.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor-notify@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now business-finlynq-demo-reset.timer business-finlynq-demo-reconcile.timer
systemctl start business-finlynq-demo-reconcile.service
```

Set the explicit writable-demo gate expectations, `MONITOR_EXPECT_DEMO_MAINTENANCE=true`, `MONITOR_EXPECT_DEMO_POOL_SIZE=32`, and `MONITOR_MIN_DEMO_READY_SLOTS=4` in the mandatory `/etc/business-finlynq/operations.env` only after both timers pass this acceptance. The host monitor then validates timer state plus aggregate pool size, capacity, quarantine, and stranded resets.

The incremental service runs five minutes after boot and five minutes after each completed pass, with a short jitter. The full reconciliation runs at 04:15 in `America/Toronto` and is persistent across downtime. Both wrappers share `/run/lock/business-finlynq-demo-reset.lock`; incremental work skips an overlapping pass, while nightly reconciliation waits up to ten minutes and alerts if it cannot acquire the lock.

Check evidence without querying decrypted data:

```bash
systemctl status business-finlynq-demo-reset.timer business-finlynq-demo-reconcile.timer
journalctl -u business-finlynq-demo-reset.service -u business-finlynq-demo-reconcile.service --since today
```

Alert on any failed reset, quarantined slot, repeated pool exhaustion, or a pool that does not return to its configured ready capacity.

Before updating the checkout or running migrations, stop both timers. After the new artifact's migrations and bootstrap finish, run the nightly reconciliation once, then start the timers again. This prevents a reset process from one release overlapping another release's schema.

## Rollback and disablement

Before rolling back to an artifact that predates sandbox maintenance, disable both timers:

```bash
systemctl disable --now business-finlynq-demo-reset.timer business-finlynq-demo-reconcile.timer
```

Keep demo writes disabled and leave dirty/quarantined slots unavailable. Do not delete a sandbox organization, alter its generation, disable triggers, or mark a slot ready by hand. Database changes remain forward-only; repair an incompatible schema with a reviewed additive migration. To re-enable maintenance, deploy a compatible current artifact, run the full reconciliation manually, review its journal output and ready/quarantine counts, then enable both timers.
