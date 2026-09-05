import "server-only";

import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  bankStatementExtractionSchema,
  previewBankStatementExtraction,
} from "@/modules/banking/statement-import-model";
import { defineMcpTool } from "./tool-types";

export const STATEMENT_MCP_TOOLS = [
  defineMcpTool({
    policy: {
      name: "finlynq_daily_preview_bank_statement_import",
      group: "DAILY",
      access: "READ",
      permission: PERMISSIONS.readBanking,
    },
    title: "Preview a bank-statement file import",
    description: "Validate a bounded extraction from a claimed PDF, CSV, TSV, TXT, XLS, or XLSX bank or credit-card statement. Each positive source amount must declare whether it increases or decreases the account's economic balance; sourceKind is descriptive and never determines the sign. Returns normalized economic signs, exact balance proof, stable row fingerprints, exclusions, and a previewHash. This stores nothing and never posts a journal. Review the result, then use complete_inbox_document with IMPORT_STATEMENT and the unchanged previewHash.",
    inputSchema: bankStatementExtractionSchema,
    invoke: (args) => previewBankStatementExtraction(args),
  }),
];
