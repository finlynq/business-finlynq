# Incident response and severity policy

This runbook is the operator entry point for production incidents. It is intentionally procedural and contains no customer names, email addresses, document references, financial amounts, connector payloads, tokens, or secret material. Put those details only in the approved restricted evidence store.

## Severity and routing

| Severity | Declare when | Routing and acknowledgement | Default containment |
|---|---|---|---|
| SEV-1 critical | Confirmed or credible cross-tenant access, unauthorized posting, exposed encryption or connector credential, audit-chain failure, destructive data change, or inability to recover protected data | Page the primary and secondary operators immediately; assign an incident commander and security/accounting lead; acknowledge within 5 minutes | Disable the affected write/connector boundary immediately and preserve read-only evidence |
| SEV-2 high | Authentication or business writes are broadly unavailable, an RPO/RTO objective is breached, a migration fails before traffic, a backup/restore control fails, or an unexplained accounting discrepancy exists without evidence of tampering | Page the on-call operator and relevant security/accounting owner; acknowledge within 15 minutes | Keep or move the affected surface to read-only; do not improvise a schema or key change |
| SEV-3 moderate | Sustained latency/error degradation, recoverable queue lag, repeated email delivery failure, demo capacity loss, or a noncritical connector outage | Notify the on-call channel; acknowledge within 1 hour | Stop the failing worker or integration if retries could amplify harm |
| SEV-4 low | A single recoverable failure, warning threshold, or maintenance defect with no customer/accounting impact | Ticket for the owning team by the next business day | Preserve evidence and use the normal change process |

The highest credible impact sets severity; uncertainty does not justify downgrading. External uptime, local systemd failures, provider alerts, and audit/backup verification must reach at least two operators through independent routes. Acknowledgement is not resolution. The incident commander records UTC times, the exact release revision, affected organization identifiers where permitted, decisions, approvers, and evidence links.

SEV-1 and SEV-2 incidents remain open until the relevant security or accounting owner approves recovery. Close only after the triggering alert is green, the affected workflow passes its acceptance check, queued work is accounted for, and a follow-up owner and due date are recorded.

## Common first response

1. Acknowledge, declare severity, and open the restricted incident record. Record UTC time, release SHA, host, alert/check name, and current write/connector gates.
2. Preserve logs and immutable database/backup evidence. Query by opaque request, audit, outbox, organization, or aggregate identifiers; never paste plaintext payloads or secrets into chat or tickets.
3. Contain at the narrowest reliable server-enforced boundary. When accounting integrity may be affected, disable writes first and keep read-only reports and audit history available.
4. Take a verified encrypted off-site backup only if doing so will not overwrite or prune the sole known-good recovery point. Never replace an encryption key, edit posted rows, clear a queue, or restore over the live database as diagnosis.
5. Recover with a reviewed artifact or forward repair, run the named acceptance checks, then obtain the required security/accounting approval before reopening the boundary.

## Authentication outage

**Trigger:** login, invitation, MFA, password recovery, or email delivery is broadly failing; a stopped/stale worker or provider outage is detected.

1. Compare public readiness, internal readiness, worker heartbeat/lease state, provider status, and bounded redacted logs. Determine whether existing sessions still resolve.
2. Keep valid existing sessions and read-only accounting available when safe. Do not enable a password-only bypass, expose recovery tokens, or weaken rate limits/MFA to restore access.
3. If delivery retries are accumulating, stop the email worker without deleting outbox rows. If identity-secret or database integrity is in doubt, disable account login/signup and business writes until security review.
4. Restore the exact worker/app revision and secret mounts, or wait for/recover the provider. Never rotate `IDENTITY_SECRET` or the organization root key as a troubleshooting step.
5. Prove invitation, login, optional/enrolled MFA, one-use reset, session revocation, and outbox delivery with a controlled identity. Re-enable in stages and confirm stopped-worker and failed-delivery alerts.

## Write shutdown

**Trigger:** unauthorized or inconsistent mutation, accounting-integrity concern, failing dependency, planned migration, or operator-requested emergency stop.

1. For one organization, use the reviewed per-organization write-disable command and record its request ID and reason. For a service-wide stop, set `BUSINESS_WRITES_ENABLED=false`, recreate the application from the same reviewed artifact, and verify the running gate through internal readiness/monitoring.
2. Stop connector polling and write-capable workers when their retries can create drafts or state changes. Do not discard cursors, observations, audit events, or outbox rows.
3. Verify public liveness/readiness and authenticated read-only reports remain available; prove a representative mutation fails closed for the affected organization while an unaffected organization retains its intended state.
4. Diagnose with request → audit → outbox lineage and database health. Apply a reviewed forward repair or configuration correction.
5. Re-enable only after tenant isolation, posting authorization, idempotency, audit/outbox integrity, period controls, and a fresh verified backup pass. Two operators approve service-wide reopening; accounting approves any incident involving posted facts.

## Failed migration

**Trigger:** migrator, grant reconciliation, schema verification, or post-migration acceptance fails.

1. Keep traffic and all writes off. Record the migration identifier, candidate SHA, database error code, last successful step, and pre-migration backup checksum.
2. Do not retry blindly, run an ad hoc down migration, alter the migration journal, or start an older incompatible application.
3. Determine whether the transaction rolled back. Run the non-mutating schema/grant verifier and inspect PostgreSQL locks and the migration journal using bounded output.
4. If the schema is compatible, deploy the preceding immutable application artifact in its documented degraded mode. Otherwise create and review a forward repair migration, rehearse it against an isolated restore, then apply and repeat every role reconciliation.
5. Before traffic, pass schema/grant verification, key recovery, audit/outbox integrity, readiness, tenant isolation, and browser acceptance. Take and verify a new encrypted off-site backup and retain both migration and rollback decisions.

## Connector credential leak

**Trigger:** a bank/connector token, webhook secret, provider credential, or decrypted connector payload may have been exposed.

1. Declare SEV-1, set `BANK_FEEDS_ENABLED=false`, stop connector polling, and disable only the affected connection where its server-enforced state is available.
2. Preserve provider audit logs, encrypted credential-version history, sync cursors, observations, request IDs, and application logs. Do not print or copy the suspect secret for comparison.
3. Revoke the credential at the provider, invalidate active consent/sessions, and issue a new least-privilege credential through the normal encrypted write path. Rotate broader credentials only when evidence shows they are affected; never rotate the organization root key as containment.
4. Determine exposure window, organizations/accounts involved, actions available to the credential, and whether any observations or drafts were created. Escalate regulatory/customer notification to the security owner.
5. Reconnect with a controlled account, prove ciphertext/key-version coverage, deduplication, cursor continuity, and no auto-post/payment capability, then re-enable the affected connection and finally the global feed gate.

## Accounting discrepancy

**Trigger:** ledger, source document, subledger, tax, aging, bank reconciliation, or financial report differs without an explained timing/mapping reason.

1. Disable writes for the affected organization; preserve read-only reporting. Declare SEV-1 if unauthorized change or audit failure is credible, otherwise SEV-2.
2. Record the entity, ledger, period/as-of parameters, report revision, currencies, and opaque source/journal identifiers. Preserve generated reports and audit/outbox integrity output without customer text or amounts in ordinary logs.
3. Reconcile source → journal → journal lines → account balances → report mapping, and subledger totals to control accounts. Check period state, currency/rate version, tax snapshot, reversals/replacements, and import idempotency.
4. Never update/delete posted facts or restore the live database to make reports agree. Correct through the owning source module or a linked, approved reversal/replacement journal in an open permitted period; retain the original discrepancy evidence.
5. Accounting signs the root cause, correction, and zero unexplained difference across trial balance, statements, subledger controls, and affected tax/bank reports before organization writes are re-enabled.

## Evidence and follow-up

Retain the alert delivery record, UTC timeline, release/image identifiers, gate changes, opaque request/audit/outbox identifiers, backup manifest/checksum, restore evidence when applicable, commands/approvals, and final acceptance results. SEV-1/2 follow-up must test the failed control and update the relevant runbook or alert; it may not close with “operator error” alone.

Related procedures: [monitoring and alerting](monitoring-and-alerting.md), [backups and recovery](backups-and-recovery.md), [account authentication](account-authentication.md), [organization keys](organization-keys.md), and [migrations](migrations.md).
