# MCP document inbox and external storage

Status: implemented in source on 2026-09-04; live provider/client acceptance and deployment activation remain pending. See the [operations guide](../operations/document-cloud-inbox.md) for the shipped behavior, configuration, and verification boundaries. This document retains the original product direction; where details differ, the operations guide describes the implementation.

## Product decision

MCP is the primary driver for document processing in the free offering. Users connect their own Codex, ChatGPT, or compatible MCP client and ask it to process their inbox. FinLynQ does not initiate paid model API calls, require an AI API key, or offer hosted AI processing in this release. Client access and AI usage remain subject to the user's chosen provider and plan; a free FinLynQ account does not include model usage.

Design application services so a future model API worker can reuse the workflow. This is an extension boundary, not an enabled worker, billing feature, or new public API. Google Drive and Microsoft Graph APIs are still required for cloud file access, and existing browser/MCP endpoints remain in use.

Users can upload directly through FinLynQ or drop supported documents into an authorized cloud inbox. Originals stay in their Google Drive or OneDrive. FinLynQ retains encrypted connection credentials, attachment metadata, extracted business fields, processing state, and audit history. Validation and scanning may read bytes into bounded memory; file contents must not enter persistent application storage, logs, job payloads, or database backups. Processing through the user's AI client necessarily shares the requested document content with that client/provider.

## First release workflow

1. Connect storage through a secure browser OAuth flow and select an inbox and archive for one organization, with legal-entity routing configured explicitly. Prefer organization-managed connections for shared business records. Personal connections must define who in the organization can use their files; an MCP grant does not automatically expose private drive content to colleagues.
2. An MCP sync call enumerates accessible inbox files and records pending items. Start with bounded, on-demand sync and pagination; optional provider notifications or scheduled metadata discovery can follow. Discovery never invokes an AI model or creates accounting records. Files wait until an authorized MCP client processes them.
3. The client claims an item with a renewable, expiring lease. FinLynQ reads and scans the exact file version, calculates its checksum, and supplies bounded text or document/page content that the client actually supports. Returning a base64 string in a JSON result alone does not establish that the model can read a scanned invoice.
4. The client classifies the document and proposes extracted fields and a matching supplier/customer or existing record. The server validates dates, exact decimal amounts, currencies, line totals, references, and permissions. Receipts may support an existing bill; statements, contracts, and other documents must not automatically become invoices. Unsupported or ambiguous documents enter review.
5. Save a draft or a supporting-document association through shared application services, with an idempotent link to the inbox item and cloud evidence asset. Ingestion creates no automatic posting or payment. Existing explicit MCP posting operations retain their separate role, policy, and approval requirements.
6. Once the record and evidence association are committed, calculate the canonical name and archive location, then rename/move the original. Archive completion means ingestion succeeded; it does not mean the bill was posted or paid. A failed move retries only filing, without recreating the accounting record.
7. Report the batch outcome: drafts created, existing records linked, items requiring review, suspected duplicates, and filing failures. Expose pending work and the last successful sync in FinLynQ even when no client is running.

MCP itself is not an always-running processor. Users may run their client manually or configure client-side scheduling where supported. FinLynQ must remain correct across disconnected clients, expired approvals, and interrupted batches, without depending on a particular client's scheduling feature.

## Application services and MCP operations

Keep provider operations, inbox processing, accounting validation, and archive naming in protocol-neutral services. The MCP adapter supplies the live user/organization context and invokes those services. A future API worker must supply its own explicitly authorized actor context and use the same services; it cannot bypass MCP-era accounting or tenant controls.

The following tools are implemented. The catalog also includes `finlynq_daily_list_document_storage` and `finlynq_daily_upload_inbox_document`.

| Tool | Responsibility |
| --- | --- |
| `finlynq_daily_sync_document_inbox` | Discover a bounded page of provider changes and persist pending items. |
| `finlynq_daily_list_document_inbox` | List items by processing status without returning file contents. |
| `finlynq_daily_claim_inbox_document` | Claim one exact item/version; support lease renewal and safe expiry. |
| `finlynq_daily_read_inbox_document` | Return authorized, scanned, version-bound content in a supported format. |
| `finlynq_daily_complete_inbox_document` | Validate the extraction/match and atomically save the resulting record association; enqueue deterministic filing. |
| `finlynq_daily_review_inbox_document` | Record unresolved fields, suspected duplication, or unsupported content for review. |
| `finlynq_daily_retry_document_filing` | Retry the already-recorded archive operation without repeating ingestion. |

Connection setup and expansion of drive access stay in secure browser settings. Provider refresh tokens and arbitrary destination URLs never become tool arguments or outputs. Apply current Daily/Setup policy, live membership, module permissions, tenant isolation, write gates, and exact-argument approvals. Mutating sync/claim operations must be classified as writes rather than bypassing policy as apparent reads. Persistent background filing runs only the previously authorized, fixed operation and rechecks connection and actor access before execution.

The existing MCP result wrapper is JSON/text-oriented. Implement and verify a content delivery path for actual PDFs and scanned images in each supported client, such as extracted text plus supported page-image content or authenticated resources. Do not claim client compatibility from metadata-only or base64-only tests. Any local text extraction/rendering must avoid persistent document files; unavailable extraction produces an explicit unsupported/review outcome, never a hidden paid API fallback.

## Durable state, duplicates, and integrity

- Store provider, connection, drive, folder and file IDs, provider content version, SHA-256, size, MIME type, original name, current canonical name, and legal entity. Folder paths are presentation, not record identity.
- Use states such as `PENDING`, `CLAIMED`, `NEEDS_REVIEW`, `READY_TO_FILE`, `FILED`, and `FILING_FAILED`, with versioned transitions, lease ownership, bounded retries, and safe errors. A revoked or missing source remains visible with an actionable reason.
- Bind every completion to the exact claimed content version/checksum. If content changes during processing, reject stale results and queue the new version. Archive renaming must not itself trigger another ingestion.
- Deduplicate exact content within the organization and detect possible duplicate invoices by supplier, invoice number, and currency, with amounts/dates as supporting evidence. Different scans require business matching; identical files can still legitimately support several records. Never silently discard originals based on a heuristic match.
- Use stable operation keys and unique constraints so concurrent clients and retries cannot duplicate records or evidence links. Persist filing intent with the successful database transaction. Provider moves and database writes are not one atomic transaction; reconcile after an uncertain provider response before retrying.
- Preserve source bytes, original names, and the processing audit trail. Check integrity again when serving archived evidence and report external changes or deletion rather than silently accepting a replacement.
- Treat document text as untrusted data. It cannot alter tool permissions, processing instructions, organization routing, or allowed storage destinations.

## Folder and filename convention

Use a dedicated connection root with sibling inbox and archive folders. Review is a status; originals stay in Inbox. For OneDrive app-folder access, these live under the provider's application root.

```text
FinLynQ/
  Example Company/
    Inbox/
    Archive/
      2026/
        09/
          Purchase Invoices/
          Sales Invoices/
          Receipts/
          Statements/
          Other/
```

Use the validated document date for the archive year/month, not the upload date or accounting posting period. Unknown dates/entities require review. Review status is stored in FinLynQ; moving a file to `Needs Review` is a separately tracked operation, not the source of workflow state. Start without supplier subfolders to keep browsing manageable.

Invoice example:

```text
2026-09-04__Acme-Supplies__INV-1042__CAD-158.20__FLQ-<item UUID>.pdf
```

Generate names deterministically from validated fields using provider-safe characters and bounded lengths. Preserve the extension and include a collision-checked FinLynQ reference. Define type-specific templates for receipts, statements, and other documents without inventing invoice numbers, totals, or dates. Store the original filename and internal full ID even when the display name is shortened. Never overwrite an unrelated file. The initial release supports provider filename search and app status/connection filters. App-side search of encrypted metadata is deferred.

Keep inbox and archive in the same connected drive for the first release. Cross-drive/provider transfers need a separate copy, verification, and source-removal workflow. A rename or move must preserve the original bytes.

## Provider and retention boundaries

Google's `drive.file` scope grants per-file access. Do not promise unattended discovery of every externally uploaded child just because the user selected a folder. Resolve and test the consent design for this exact workflow; broader Drive access may require restricted-scope verification. App-level folder filtering is not a provider-enforced folder permission.

OneDrive's `Files.ReadWrite.AppFolder` permission includes files users add to the application folder. Validate list/read/move behavior, account types, and permissions for the chosen endpoints before expanding beyond that folder. Use provider-supported change tracking or bounded enumeration according to the granted scope; persist cursors and renew expiring notifications if background discovery is added.

Current evidence is encrypted in PostgreSQL, limited to PDF/PNG/JPEG up to 2 MiB, scanned before acceptance, and linked to immutable source-document versions. Introduce explicit storage backends so existing assets continue to download correctly while new cloud assets use external references. Retain the present format/size bounds initially and route unsupported files to review. Dedicated ingestion of other formats is later work.

Externally stored files remain mutable and removable by their owners. Record an integrity baseline and clear availability state; metadata/audit backups are not backups of external file bytes. Decide explicitly whether cloud files remain ordinary readable PDFs/images or use application encryption: existing organization-key encryption cannot be silently claimed for readable provider files. Do not delete or migrate existing database evidence as part of introducing cloud storage. Any migration requires verified copies and a separate retained-history design compatible with the append-only database controls.

## Delivery slices and acceptance

1. Provider consent proof, organization storage settings, external evidence backend, and authorized download; preserve legacy attachments. Prove externally dropped files can actually be discovered with the granted permissions.
2. On-demand inbox sync, durable state/leases, validated client content delivery, duplicate detection, and MCP ingestion into drafts or supporting associations. Demonstrate both a text PDF and a scanned image in the intended Codex/ChatGPT clients without FinLynQ model API calls.
3. Deterministic naming, archive moves, review UI, and filing recovery. Verify two competing clients, interrupted processing, an expired lease, revocation, changed content, and a provider move that succeeds before the response is lost. Confirm no duplicate bills or overwritten files.
4. Optional metadata-only background discovery. Future paid/API automation is a separate product decision: add an adapter to these same services only when explicitly enabled, with usage limits and its own authorization design.

No model SDK, API-key setting, model request, or hosted AI worker is needed to ship slices 1–3. Free operation still has hosting, database, scanning, bandwidth, and provider request costs; use bounded files, batches, and retries rather than promising unlimited ingestion.

## References

- [Remote MCP accounting plan](remote-mcp-accounting-agent-plan-2026-09.md) and [current evidence behavior](../operations/document-evidence-and-settlements.md).
- [Google Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [change notifications](https://developers.google.com/workspace/drive/api/guides/push).
- [OneDrive app-folder permissions](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder) and [delta tracking](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0).
- [OpenAI remote MCP support](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) and [client scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app). These document extension options, not a hosted processing feature in this release.
