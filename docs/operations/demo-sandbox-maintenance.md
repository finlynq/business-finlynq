# Demo sandbox maintenance

The public demo uses 128 independently encrypted synthetic organizations. A browser receives an opaque host-only daily claim; PostgreSQL stores only its SHA-256 digest. A short-lived authentication session may expire or be revoked without releasing the organization. Reopening the demo from the same browser returns to the same data until nightly reconciliation.

The immutable public demo template is not part of this pool. Real organizations are never eligible for reset.

New allocations are durably limited to 16 claims per IP hash in each pool cycle. A browser that presents its still-valid claim reuses the assigned sandbox instead of consuming another allocation. This leaves at least 112 slots outside any one network identity, while allowing the six-clean-browser release gate, its CI retry allowance, and shared-network visitors behind one egress address over the cycle. The `/try-demo` route independently limits bursts to 10 requests per IP and 60 requests globally per minute.

## Safety contract

`npm run demo:reset` accepts no command-line selectors and fails closed unless `DEMO_RESET_MODE=nightly`. It is intentionally destructive to every registered sandbox and must not run as an ordinary deployment step.

Normal `npm run demo:bootstrap` is non-destructive: it seeds the immutable template and prepares only additive `DIRTY` slots. It does not reset an `ASSIGNED` sandbox, revoke its session, or invalidate its browser claim.

Nightly reconciliation obtains the global reset lock, blocks new claims, and processes every slot. For each organization it locks and revokes live demo sessions, invalidates active claims, purges registered organization-owned tables child-first, invokes `app.reset_demo_sandbox_extensions(organization_id, canonical_user_id)`, reseeds encrypted fixtures under the existing organization DEK, verifies exact baseline counts, increments the generation, and returns the slot to `READY`. Only after all 128 slots succeed does it advance the pool cycle and the next 04:15 `America/Toronto` boundary. A failed slot is `QUARANTINED`, the pool remains expired, and demo access fails closed until an operator repairs and reruns the full reconciliation.

Future modules register ordinary organization-owned tables in `demo_sandbox_reset_tables` with child-first `purge_order`. A migration that needs identity or cross-tenant cleanup must replace the extension hook. The maintenance code validates every registered identifier and requires an `organization_id` column before dynamic deletion.

The maintenance container runs as the database owner because the purge temporarily uses `session_replication_role=replica`. It has the root KEK mounted from a file, no published port or egress network, a read-only root filesystem, and only the private PostgreSQL network. The application role cannot read claim hashes or invoke maintenance.

Claims and sandboxes are not an erasure guarantee. Encrypted backups may retain pre-reset records according to the backup retention policy. The demo must never contain real or confidential information.

## Manual acceptance

After migrations and `bootstrap_demo` prepare the additive pool, build the one reviewed maintenance service:

```bash
docker compose --profile demo-maintenance build reconcile_demo_sandboxes
```

Run the destructive acceptance only in an announced maintenance window:

```bash
docker compose --profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes
```

Do not append an organization, UUID, or slot argument. Verify 128 `READY` slots, zero `QUARANTINED`/`RESETTING` slots, a future `demo_sandbox_pool.reset_after`, and an updated `last_completed_reset_at` before reopening traffic.

## Scheduling on the target

The preferred systemd timer is DST-safe and runs once at 04:15 Toronto time:

```bash
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.service /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-demo-reconcile.timer /etc/systemd/system/
install -m 0644 deploy/systemd/business-finlynq-monitor-notify@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now business-finlynq-demo-reconcile.timer
```

Set `MONITOR_EXPECT_DEMO_MAINTENANCE=true`, `MONITOR_EXPECT_DEMO_POOL_SIZE=128`, and the reviewed write/login expectations in `/etc/business-finlynq/operations.env`. The monitor validates the timer, pool capacity, quarantine/reset states, and whether the pool boundary is overdue.

Where only the deploy-owned UTC crontab is available, run `bash deploy/cron/install.sh`. The committed schedule invokes the gated wrapper at 08:15 and 09:15 UTC; exactly one is 04:15 Toronto across EST/EDT, while the other exits without resetting. The installer replaces the old five-minute dirty reset and hourly due-check inside the managed markers. The success-only Toronto date stamp prevents duplicate completion.

Before changing schema, pause the selected scheduler and drain its shared lock. Ordinary deploys then run migrations and bootstrap without resetting assigned sandboxes. Re-enable scheduling after acceptance; do not run nightly reconciliation on every deployment.

## Rollback and recovery

Disable the nightly scheduler before rolling back to an incompatible artifact:

```bash
systemctl disable --now business-finlynq-demo-reconcile.timer
```

Keep demo login/writes disabled while maintenance is unavailable. Never delete a sandbox organization, alter its generation, disable triggers, clear claims, or mark a dirty/quarantined slot ready by hand. Use a reviewed forward migration, rerun full reconciliation, inspect journal output and pool state, then re-enable the scheduler.
