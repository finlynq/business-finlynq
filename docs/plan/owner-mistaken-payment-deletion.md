# Owner deletion of a mistaken supplier payment

## Decision and scope

An organization owner requested a reusable way to physically delete an incorrectly posted supplier payment and, separately, an account created by mistake. Existing business audit and outbox records must remain. An audit event has no foreign key to an account, so retaining that evidence does not prevent deleting an otherwise unused account.

The current application offers a void with a reversing journal. Posted source documents, allocations, subledger events, and journals are protected by append-only database guards. This proposal changes that contract only for an explicitly selected supplier payment after an exact dependency check. It does not run a purge or change any production data.

## Proposed payment command

The request names the source document ID and current version, a reason of 10–500 characters, and an idempotency key. The server requires a real owner session with current MFA assurance and rechecks owner membership inside the database transaction. The public demo, ordinary administrators, API tokens, and MCP clients cannot use the command.

Within one transaction, lock the organization, source document, journal, allocations, and subledger event. Require one current POSTED `payables.supplier-payment` source, one POSTED routine journal owned by that source, and one matching payment subledger event. Reject a voided or superseded source, a related reversal or replacement journal, a bank reconciliation match, a posted tax filing or booking snapshot dependent on these rows, a source evidence dependency, or any additional foreign-key or semantic reference outside the selected payment. No `CASCADE` deletion is allowed.

After the complete preflight, transition only that journal to draft under a transaction-scoped owner exception, then delete its lines, journal, payment allocations, payment subledger event, and source document. The exception must identify the exact source ID and table-owner execution context. It must not disable triggers or weaken the global append-only rule for other records. Roll back the entire transaction on any mismatch or constraint failure. Append one audit event identifying the owner, reason, source and journal IDs, prior journal number, and removed row counts. Retain all prior audit and paired outbox events unchanged. A retry with the same key returns the completed result; a reused key with different input fails.

The preflight needs a catalog-backed foreign-key inventory plus explicit checks for references stored in JSON or text. The first implementation must include negative tests for each supported dependency family and fail closed when the schema adds a new referencing table without a reviewed check. A live migration test must show that ordinary SQL still cannot delete a posted source, allocation, event, or journal.

## Proposed account command

Provide separate owner-only actions beside a supplier record, bank/card account, and chart-of-accounts ledger account. Each action shows the selected name and ID, requires an exact confirmation and reason, and rechecks real MFA and owner membership in the database. Delete only when the account has no use outside the selected payment already removed. Do not cascade to unrelated documents, journals, bank observations, statement imports, mappings, reconciliations, tax configuration, or other parties.

For a ledger account, remove only its unused account combinations and then the account; reject protected control accounts. For a supplier, remove only its unused supplier accounts and addresses before the party, and reject any customer role or remaining document. For a bank/card account, reject any linked feed, imported statement, observation, mapping, balance anchor, reconciliation, or matching record. Database foreign keys remain a final backstop. Append an account-deletion audit event and keep pre-existing audit/outbox history.

## Release proof

Tests must cover owner/MFA/tenant enforcement, exact-version and idempotency races, each account type, conflicting dependencies, an unrelated payment sharing the supplier or ledger account, and transaction rollback after a forced foreign-key failure. Verify the audit hash chain and paired outbox contract, subledger open balances, trial balance, and backup/restore after deletion. Promote through dev, staging, and main only after those checks pass.

Automatic approval review rejected an initial combined migration because it would have added persistent owner-triggered hard-delete capabilities by broadly replacing append-only guards while account dependency checks were incomplete. The implementation remains pending a narrower reviewed design and explicit approval of that destructive exception.
