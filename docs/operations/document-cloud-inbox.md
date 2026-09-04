# Cloud document inbox

The implementation is available in source. Provider registration and live account acceptance are required before enabling it in a deployment. No hosted model API worker is included. Shared services in `src/modules/document-storage` support browser controls and MCP; a future worker can call them with its own authorized actor context.

## Enable providers

1. Apply migrations through `0044_storage_oauth_revocation`, then reconcile `business_finlynq_app` grants using `deploy/postgres/010-runtime-role.sh`. Run `npm run db:verify-schema`. Use the normal deployment procedure; do not run integration tests against production.
2. Build the new app image. It includes Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`) for in-memory PDF reading. Keep the existing ClamAV service enabled and reachable. Without a successful malware scan, documents cannot be accepted or read for ingestion. Local development and CI require `poppler-utils` for PDF tests.
3. Set `BUSINESS_FINLYNQ_PUBLIC_URL` or `APP_ORIGIN` to the canonical HTTPS origin. Register exact OAuth redirect URIs:
   - Google: `https://YOUR_HOST/api/document-storage/callback/GOOGLE_DRIVE`
   - Microsoft: `https://YOUR_HOST/api/document-storage/callback/ONEDRIVE`
4. Configure the providers below. Leave a provider unset to show it as unavailable. Production client secrets must use mounted files; only the app receives these Compose secrets. Never commit tokens or secret files.

| Provider | Configuration | Delegated permissions |
| --- | --- | --- |
| Google Drive | `DOCUMENT_GOOGLE_CLIENT_ID`, `DOCUMENT_GOOGLE_CLIENT_SECRET_FILE` | `https://www.googleapis.com/auth/drive`, offline access |
| OneDrive | `DOCUMENT_MICROSOFT_CLIENT_ID`, `DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE` | `offline_access Files.ReadWrite.AppFolder` |

Enable the Google Drive API and configure a web OAuth application and consent screen. The drop-folder workflow deliberately requests broad Drive access: `drive.file` alone does not guarantee discovery of files users add externally. Complete Google's applicable restricted-scope verification requirements before public rollout. Application folder filtering limits FinLynQ's workflow; it does not reduce Google's granted account-level permission. See [Google's scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Register a Microsoft web application for the intended work/school and personal account types, with a client secret and the delegated app-folder permission. The implementation uses the `common` authorization endpoint and creates its folders beneath `special/approot`. See [Microsoft's app-folder guide](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder). Verify consent and list/read/upload/move operations with both account types before advertising support for both.

Keep OAuth callback query strings out of reverse-proxy access logs. The supplied Caddy configurations use [the `log_skip` directive](https://caddyserver.com/docs/caddyfile/directives/log_skip) for these callback paths. If using another proxy, configure equivalent handling. Callback responses use no-store and no-referrer.

## User workflow

An organization administrator opens **Settings → Document inbox**, chooses a company and purchases/sales module, and explicitly shares the connection with authorized organization members. Real organization writes must be enabled. Cloud storage is unavailable in demo organizations. Each connection creates its own root, Inbox, and Archive; arbitrary existing folders and cross-drive moves are outside this release.

```text
FinLynQ-Company-purchases-<connection UUID>/
  Inbox/
  Archive/
    2026/09/Purchase Invoices/
      2026-09-04__Acme__INV-1042__CAD-158.20__FLQ-<item UUID>.pdf
```

Users upload PDFs, PNGs, or JPEGs up to 2 MiB from the settings page, through `finlynq_daily_upload_inbox_document`, or directly into the cloud Inbox. Browser/MCP uploads stream through bounded server memory for validation/scanning; no new cloud original is persisted on the application server. PDFs must have 1–100 pages. Other files are discovered as needing review and stay in the inbox.

Connect an MCP client in **AI & MCP connections**, granting Daily write access and the relevant accounting permissions. Ask it to sync the inbox, identify documents, check all relevant pages, create appropriate drafts or link existing drafts, and file the originals. Existing exact-argument approvals still apply. Storage OAuth setup itself remains in the browser; provider credentials never reach the client.

The nine cloud tools are `finlynq_daily_list_document_storage`, `finlynq_daily_upload_inbox_document`, `finlynq_daily_sync_document_inbox`, `finlynq_daily_list_document_inbox`, `finlynq_daily_claim_inbox_document`, `finlynq_daily_read_inbox_document`, `finlynq_daily_complete_inbox_document`, `finlynq_daily_review_inbox_document`, and `finlynq_daily_retry_document_filing`. Sync reads up to 50 files per call; repeat while `hasMore` is true. List results have `nextCursor` pagination. Claims expire after ten minutes and can be renewed using the same UUID by the same client. A different browser or MCP connection cannot complete the lease.

Reading returns actual MCP image blocks, available PDF text, page count, SHA-256, and duplicate hints. The client's model interprets that content. FinLynQ makes no model API calls and has no AI API-key setting. The user's client subscription/usage and FinLynQ's hosting, scanning, storage metadata, and bandwidth costs remain separate. There is no autonomous background processing when the client is disconnected.

Completion uses the existing accounting validation, tax/FX rules, source history, and write controls. It creates a draft with evidence or attaches to an exact draft version in one database transaction. It never posts or pays. Invoices require matching date, currency, and calculated total. Exact-content duplicates and matching company/supplier/invoice-reference/currency combinations block creation of another draft; a user can review and deliberately link an existing draft instead. Supporting documents can be archived without creating a bill. Missing dates, uncertain matches, or unreadable files should be marked for review.

## Recovery and retention

- `READY_TO_FILE` means the accounting/evidence transaction committed. `FILING_FAILED` preserves the saved record and an actionable reason. Retry filing from settings or MCP; the service reconciles a lost move response and never repeats draft creation.
- `NEEDS_REVIEW` preserves the original in Inbox. A client can reclaim it after the user resolves the issue. A changed source invalidates stale processing: sync and read it again. Do not overwrite or delete originals to resolve suspected duplicates.
- Disconnect removes saved credentials and invalidates pending connection handoffs. Cloud files remain in the account. Reconnect the original account to restore attachment downloads; a different account cannot silently replace historical storage.
- The database stores encrypted filenames, extraction metadata, credentials, workflow state, immutable evidence references, and accounting history. Cloud evidence downloads verify the original SHA-256. Owner edits/deletions are reported as unavailable or changed evidence. Legacy encrypted database evidence continues to work; it is not migrated or deleted.
- Originals remain ordinary provider-readable files. Organization field encryption protects stored metadata and credentials, not cloud file bytes. Database backups do not back up cloud originals. Account owners control their cloud retention and recovery.
- Business duplicate fingerprints use the active organization key. Any future organization-key rotation must rebuild those fingerprints before retiring a key; key rotation automation is not included here. Drive filename search works with the canonical names. App-side full-text search of encrypted metadata and cross-drive archival are deferred.

## Acceptance evidence

Automated tests cover canonical naming, bounded provider responses, credential-safe redirects, scope checks, real PDF/text/image rendering, tenant isolation, competing lease ownership, stale content, malware rejection, duplicate detection, atomic draft/evidence rollback, upload retries, lost move recovery, OAuth replay/revocation, and legacy evidence downloads. Integration tests mock provider transport/scanning while exercising real PostgreSQL RLS, audit, encryption, and source-document transactions.

Local verification on 2026-09-04: production build, lint, clean migrations/schema/grants, Compose boundaries, Caddy configuration, and authenticated desktop/mobile settings checks passed. The full suite passed 840 tests across 151 files with `npm run test -- --testTimeout=15000` against fresh, bootstrapped disposable PostgreSQL; two existing live-scanner tests were skipped because no scanner endpoint was supplied. The timeout override accommodates this host’s existing release-orchestration test. Native Poppler rendering was exercised with text and image-only PDF pages.

Before public activation, complete real Google and Microsoft OAuth connections, drop files directly into each cloud inbox, process a text PDF and scanned invoice in each supported Codex/ChatGPT client, and verify the final archive and attachment download. Client transport payload tests do not establish live client compatibility. These live checks require operator provider registrations and account access and were not performed as part of local implementation.
