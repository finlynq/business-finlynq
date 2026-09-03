# Supplier settlements and source-document evidence

## Non-cash supplier settlements

Use `finlynq_daily_record_supplier_payment` for bank or non-cash settlements.
Set `settlementAccountCombinationId` to an active, postable combination in the
bill's organization, ledger, and legal entity, and choose:

| settlementMethod | Required non-control account |
| --- | --- |
| BANK | ASSET (bank/cash) |
| CORPORATE_CARD | LIABILITY (corporate card payable) |
| SHAREHOLDER_ADVANCE | LIABILITY (due to shareholder) |
| EMPLOYEE_REIMBURSEMENT | LIABILITY (due to employee) |
| OTHER_NON_CASH | LIABILITY |

For example, a CAD 158.20 bill paid personally by a shareholder debits AP and
credits the selected shareholder-liability account by CAD 158.20. Select the
actual liability combination (for example account 2400 if configured); do not
supply a corporate bank combination. The tool records accounting evidence,
not a transfer. Customer receipts remain bank/cash-only.

Existing `bankAccountCombinationId` commands default to BANK and retain their
original idempotency fingerprints. Do not use that legacy field for non-cash
methods. Supplying conflicting account aliases is rejected.

Allocations still require exact open-item IDs and amounts. Partial settlement,
foreign-currency carrying values, realized FX, and void/reversal follow the same
source-owned posting controls. Use `finlynq_daily_void_supplier_payment` to
reverse both the journal and original allocations.

In the web app: **Payables → Bills → Record settlement → Settlement method**.
The funding account dropdown switches between asset and liability combinations.

## Retain an invoice and receipt through MCP

1. Create the supplier-bill (or sales-invoice) draft.
2. Call `finlynq_daily_upload_document_evidence` separately for each file with
   `module` (`payables` or `receivables`), `filename`, `mimeType`,
   `byteSize`, lowercase hexadecimal `sha256`, canonical `contentBase64`,
   and a stable `idempotencyKey`.
3. Call `finlynq_daily_attach_document_evidence` with `kind`,
   `sourceNumber`, the exact `expectedVersion`, the returned `assetId`,
   `purpose` (`INVOICE`, `RECEIPT`, or `SUPPORTING`), `reason`, and
   another stable `idempotencyKey`. Each attachment returns a new draft
   version; use it for the next attachment or issue command.
4. `finlynq_daily_get_document` returns `attachments` containing filename,
   MIME type, byte size, SHA-256, uploader, upload/scan timestamps, scanner
   version, source-document ID/number/version, and an authenticated download URL.
   It does not include the binary.
5. To retrieve bytes in an MCP client, explicitly call
   `finlynq_daily_download_document_evidence` with `assetId` and
   `sourceDocumentId`. It reauthorizes access and returns bounded
   `contentBase64`. Web users can open **View details → Source documents**.

Files must be PDF, PNG, or JPEG and no larger than 2 MiB. Declared extension,
signature, MIME type, size, and SHA-256 must match. Encrypted files, malware,
scanner-limit violations, stale signatures, and unavailable scanning fail
closed. Arbitrary fetch URLs are not accepted. There is no public file URL.

`finlynq_daily_detach_document_evidence` accepts kind, number, expected draft
version, asset ID, reason, and idempotency key. It creates a new draft version:
it does not delete the asset or earlier links. Editing preserves current links;
issuing and voiding preserve immutable evidence. Up to 20 assets can be linked
to a version. Retrying a command with the same key and exact arguments does not
duplicate assets or links. Changed arguments with a reused key are rejected.

All write tools obey MCP connection policy/approval and live module manage
permissions. Download requires live module read permission, tenant ownership,
and a link on the exact requested source version. Filenames and bytes are
encrypted with the organization DEK and record/column-bound AES-GCM; historical
key versions remain usable for retained evidence. Plaintext filenames and file
contents are redacted from MCP execution/approval summaries.

## Operations

Migration `0040_document_evidence_assets` adds the append-only, FORCE-RLS asset
table, permission policy, source-lineage trigger, audit/outbox pair, runtime
SELECT/INSERT grants, and demo-reset registration. Database backups include
encrypted evidence. Application downloads perform integrity verification.
Only synthetic files may be used in the shared public demo; they are visible
to other demo visitors and removed by the normal demo reset.

Compose adds a digest-pinned official ClamAV service with a 3 GiB limit,
non-root UID, read-only root filesystem, no credentials or published ports,
a private app/scanner network, separate signature-update egress, and a
project-scoped signature volume. The app waits for scanner health. Freshclam
checks 12 times/day; the application rejects signature databases older than
seven days. Scan limits are in `deploy/evidence/clamd.conf`. Compose embeds the same non-secret
configuration and writes it to the scanner\'s bounded tmpfs at startup, so a
restrictive deployment-checkout umask cannot block the non-root daemon. The
Compose verifier checks that the embedded configuration matches the reviewed file. Review and update
the pinned image as part of normal dependency maintenance.

Local testing requires `EVIDENCE_SCANNER_HOST` and optionally
`EVIDENCE_SCANNER_PORT` (default 3310). CI starts the same image and config via
`deploy/evidence/start-test-scanner.sh` on port 53310. Never add a production
scan-bypass flag. See the [official ClamAV container guide](https://docs.clamav.net/manual/Installing/Docker.html).
