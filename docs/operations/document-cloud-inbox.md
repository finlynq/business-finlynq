# Cloud document inbox

The current self-service workflow uses OneDrive's dedicated application folder. Existing Google connections remain compatible, with their legacy whole-drive permission explicitly identified. New Google connections are blocked: this release does not offer whole-drive authorization as a substitute for provider-enforced folder access. Arbitrary existing-folder selection and share-link authorization remain unavailable.

No hosted model API worker is included. Shared services in `src/modules/document-storage` support browser controls and MCP; a future worker can call them with its own authorized actor context. `access-policy.ts` describes each provider's actual grant; `boundaries.ts` applies connection-specific checks in addition to that grant.

## Provider feasibility (official documentation checked 2026-09-04)

| Provider model | Provider-enforced access | Existing folder and direct external drops | Implementation status |
| --- | --- | --- | --- |
| Google `drive.file` with Picker | Individually authorized/app-created files | Picking the folder is not recursive authorization of existing children or later files added outside FinLynQ | Not offered for the drop-folder workflow |
| Google legacy `drive` | All Drive files the account permits | Technically accessible, but application folder filtering does not restrict Google's grant | Existing connections only; explicit acknowledgement on reconnect |
| OneDrive `Files.ReadWrite.AppFolder` | The entire application's dedicated folder | External drops inside its Inbox are supported; arbitrary folders elsewhere are outside this grant | Supported self-service model for personal accounts; live acceptance required |
| Microsoft 365 `Files.SelectedOperations.Selected` | Explicitly granted files/library folders and inherited access | A selected folder can be provisioned with a write grant; access follows provider permissions and inheritance | Deferred: administrator-assisted provisioning conflicts with the requested personal-account simplicity |

Google describes `drive.file` as per-file access for app-created/opened files or files selected with Picker. The official scope contract does not provide a recursive folder grant. Consequently, FinLynQ must not promise discovery of a folder's pre-existing children or later externally added files after selecting that folder. A test that mocks those children as readable cannot establish this capability. See [Google's scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Microsoft's app-folder grant covers **all** FinLynQ content in that provider app folder, not just one company/module subfolder. Connection-level isolation is additionally enforced by FinLynQ. Microsoft's guide documents home and work/school OneDrive support; the permissions reference still labels the delegated permission preview. Validate each supported account type. See [app folders](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder) and [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#filesreadwriteappfolder).

Microsoft Selected permissions require consent plus an explicit application/resource permission grant and a token with the Selected scope. Delegated access intersects user permissions with the application grant; children with different inheritance must be checked rather than assumed accessible. The reference requires administrator consent and does not list personal-account support for `Files.SelectedOperations.Selected`. Creating the grant requires privileged resource-management authority; FinLynQ must not request broad permissions to self-provision it. See [Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) and [scope requirements](https://learn.microsoft.com/en-us/graph/permissions-reference#filesselectedoperationsselected).

## Sharing links and passwords

A URL can identify a folder; its storage encryption does not change the provider ACL. Google's shares to named users/groups propagate through the folder hierarchy, which is a different mechanism from the OAuth `drive.file` per-file grant. A private share to a FinLynQ identity could be a future authorization model, requiring identity isolation, revocation, and file-ownership design. A Google service account cannot own files or supply personal Drive quota, so it is not a drop-in solution for uploads and archive-folder creation in consumer My Drive. See [Google sharing](https://developers.google.com/workspace/drive/api/guides/manage-sharing) and [service-account storage limitations](https://developers.google.com/workspace/drive/api/guides/handle-errors#storagequotaexceeded).

Microsoft Graph's share-link API requires an access token and at least delegated `Files.ReadWrite`; a pasted link cannot replace the app-folder scope with a folder-only grant. FinLynQ does not redeem anonymous links or follow arbitrary supplied URLs. See [access shared items](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0).

Encrypting an "anyone with the link" URL only protects the stored copy. Anyone who obtains the plaintext may still use the link. The existing organization encryption uses server-accessible keys, not a key derived only from the user's password. A password-only, user-unlocked design would require a separate unlock/key-recovery model and would prevent processing while locked. Neither model should be described as making cloud content accessible only to the user: the provider and granted recipients still have their own access.

## Product decisions still required

Keep the personal-account flow free of enterprise administrator provisioning, as requested. OneDrive can use its dedicated app folder. For Google, decide between explicit per-file import/upload with `drive.file` (a different workflow that cannot automatically ingest arbitrary external drops), or a separately designed private-recipient sharing model. Neither is silently substituted here. Choosing an existing arbitrary folder with all future direct drops and only a normal consumer OAuth consent is not currently an implemented, documented provider contract for these two models.

For any future selected-root model, first define whether the selected folder itself is the inbox or contains newly created Inbox/Archive folders. The proposed safe layout is dedicated Inbox and Archive children, with existing root contents untouched until explicitly imported. That layout is a proposal, not an implemented picker or an additional provider permission.

## Enable supported providers

Use the [development setup guide](document-cloud-inbox-development-setup.md) for exact dev values. The app includes Poppler for in-memory PDF reading and requires a working ClamAV scanner. Existing migrations through `0044_storage_oauth_revocation` and runtime grants are unchanged by this update.

| Provider | Configuration | Authorization use |
| --- | --- | --- |
| OneDrive | `DOCUMENT_MICROSOFT_CLIENT_ID`, `DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE` | `offline_access Files.ReadWrite.AppFolder` |
| Google (legacy only) | `DOCUMENT_GOOGLE_CLIENT_ID`, `DOCUMENT_GOOGLE_CLIENT_SECRET_FILE` | Preserve existing `https://www.googleapis.com/auth/drive` connections |

Register exact web callbacks at `/api/document-storage/callback/ONEDRIVE` or `/api/document-storage/callback/GOOGLE_DRIVE` under the configured canonical HTTPS origin. Client registration identifies FinLynQ; users then consent using their own accounts. Use mounted client-secret files. Keep callback queries out of proxy logs; supplied Caddy configurations include `log_skip`, but the shared edge is deployed separately.

**Google Testing mode:** external OAuth apps in Testing receive refresh tokens that expire after seven days when Drive scopes are requested. The basic-profile-only exception does not apply. Reconnect the original account after expiry; repeated retries cannot revive the token. Publishing/verification is a separate provider process and is not completed by deploying FinLynQ. See [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## User workflow

An organization administrator opens **Settings → Document inbox**, chooses a company and purchases/sales module, and explicitly shares the connection with authorized organization members. Real organization writes must be enabled. Cloud storage is unavailable in demo organizations. Each connection creates its own root, Inbox, and Archive; arbitrary existing folders and cross-drive moves are outside this release. Consent describes both the provider permission and sharing with authorized organization members. Nothing already elsewhere in the drive is automatically moved.

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
- Each cloud read/upload/sync/filing operation checks its stored root and relevant folder ancestry, including folder moves and cross-drive/shortcut responses. File moves during reads and downloads are rejected. OneDrive downloads manually follow [Graph's short-lived preauthenticated `Location`](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) only for a narrow set of Microsoft-controlled OneDrive/SharePoint hosts; the Graph credential is never forwarded, further redirects are rejected, and the signed URL is never logged or stored. Metadata-only list/claim/review operations retain organization/module RLS and permission checks. Missing Inbox blocks ingestion while existing Archive evidence remains downloadable; a missing/moved Archive blocks its evidence. Reconnect keeps account and folder IDs and resets stale pagination. No recovery silently creates substitute folders.
- `NEEDS_REVIEW` preserves the original in Inbox. A client can reclaim it after the user resolves the issue. A changed source invalidates stale processing: sync and read it again. Do not overwrite or delete originals to resolve suspected duplicates.
- Disconnect removes saved credentials and invalidates pending connection handoffs. It does not revoke every provider grant for this app, since that could affect other connections; users can revoke the app in their provider account settings. Cloud files remain in the account. Reconnect the original account to restore attachment downloads; a different account cannot silently replace historical storage.
- The database stores encrypted filenames, extraction metadata, credentials, workflow state, immutable evidence references, and accounting history. Cloud evidence downloads verify the original SHA-256. Owner edits/deletions are reported as unavailable or changed evidence. Legacy encrypted database evidence continues to work; it is not migrated or deleted.
- Originals remain ordinary provider-readable files. Organization field encryption protects stored metadata and credentials, not cloud file bytes. Database backups do not back up cloud originals. Account owners control their cloud retention and recovery.
- Business duplicate fingerprints use the active organization key. Any future organization-key rotation must rebuild those fingerprints before retiring a key; key rotation automation is not included here. Drive filename search works with the canonical names. App-side full-text search of encrypted metadata and cross-drive archival are deferred.

## Acceptance evidence

Automated tests cover canonical naming, bounded provider responses, credential-safe redirects, scope checks, real PDF/text/image rendering, tenant isolation, competing lease ownership, stale content, malware rejection, duplicate detection, atomic draft/evidence rollback, upload retries, lost move recovery, OAuth replay/revocation, and legacy evidence downloads. Integration tests mock provider transport/scanning while exercising real PostgreSQL RLS, audit, encryption, and source-document transactions.

Baseline verification for revision `795c396` on 2026-09-04: production build, lint, clean migrations/schema/grants, Compose boundaries, Caddy configuration, and authenticated desktop/mobile settings checks passed. That version's full suite passed 840 tests across 151 files with `npm run test -- --testTimeout=15000` against fresh, bootstrapped disposable PostgreSQL; two existing live-scanner tests were skipped because no scanner endpoint was supplied. The timeout override accommodates this host’s existing release-orchestration test. Native Poppler rendering was exercised with text and image-only PDF pages. These historical checks do not substitute for the current release gate.

Before public activation, complete a personal OneDrive OAuth connection and, where one exists, reconnect a legacy Google connection. Drop files directly into each cloud inbox, process a text PDF and scanned invoice in each supported Codex/ChatGPT client, and verify the final archive and attachment download. Client transport payload tests do not establish live client compatibility. These live checks require operator provider registrations and account access and were not performed as part of local implementation.

Focused verification for this update: 63 tests across seven suites passed against disposable PostgreSQL 16, including runtime RLS, cross-organization denial, later external-drop discovery, moved roots/files, refresh/revocation errors, original-account reconnect, historical cloud and database attachments, safe callback feedback, in-flight Google authorization denial, and executable development configuration-drift checks. Production build, lint, TypeScript, and shell syntax checks passed. Provider transport and malware scanning in the database suites are mocked; these results do not validate real Google/OneDrive grants or live MCP-client/provider compatibility. No live account credentials were available.
