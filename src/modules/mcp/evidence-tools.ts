import "server-only";

import { z } from "zod";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { downloadPostedJournalEvidence, linkPostedJournalEvidence, listPostedJournalEvidence } from "@/modules/ledger/journal-evidence";
import { downloadPostedJournalEvidenceSchema, listPostedJournalEvidenceSchema, postedJournalEvidenceLinkSchema } from "@/modules/ledger/journal-evidence-model";
import { attachEvidenceSchema, detachEvidenceSchema, uploadEvidenceSchema } from "@/modules/subledger/evidence-model";
import {
  attachDocumentEvidence,
  detachDocumentEvidence,
  downloadBankStatementEvidence,
  downloadDocumentEvidence,
  uploadDocumentEvidence,
} from "@/modules/subledger/evidence-service";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool } from "./tool-types";

const managePermissions = [PERMISSIONS.managePayables, PERMISSIONS.manageReceivables];
export const EVIDENCE_MCP_TOOLS = [
  defineMcpTool({
    policy: { name: "finlynq_daily_link_posted_journal_evidence", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal },
    title: "Link an original document to posted journals",
    description: "Add one verified existing evidence asset to one or more exact POSTED journals without creating or changing accounting. Use list_journals/get_journal and list_posted_journal_evidence first for target IDs, frozen content hashes, and evidence revisions. Cloud assets require their exact FILED inboxItemId; a claimed inbox original can instead use complete_inbox_document LINK_POSTED to save, link, and file it once. All targets must share an entity and ledger; each target and asset is authorized again at write time. Preserve original document date, reference, currency, and total even when split journals have different dates or amounts. Reuse identical arguments and idempotencyKey on retry.",
    inputSchema: postedJournalEvidenceLinkSchema,
    idempotent: true,
    invoke: (args, runtime) => linkPostedJournalEvidence(
      mcpMutationContext(runtime.principal, runtime.requestId, args.reason), args),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_list_posted_journal_evidence", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "List evidence on a posted journal",
    description: "Return the journal's evidence revision, immutable link history, original document metadata, SHA-256, scan result, and authorized download links without changing accounting. Module-read permission is checked for every asset.",
    inputSchema: listPostedJournalEvidenceSchema,
    invoke: (args, runtime) => listPostedJournalEvidence(
      mcpMutationContext(runtime.principal, runtime.requestId), args.journalId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_download_posted_journal_evidence", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Download evidence linked to a journal",
    description: "Download the exact evidence asset linked to a tenant-owned journal. Rechecks current journal, module, and storage permissions, the immutable link, provider location, size, and SHA-256 before returning bounded base64 content.",
    inputSchema: downloadPostedJournalEvidenceSchema,
    invoke: async (args, runtime) => {
      const result = await downloadPostedJournalEvidence(
        mcpMutationContext(runtime.principal, runtime.requestId), args.journalId, args.assetId);
      try { return { ...result.metadata, contentBase64: result.bytes.toString("base64") }; }
      finally { result.bytes.fill(0); }
    },
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_upload_document_evidence", group: "DAILY", access: "WRITE", permissionsAny: managePermissions },
    title: "Upload source-document evidence",
    description: "Legacy database storage: upload up to 2 MiB of PDF, PNG, or JPEG evidence as canonical base64, with filename, exact byteSize, SHA-256, and idempotencyKey. For Google Drive/OneDrive storage use finlynq_daily_upload_inbox_document instead. This tool stores scanned, organization-encrypted bytes in PostgreSQL. Returns an assetId to attach to the exact current invoice/bill draft version.",
    inputSchema: uploadEvidenceSchema,
    idempotent: true,
    invoke: (args, runtime) => uploadDocumentEvidence({
      context: mcpMutationContext(runtime.principal, runtime.requestId, "Upload source-document evidence"), ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_attach_document_evidence", group: "DAILY", access: "WRITE", permissionsAny: managePermissions },
    title: "Attach evidence to an invoice or bill draft",
    description: "Link an uploaded tenant-owned assetId as INVOICE, RECEIPT, or SUPPORTING evidence. Requires the exact current DRAFT version; creates a new immutable version. Reuse the same idempotencyKey and arguments on retry. get_document returns metadata and authorized download links, not file contents.",
    inputSchema: attachEvidenceSchema,
    idempotent: true,
    invoke: (args, runtime) => attachDocumentEvidence({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_detach_document_evidence", group: "DAILY", access: "WRITE", permissionsAny: managePermissions },
    title: "Detach evidence from a draft",
    description: "Remove a link only from the exact current DRAFT version. Creates a new version; the asset and all historical source-version links remain immutable and retained. Posted and voided evidence cannot be detached.",
    inputSchema: detachEvidenceSchema,
    idempotent: true,
    destructive: true,
    invoke: (args, runtime) => detachDocumentEvidence({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args,
    }),
  }),
  defineMcpTool({
    policy: {
      name: "finlynq_daily_download_bank_statement_evidence",
      group: "DAILY",
      access: "READ",
      permission: PERMISSIONS.readBanking,
    },
    title: "Download linked bank-statement evidence",
    description: "Download the evidence asset linked by an exact tenant-owned statementImportId and evidence assetId. Rechecks live banking.read permission, the immutable import-to-asset link, active storage connection, provider boundary, size, and SHA-256 before and after cloud transfer. An arbitrary or mismatched asset is rejected. MCP_RETRYABLE includes retryAfterSeconds for bounded retries; reuse the same identifiers.",
    inputSchema: z.object({
      statementImportId: z.uuid(),
      assetId: z.uuid(),
    }).strict(),
    invoke: async (args, runtime) => {
      const result = await downloadBankStatementEvidence({
        context: mcpMutationContext(runtime.principal, runtime.requestId),
        ...args,
      });
      try {
        return {
          ...result.metadata,
          statementImportId: args.statementImportId,
          contentBase64: result.bytes.toString("base64"),
        };
      } finally {
        result.bytes.fill(0);
      }
    },
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_download_document_evidence", group: "DAILY", access: "READ", permissionsAny: [PERMISSIONS.readPayables, PERMISSIONS.readReceivables] },
    title: "Download linked document evidence",
    description: "Explicitly download one evidence asset linked to a specific immutable sourceDocumentId. Rechecks tenant, live module-read authorization, and the exact version link before and after cloud transfer. Returns metadata and bounded contentBase64. Concurrent reads are supported. MCP_RETRYABLE includes retryAfterSeconds for bounded retries; reuse the same arguments. Use get_document for metadata-only inspection.",
    inputSchema: z.object({ assetId: z.uuid(), sourceDocumentId: z.uuid() }).strict(),
    invoke: async (args, runtime) => {
      const result = await downloadDocumentEvidence({
        context: mcpMutationContext(runtime.principal, runtime.requestId), ...args,
      });
      try { return { ...result.metadata, contentBase64: result.bytes.toString("base64") }; }
      finally { result.bytes.fill(0); }
    },
  }),
];
