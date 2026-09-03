# Shared demo maintenance

The public demo has one fixed PUBLIC_DEMO organization and one canonical demo_accountant identity. Visitors share all daytime changes. Nightly reconciliation destructively restores that organization to the canonical synthetic baseline.

## Scheduled reset

npm run demo:reset accepts no tenant, organization, or slot selector and fails closed unless DEMO_RESET_MODE=nightly. The reviewed systemd timer or managed-cron fallback runs it at the 04:15 America/Toronto boundary. The Compose service and systemd unit retain their historical reconciliation names for one compatibility release, but they now reset only the fixed shared demo.

The reset sequence is:

1. Acquire the global reset advisory lock and the exclusive shared-demo transaction fence.
2. Mark shared_demo_reset_state as RESETTING.
3. Revoke every live demo session and invalidate any legacy claim rows.
4. Validate the fixed organization, user, membership, and demo_accountant role.
5. Purge all registered organization-owned tables in child-first order.
6. Run app.reset_shared_demo_extensions to remove noncanonical synthetic identities and restore shared settings.
7. Reseed tax packs, master data, banking fixtures, AR/AP documents, journals, and reconciliation data.
8. Post issued fixtures through normal posting controls and verify exact baseline counts.
9. Mark the state READY, record the completed reset time and baseline version, and advance the next boundary.

New demo entry is available only while the state is READY and the boundary is not overdue. A failed reset stores FAILED plus an owner-visible error, revokes open sessions, and keeps new entry closed.

## Manual execution

Run from the checked-out release directory during a reviewed maintenance window:

    docker compose --profile demo-maintenance build reconcile_demo_sandboxes
    docker compose --profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes

Do not append an organization ID or other selector. After completion, verify one shared_demo_reset_state row with READY, the current baseline version, a future reset_after, and a recent last_completed_reset_at. Then open two independent browser contexts and prove they enter the same organization and share a newly created uniquely numbered transaction.

## Failure recovery

Keep demo login or writes disabled while reset maintenance is unavailable. Repair the underlying schema, encryption, role, or seed problem through a reviewed forward change and rerun the complete reconciliation. Never mark the state ready by hand, partially delete tenant tables, disable triggers, or edit the reset boundary to bypass the fail-closed gate.

The application runtime role can read only the aggregate app.shared_demo_operations_state result. It cannot read or write shared_demo_reset_state, invoke app.reset_shared_demo_extensions, select a different organization, or run reset code. The maintenance container has owner database access and the organization wrapping key because the baseline includes encrypted values; it has no public port, provider credential, or egress network.

## Schema evolution and rollback

Future organization-owned modules must register purge order in demo_sandbox_reset_tables; that legacy table name is retained as the reviewed reset registry during the compatibility window. Cross-tenant or identity cleanup belongs in app.reset_shared_demo_extensions.

Legacy pool, slot, and claim tables remain owner-only for one release so a rollback can read historical state. Current login and reset paths never allocate them. A later migration may remove those tables after the rollback window closes. Encrypted backups may retain pre-reset records under the backup retention policy, so the demo must never contain real or confidential information.
