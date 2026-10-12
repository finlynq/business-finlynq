import "server-only";

import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  bankStatementExtractionSchema,
  previewBankStatementExtraction,
} from "@/modules/banking/statement-import-model";
import { importFiledStatement, importFiledStatementSchema, readFiledStatement, readFiledStatementSchema } from "@/modules/document-storage/filed-statement";
import { mcpMutationContext } from "./oauth-store";
import { formatInboxPage } from "./inbox-tools";
import { defineMcpTool } from "./tool-types";

export const STATEMENT_MCP_TOOLS = [
  defineMcpTool({
    policy: { name: "finlynq_daily_read_filed_bank_evidence", group: "DAILY", access: "READ",
      permission: PERMISSIONS.readBanking, permissionsAny: [PERMISSIONS.readPayables, PERMISSIONS.readReceivables] },
    title: "Read an already-filed bank export",
    description: "Read a bounded row page from an existing filed CSV, TSV, TXT, XLS, or XLSX evidence asset linked to an exact source-document version. Requires the filed inbox item, evidence asset, source-document version, and SHA-256. Reuses the original cloud file and does not claim or upload a second copy. Read every page before previewing the exact statement extraction.",
    inputSchema: readFiledStatementSchema,
    invoke: (args, runtime) => readFiledStatement(mcpMutationContext(runtime.principal, runtime.requestId), args),
    formatResult: formatInboxPage,
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_import_filed_bank_evidence", group: "DAILY", access: "WRITE",
      permission: PERMISSIONS.prepareBankReconciliation, permissionsAny: [PERMISSIONS.readPayables, PERMISSIONS.readReceivables] },
    title: "Import an already-filed bank export",
    description: "Import reviewed bank observations from an existing FILED inbox item and its exact linked evidence asset, with no new cloud file or bill. Requires banking.sync, banking.reconcile.prepare, and read access to the original bill or invoice. Supply the unchanged previewHash, extraction, account mapping, source SHA-256, confirmation, and permanent reason. TRANSACTION_EXPORT creates observations without invented balances; STATEMENT_BALANCES requires actual opening and closing balances. The item, asset, source link, storage grant, and checksum are rechecked before the idempotent import. No journal is posted.",
    inputSchema: importFiledStatementSchema,
    idempotent: true,
    openWorld: true,
    invoke: (args, runtime) => importFiledStatement(mcpMutationContext(runtime.principal, runtime.requestId, args.reason), args),
  }),
  defineMcpTool({
    policy: {
      name: "finlynq_daily_preview_bank_statement_import",
      group: "DAILY",
      access: "READ",
      permission: PERMISSIONS.readBanking,
    },
    title: "Preview a bank-statement file import",
    description: "Validate a bounded extraction from a claimed PDF, CSV, TSV, TXT, XLS, or XLSX bank or credit-card file. Read every row page before extraction. Use STATEMENT_BALANCES with exact opening/closing balances to create a draft reconciliation, or TRANSACTION_EXPORT without balances to import observations only until balance evidence is available. Each positive source amount must declare whether it increases or decreases the account's economic balance; sourceKind is descriptive and never determines the sign. Returns normalized economic signs, stable row fingerprints, exclusions, and a previewHash. This stores nothing and never posts a journal. Review the result, then use complete_inbox_document with IMPORT_STATEMENT and the unchanged previewHash.",
    inputSchema: bankStatementExtractionSchema,
    invoke: (args) => previewBankStatementExtraction(args),
  }),
];
