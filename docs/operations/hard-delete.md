# Break-glass deletion policy

Business Finlynq has no hard-delete action in the UI, API, MCP, or shared runtime database role. Ordinary mistakes are corrected by void/reversal and replacement; submitted and posted journals remain immutable. A sealed period cannot be reopened by the application.

## Permitted cases

- An unused draft or test organization may be purged before it contains posted activity.
- Privacy obligations should normally redact or cryptographically erase protected personal fields while retaining the accounting facts required by law.
- Destruction of posted accounting history is not an application operation. If counsel determines that an exceptional legal order requires it, the incident must be handled offline as a controlled database-owner procedure.

## Required break-glass procedure

1. Record the legal basis, exact organization and record IDs, scope, reason, approver, and retention consequences in an external incident system.
2. Require two-person approval: an organization owner and an independent security/accounting administrator. Add legal approval when posted or tax evidence is affected.
3. Disable writes for the organization and revoke active sessions, service principals, integrations, and MCP credentials.
4. Produce and verify an encrypted pre-change backup and a signed accounting export. Never remove or replace the only recoverable copy during the procedure.
5. Resolve the full foreign-key dependency set in a read-only transaction and reconcile the intended impact before executing a reviewed, organization-qualified script as the database owner. Never use the shared runtime role or an unqualified delete.
6. Preserve the external approval record, script digest, affected IDs, row counts, operator identities, timestamps, and before/after trial-balance reconciliation. Do not place decrypted personal data in logs.
7. Re-run migration, RLS, integrity, audit-chain, trial-balance, subledger, tax, and backup-restore checks before restoring access.

Any procedure that cannot satisfy every step is refused. This runbook is deliberately not automated and does not grant a standing deletion capability.
