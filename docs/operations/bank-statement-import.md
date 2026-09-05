# Bank statement file import

FinLynQ can import reviewed bank and credit-card statements from the cloud document inbox. The workflow is driven by an authorized MCP client: FinLynQ reads and stores the accounting result, but it does not run a hosted model or make an autonomous import while the client is disconnected.

## Supported source files

The document inbox accepts statement files as PDF, CSV, TXT, XLS, or XLSX. The same upload, malware-scan, size, checksum, claim, and folder-boundary controls used for invoices apply. For PDF statements, read every relevant page. For CSV and TXT, review the reported encoding, delimiter, header, row count, quoting, and truncation limits. For XLS and XLSX, review every relevant worksheet and the values-only preview. Formula cells are omitted, and macros, external links, and hyperlink targets are never executed or followed.

File content is untrusted accounting evidence. A model-produced extraction is a proposal that must pass the deterministic preview and be confirmed by the user or authorized client.

The extraction is bounded to 1,000 rows and records:

- the institution and masked account identifier;
- whether the account is cash or a credit card;
- statement currency, period, balance convention, opening and closing balances;
- optional named balances and PDF page count; and
- each source row's number, posted date, positive source amount, explicit economic direction, descriptive source kind, optional payee/description/reference, optional original-currency facts, and any deliberate exclusion.

Each row must declare `direction: INCREASE` or `direction: DECREASE`. The direction determines the normalized accounting sign. `sourceKind` describes how the bank labelled the row and never determines its sign. This distinction matters for labels such as `PAYMENT`, which can describe different economic directions on cash and credit-card statements. For `POSITIVE_AMOUNT_OWED` credit-card statements, FinLynQ converts statement balances to the signed economic balance before proving that included transactions equal closing balance minus opening balance.

## Review and confirmation

Use `finlynq_daily_preview_bank_statement_import` with the extracted facts. The preview stores nothing. It returns normalized signed rows, named balances, included/excluded counts, the transaction total, statement movement, any blocking issues, stable row fingerprints, and a deterministic `previewHash`.

Do not complete the inbox item unless `readyToImport` is true. Review the normalized signs, account identity and mapping, period, opening and closing balances, named balances, exclusions, and reported issues. Completion uses `finlynq_daily_complete_inbox_document` with an `IMPORT_STATEMENT` action containing:

- the same extraction that produced the preview;
- the chosen account mapping;
- the unchanged 64-character `previewHash`; and
- `confirmed: true`.

The server rebuilds the preview and rejects a changed hash or an extraction that is no longer valid. Reuse the complete command exactly for an idempotent retry. FinLynQ retains the full completion outcome in organization-encrypted inbox processing metadata, so an exact retry returns the same statement import, account, reconciliation, row counts, duplicate-source decision, transfer candidates, and linked-evidence identifiers even if the first response was lost. The retried outcome sets `idempotentReplay: true`. A different command for an already completed inbox item is rejected.

Statement filing metadata uses `documentType: STATEMENT`. Its `documentDate` must equal the statement ending date, and its currency must equal the reviewed statement currency. A statement may supply currency without a document total. Opening, closing, available, current, and amount-owed balances are statement facts rather than an invoice total; retain named balances in the extraction. Invoice and other non-statement metadata still require currency and total together.

## Account mapping and permissions

The statement must map to an active account in the same company as the document-inbox connection. The account kind and currency must match the reviewed statement. A cash statement maps to an active, postable, non-control asset combination in that company's ledger. A credit-card statement maps to an equivalent liability combination.

The action supports two mapping modes:

- `EXISTING_ACCOUNT` selects an already active and fully mapped external banking account in the same organization and company.
- `CREATE_OR_REUSE_ACCOUNT` identifies the company, ledger, and eligible account combination. FinLynQ creates or reuses a local statement-file account using the institution, masked account, account kind, and currency as its retained identity.

An MCP connection must be allowed to manage the payables or receivables inbox that owns the document. The actor also needs `banking.read` to use the preview tool, then `banking.sync` and `banking.reconcile.prepare` to complete the import. `banking.connections.manage` is required only when `CREATE_OR_REUSE_ACCOUNT` must create the organization's local `FILE_IMPORT` connection. Selecting an existing mapped account does not silently require or grant connection-management access. Normal organization membership, connection sharing, tenant isolation, real-account, and organization-write controls continue to apply.

Every mapping and file lookup is organization scoped. The service verifies the inbox company again for both existing and newly mapped accounts; an identifier from another organization or company is not accepted.

## Records created by a confirmed import

A successful first import records the source SHA-256, reviewed extraction and hash, encrypted source-row facts, stable row fingerprints, imported/duplicate/excluded dispositions, immutable bank observations and observation versions, a closing-balance anchor, and a `DRAFT` reconciliation for the exact statement period. The cloud original is linked as evidence.

The source SHA-256 prevents the same file from creating observations twice for the same account. Row fingerprints and canonical observation content prevent overlapping statements from duplicating a transaction version. Deliberately excluded rows remain in the import audit trail without becoming observations. Reusing the same inbox item and exact command returns the existing import. A second inbox item containing an exact previously imported source can still preserve and archive its evidence, but it creates no new observations.

Existing reconciliation history is preserved. An identical draft period can be reused; a conflicting overlap is rejected. A later period requires the preceding reconciliation to be finalized, adjacent, and to have a closing balance equal to the new opening balance. Out-of-order periods are rejected.

The import never posts a journal, creates a payment, or confirms a match. It may return opposite-value, same-currency transactions from another account as transfer candidates. Those are review suggestions only; no match or journal is created. Continue in Banking to review matches and complete the normal reconciliation workflow.

## Filing, evidence, and recovery

Evidence and banking records are saved atomically before the cloud move. FinLynQ then files the original under the connection's Archive using its canonical statement name and year/month/Statements structure. Files already in the Inbox are preserved until a confirmed completion succeeds.

If the accounting transaction commits but the provider move fails or its response is lost, the inbox item remains `READY_TO_FILE` or `FILING_FAILED`. Use `finlynq_daily_retry_document_filing`; it reconciles an already completed move and retries only the archive operation. It does not repeat the statement import, create observations, or post a journal.

A successful completion returns `statementImport.evidenceAssetId` and an authenticated `evidenceDownloadUrl`. Browser clients use that URL. MCP clients call `finlynq_daily_download_bank_statement_evidence` with the exact `statementImportId` and `assetId`. The server requires a live organization membership with `banking.read`, and it verifies that the tenant-owned immutable statement import names that exact evidence asset before and after any cloud transfer. An arbitrary asset, an asset from another organization, or an asset linked to a different import is rejected without disclosing which boundary failed.

Evidence downloads recheck the organization, connection, provider item boundary, byte limit, and original SHA-256. The older `finlynq_daily_download_document_evidence` and `/api/document-evidence/{assetId}?sourceDocumentId={sourceDocumentId}` paths remain unchanged for invoice, bill, receipt, and other evidence linked to immutable source-document versions. Disconnecting or provider revocation does not delete historical imports, reconciliation records, or evidence references. Reconnect the original cloud account to restore access to an unchanged original. Connecting a different account cannot replace historical storage. A deleted file, moved Inbox/Archive/root, changed checksum, revoked or expired credential, missing provider scope, or file moved during a read fails safely and requires the stated reconnect, restore, resync, or review action; FinLynQ does not create substitute folders during recovery.

Preview failures are actionable and do not persist anything. These include invalid dates or balance conventions, duplicate row numbers, rows outside the period, no included rows, and transaction totals that do not prove the statement movement. Completion also rejects a stale claim, changed source bytes, metadata mismatch, inactive or mismatched account, unsupported mapping, an in-progress sync, locked or overlapping periods, gaps, balance discontinuity, and missing permissions.

## Validation status

Unit and service tests use synthetic extractions and mocked database/provider boundaries unless their test name explicitly says PostgreSQL integration or live provider. They validate sign normalization, exact decimal and balance proof, stable fingerprints and preview hashes, confirmation and metadata contracts, permissions before writes, tenant-scoped replay, exact lost-response reconstruction for normal and duplicate-source completion, exact import-to-evidence authorization, deduplication, draft reconciliation creation, and the absence of journal writes. Disposable PostgreSQL tests validate the migration's RLS, grants, append-only controls, and audit behavior when run against that database.

These checks do not prove a real provider or MCP-client flow. Development acceptance must use a non-production organization and a live connected OneDrive account: drop representative PDF, CSV/TXT, XLS, and XLSX statements into the Inbox, sync until `hasMore` is false, read all relevant pages/sheets, preview and confirm one balanced import, verify its draft reconciliation and linked evidence checksum, retry a simulated filing failure, download the archived evidence, and prove a repeated source creates no observations. Also test revoked credentials and restore access by reconnecting the original account. Record live results separately from mocked and disposable-database results.

See the [cloud document inbox guide](document-cloud-inbox.md) for provider authorization, folder boundaries, retention, and recursive sync, and the [development setup guide](document-cloud-inbox-development-setup.md) for the live OneDrive registration and acceptance steps.
