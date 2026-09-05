import "server-only";
import { EVIDENCE_MCP_TOOLS } from "./evidence-tools";

import { z } from "zod";
import { validateSettlementFunding } from "@/modules/subledger/settlement-funding";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { createManualJournal, reversePostedJournal } from "@/modules/ledger/journal-service";
import { postJournal } from "@/modules/ledger/posting-service";
import { approveSubmittedJournal, submitJournalForApproval } from "@/modules/ledger/journal-workflow-service";
import {
  loadManualJournalOptions,
  loadTenantJournalDetail,
  loadTenantJournalWorkspace,
} from "@/modules/ledger/tenant-workspace";
import {
  balanceSheetRows,
  loadAccountInquiry,
  loadAccountingOverview,
  loadReportDimensions,
  loadTaxDeterminations,
  loadTrialBalance,
  profitAndLossRows,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import {
  createBusinessDocumentDraft,
  editBusinessDocumentDraft,
  getCurrentSubledgerDocument,
  issueBusinessDocument,
  listCurrentSubledgerDocuments,
  recordCustomerReceiptOrSupplierPayment,
  voidIssuedBusinessDocument,
  voidSettlementAndReverseAllocations,
} from "@/modules/subledger/ar-ap-service";
import {
  createBusinessDocumentSchema,
  editBusinessDocumentSchema,
  issueBusinessDocumentSchema,
  validateEditBusinessDocumentFxMode,
  recordSettlementSchema,
  voidBusinessDocumentSchema,
  voidSettlementSchema,
} from "@/modules/subledger/document-model";
import { loadBankingWorkspace } from "@/modules/banking/banking-workspace";
import {
  createBankMatchAllocation,
  createBankReconciliation,
  syncSimpleFin,
  transitionBankReconciliation,
  voidBankMatchAllocation,
} from "@/modules/banking/banking-service";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolDefinition, type McpToolRuntime } from "./tool-types";

const emptySchema = z.object({}).strict();
const exactAmountSchema = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const journalLineSchema = z.object({
  accountCombinationId: z.uuid(),
  debitFunctional: exactAmountSchema,
  creditFunctional: exactAmountSchema,
  transactionCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  debitTransaction: exactAmountSchema,
  creditTransaction: exactAmountSchema,
  fxRate: z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/),
  fxRateSource: z.string().trim().min(1).max(100),
  fxRateEffectiveAt: z.iso.datetime({ offset: true }),
  memo: z.string().trim().max(500).optional(),
}).strict();
const createJournalSchema = z.object({
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  purpose: z.enum(["ROUTINE", "ADJUSTING", "OPENING", "CLOSING", "REVALUATION", "TAX_ADJUSTMENT"]),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
  lines: z.array(journalLineSchema).min(2).max(200),
}).strict();

const reportSelectionSchema = z.object({
  entityId: z.uuid().optional(),
  basis: z.enum(["period", "date"]).default("period"),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  fromPeriodId: z.uuid().optional(),
  toPeriodId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  accountCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/).optional(),
  segmentFilters: z.record(z.string(), z.string().trim().min(1).max(50)).optional(),
}).strict();

async function reportSelection(args: z.output<typeof reportSelectionSchema>, runtime: McpToolRuntime) {
  const dimensions = await loadReportDimensions(runtime.sessionPrincipal);
  const selection = resolveReportSelection(dimensions, {
    entity: args.entityId,
    basis: args.basis,
    from: args.from,
    to: args.to,
    fromPeriod: args.fromPeriodId,
    toPeriod: args.toPeriodId,
    account: args.accountId,
    accountCode: args.accountCode,
    segmentFilters: args.segmentFilters,
  });
  if (!selection) throw new Error("No active legal entity and primary ledger are available for reporting");
  return selection;
}

const createDocumentInput = createBusinessDocumentSchema.omit({ kind: true });
const editDocumentInput = z.object(editBusinessDocumentSchema.shape)
  .strict()
  .omit({ kind: true })
  .superRefine(validateEditBusinessDocumentFxMode);
const issueDocumentInput = issueBusinessDocumentSchema.omit({ kind: true });
const voidDocumentInput = voidBusinessDocumentSchema.omit({ kind: true });
const settlementInput = z.object(recordSettlementSchema.shape).omit({ kind: true }).strict().superRefine(validateSettlementFunding);
const voidSettlementInput = voidSettlementSchema.omit({ kind: true });

function createDocumentTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "SALES_INVOICE" | "SUPPLIER_BILL";
  permission: typeof PERMISSIONS.manageReceivables | typeof PERMISSIONS.managePayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: createDocumentInput,
    invoke: (args, runtime) => createBusinessDocumentDraft({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.description),
      ...args,
      kind: input.kind,
    }),
  });
}

function editDocumentTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "SALES_INVOICE" | "SUPPLIER_BILL";
  permission: typeof PERMISSIONS.manageReceivables | typeof PERMISSIONS.managePayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: editDocumentInput,
    invoke: (args, runtime) => editBusinessDocumentDraft({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.description),
      ...args,
      kind: input.kind,
    }),
  });
}

function issueDocumentTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "SALES_INVOICE" | "SUPPLIER_BILL";
  permission: typeof PERMISSIONS.postReceivables | typeof PERMISSIONS.postPayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: issueDocumentInput,
    invoke: (args, runtime) => issueBusinessDocument({
      context: mcpMutationContext(runtime.principal, runtime.requestId, `Issue ${input.kind.toLowerCase()}`),
      ...args,
      kind: input.kind,
    }),
  });
}

function voidDocumentTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "SALES_INVOICE" | "SUPPLIER_BILL";
  permission: typeof PERMISSIONS.voidReceivables | typeof PERMISSIONS.voidPayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: voidDocumentInput,
    destructive: true,
    invoke: (args, runtime) => voidIssuedBusinessDocument({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason),
      ...args,
      kind: input.kind,
    }),
  });
}

function settlementTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "CUSTOMER_RECEIPT" | "SUPPLIER_PAYMENT";
  permission: typeof PERMISSIONS.settleReceivables | typeof PERMISSIONS.settlePayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: settlementInput,
    invoke: (args, runtime) => recordCustomerReceiptOrSupplierPayment({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.description),
      ...args,
      kind: input.kind,
    }),
  });
}

function voidSettlementTool(input: Readonly<{
  name: string;
  title: string;
  description: string;
  kind: "CUSTOMER_RECEIPT" | "SUPPLIER_PAYMENT";
  permission: typeof PERMISSIONS.voidReceivables | typeof PERMISSIONS.voidPayables;
}>): McpToolDefinition {
  return defineMcpTool({
    policy: { name: input.name, group: "DAILY", access: "WRITE", permission: input.permission },
    title: input.title,
    description: input.description,
    inputSchema: voidSettlementInput,
    destructive: true,
    invoke: (args, runtime) => voidSettlementAndReverseAllocations({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason),
      ...args,
      kind: input.kind,
    }),
  });
}

export const DAILY_MCP_TOOLS: readonly McpToolDefinition[] = [
  ...EVIDENCE_MCP_TOOLS,
  defineMcpTool({
    policy: { name: "finlynq_daily_get_accounting_context", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Get accounting entry context",
    description: "Use before creating a journal. Returns allowed entities, ledgers, open periods, functional currencies, and postable account-combination IDs for the connected organization.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => loadManualJournalOptions(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_list_journals", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "List journals",
    description: "Find journal entries in the connected organization by human search text and optional entity. Returns register rows and canonical content hashes used by later workflow actions.",
    inputSchema: z.object({ search: z.string().trim().max(100).default(""), entityId: z.uuid().nullable().default(null), page: z.number().int().min(1).max(10000).default(1) }).strict(),
    invoke: (args, runtime) => loadTenantJournalWorkspace(runtime.sessionPrincipal, args.search, args.entityId, args.page),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_get_journal", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Get journal details",
    description: "Get one journal header and all lines by journal ID. Use this to verify exact amounts and the current workflow state before submit, approve, post, or reverse.",
    inputSchema: z.object({ journalId: z.uuid() }).strict(),
    invoke: (args, runtime) => loadTenantJournalDetail(runtime.sessionPrincipal, args.journalId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_create_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal },
    title: "Create balanced journal draft",
    description: "Create an idempotent manual general-ledger draft. Debit and credit values are exact decimal strings and must balance in functional currency; use account-combination IDs from the accounting context tool.",
    inputSchema: createJournalSchema,
    invoke: (args, runtime) => createManualJournal({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.description), ...args, origin: "MCP" }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_submit_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.submitJournal },
    title: "Submit journal for approval",
    description: "Freeze a manual journal draft for approval. Supply the content hash returned by journal reads when available so concurrent changes fail closed.",
    inputSchema: z.object({ journalId: z.uuid(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict(),
    invoke: (args, runtime) => submitJournalForApproval({ context: mcpMutationContext(runtime.principal, runtime.requestId, "Submit journal for approval"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_approve_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.approveJournal },
    title: "Approve submitted journal",
    description: "Approve the exact frozen journal version. The journal creator cannot approve their own journal; supply both the frozen content hash and approval version.",
    inputSchema: z.object({ journalId: z.uuid(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i), expectedApprovalVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(500) }).strict(),
    invoke: (args, runtime) => approveSubmittedJournal({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_post_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.postJournal },
    title: "Post journal",
    description: "Post a manual ledger journal using FinLynQ's balance, period, account, workflow, permission, and content-hash controls. This creates permanent accounting history.",
    inputSchema: z.object({ journalId: z.uuid(), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i), reason: z.string().trim().min(5).max(500) }).strict(),
    invoke: (args, runtime) => postJournal({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), journalId: args.journalId, expectedContentHash: args.expectedContentHash }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_reverse_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.reverseJournal },
    title: "Reverse posted journal",
    description: "Create and post a linked full reversal for a posted manual journal. Posted history is never edited or deleted.",
    inputSchema: z.object({ originalJournalId: z.uuid(), periodId: z.uuid(), accountingDate: z.iso.date(), description: z.string().trim().min(1).max(500), reason: z.string().trim().min(5).max(500), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    destructive: true,
    invoke: (args, runtime) => reversePostedJournal({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_list_documents", group: "DAILY", access: "READ", permissionsAny: [PERMISSIONS.readReceivables, PERMISSIONS.readPayables] },
    title: "List invoices or bills",
    description: "List current sales invoices or supplier bills. Choose receivables or payables explicitly; results include immutable versions, status, snapshots, and content hashes.",
    inputSchema: z.object({ module: z.enum(["receivables", "payables"]), statuses: z.array(z.enum(["DRAFT", "POSTED", "VOIDED"])).min(1).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    invoke: (args, runtime) => {
      const required = args.module === "receivables" ? PERMISSIONS.readReceivables : PERMISSIONS.readPayables;
      if (!runtime.snapshot.permissions.has(required)) throw new Error(`${args.module} read permission is required`);
      return listCurrentSubledgerDocuments({ context: mcpMutationContext(runtime.principal, runtime.requestId), ownerModule: args.module, statuses: args.statuses, limit: args.limit });
    },
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_get_document", group: "DAILY", access: "READ", permissionsAny: [PERMISSIONS.readReceivables, PERMISSIONS.readPayables] },
    title: "Get invoice, bill, receipt, or payment",
    description: "Get the current immutable version of one AR or AP source document by document kind and source number.",
    inputSchema: z.object({ kind: z.enum(["SALES_INVOICE", "SUPPLIER_BILL", "CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"]), sourceNumber: z.string().trim().min(1).max(80) }).strict(),
    invoke: (args, runtime) => {
      const receivable = args.kind === "SALES_INVOICE" || args.kind === "CUSTOMER_RECEIPT";
      const permission = receivable ? PERMISSIONS.readReceivables : PERMISSIONS.readPayables;
      if (!runtime.snapshot.permissions.has(permission)) throw new Error(`${receivable ? "Receivables" : "Payables"} read permission is required`);
      return getCurrentSubledgerDocument({
        context: mcpMutationContext(runtime.principal, runtime.requestId),
        ownerModule: receivable ? "receivables" : "payables",
        sourceType: args.kind === "SALES_INVOICE" ? "receivables.sales-invoice"
          : args.kind === "SUPPLIER_BILL" ? "payables.supplier-bill"
            : args.kind === "CUSTOMER_RECEIPT" ? "receivables.customer-receipt" : "payables.supplier-payment",
        sourceNumber: args.sourceNumber,
      });
    },
  }),
  createDocumentTool({ name: "finlynq_daily_create_sales_invoice", title: "Create sales invoice draft", description: "Create an idempotent sales-invoice draft with exact invoice facts. Omit fx to resolve automatically: FinLynQ uses an eligible tenant-owned stored direct rate first, then the organization's selected provider source. Bank of Canada and ECB use official reference rates; Yahoo also requires its operator gate. If no permitted observation exists, the tool fails with FX_RATE_UNAVAILABLE before persistence. Supply explicit fx rate, source, and effective time to override automatic resolution for this invoice.", kind: "SALES_INVOICE", permission: PERMISSIONS.manageReceivables }),
  editDocumentTool({ name: "finlynq_daily_edit_sales_invoice", title: "Edit sales invoice draft", description: "Create a new immutable version of an existing sales-invoice draft. The exact current version is required. Set fxResolutionMode to PRESERVE and omit fx to carry the full current provenance when currency and accounting date are unchanged. Set RESOLVE and omit fx to run the organization's stored-first provider policy again. Set EXPLICIT and supply fx rate, source, and effective time for a client override; no permitted automatic observation fails with FX_RATE_UNAVAILABLE before persistence.", kind: "SALES_INVOICE", permission: PERMISSIONS.manageReceivables }),
  issueDocumentTool({ name: "finlynq_daily_issue_sales_invoice", title: "Issue sales invoice", description: "Issue and post the exact current sales-invoice draft, creating its tax evidence, journal, subledger event, and customer open item atomically.", kind: "SALES_INVOICE", permission: PERMISSIONS.postReceivables }),
  voidDocumentTool({ name: "finlynq_daily_void_sales_invoice", title: "Void sales invoice", description: "Void an issued sales invoice by creating immutable document and journal reversals in the selected open period.", kind: "SALES_INVOICE", permission: PERMISSIONS.voidReceivables }),
  createDocumentTool({ name: "finlynq_daily_create_supplier_bill", title: "Create supplier bill draft", description: "Create an idempotent supplier-bill draft with exact invoice facts. Omit fx to resolve automatically: FinLynQ uses an eligible tenant-owned stored direct rate first, then the organization's selected provider source. Bank of Canada and ECB use official reference rates; Yahoo also requires its operator gate. If no permitted observation exists, the tool fails with FX_RATE_UNAVAILABLE before persistence. Supply explicit fx rate, source, and effective time to override automatic resolution for this bill.", kind: "SUPPLIER_BILL", permission: PERMISSIONS.managePayables }),
  editDocumentTool({ name: "finlynq_daily_edit_supplier_bill", title: "Edit supplier bill draft", description: "Create a new immutable version of an existing supplier-bill draft. The exact current version is required. Set fxResolutionMode to PRESERVE and omit fx to carry the full current provenance when currency and accounting date are unchanged. Set RESOLVE and omit fx to run the organization's stored-first provider policy again. Set EXPLICIT and supply fx rate, source, and effective time for a client override; no permitted automatic observation fails with FX_RATE_UNAVAILABLE before persistence.", kind: "SUPPLIER_BILL", permission: PERMISSIONS.managePayables }),
  issueDocumentTool({ name: "finlynq_daily_issue_supplier_bill", title: "Issue supplier bill", description: "Issue and post the exact current supplier-bill draft, creating its tax evidence, journal, subledger event, and supplier open item atomically.", kind: "SUPPLIER_BILL", permission: PERMISSIONS.postPayables }),
  voidDocumentTool({ name: "finlynq_daily_void_supplier_bill", title: "Void supplier bill", description: "Void an issued supplier bill by creating immutable document and journal reversals in the selected open period.", kind: "SUPPLIER_BILL", permission: PERMISSIONS.voidPayables }),
  settlementTool({ name: "finlynq_daily_record_customer_receipt", title: "Record customer receipt", description: "Record an actual customer receipt and allocate it to specific receivable open items. Omit fx for stored-first automatic resolution under the organization's provider policy; no permitted observation fails with FX_RATE_UNAVAILABLE before persistence. Supply explicit fx rate, source, and effective time to override automatic resolution for this transaction. This records settlement evidence; it does not initiate a bank payment.", kind: "CUSTOMER_RECEIPT", permission: PERMISSIONS.settleReceivables }),
  settlementTool({ name: "finlynq_daily_record_supplier_payment", title: "Record supplier settlement", description: "Record supplier settlement evidence against exact payable open items. Omit fx for stored-first automatic resolution under the organization's provider policy; no permitted observation fails with FX_RATE_UNAVAILABLE before persistence. Supply explicit fx rate, source, and effective time to override automatic resolution for this transaction. Use settlementAccountCombinationId and settlementMethod BANK (non-control asset), CORPORATE_CARD, SHAREHOLDER_ADVANCE, EMPLOYEE_REIMBURSEMENT, or OTHER_NON_CASH (non-control liability). Legacy bankAccountCombinationId remains supported for BANK. This does not initiate a transfer or bank payment.", kind: "SUPPLIER_PAYMENT", permission: PERMISSIONS.settlePayables }),
  voidSettlementTool({ name: "finlynq_daily_void_customer_receipt", title: "Void customer receipt", description: "Reverse a recorded customer receipt and its exact open-item allocations without deleting accounting history.", kind: "CUSTOMER_RECEIPT", permission: PERMISSIONS.voidReceivables }),
  voidSettlementTool({ name: "finlynq_daily_void_supplier_payment", title: "Void supplier payment", description: "Reverse a recorded supplier payment and its exact open-item allocations without deleting accounting history.", kind: "SUPPLIER_PAYMENT", permission: PERMISSIONS.voidPayables }),
  defineMcpTool({
    policy: { name: "finlynq_daily_get_reporting_context", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Get financial reporting context",
    description: "Use before running a report. Returns legal entities, primary ledgers, periods, natural accounts, and enabled dimensions accepted by report tools.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => loadReportDimensions(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_trial_balance", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Run trial balance",
    description: "Run a trial balance for one entity, period/date range, optional natural account, and optional segment filters. Amounts are exact strings.",
    inputSchema: reportSelectionSchema,
    invoke: async (args, runtime) => loadTrialBalance(runtime.sessionPrincipal, await reportSelection(args, runtime)),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_balance_sheet", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Run balance sheet",
    description: "Return balance-sheet account rows plus calculated unclosed earnings for the selected entity and date or period range.",
    inputSchema: reportSelectionSchema,
    invoke: async (args, runtime) => balanceSheetRows(await loadTrialBalance(runtime.sessionPrincipal, await reportSelection(args, runtime))),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_profit_and_loss", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Run profit and loss",
    description: "Return revenue and expense activity for the selected entity and date or period range.",
    inputSchema: reportSelectionSchema,
    invoke: async (args, runtime) => profitAndLossRows(await loadTrialBalance(runtime.sessionPrincipal, await reportSelection(args, runtime))),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_account_inquiry", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Run account inquiry",
    description: "Return opening balance and posted journal-line activity for one natural account. Call the reporting context tool first to obtain entity and account IDs.",
    inputSchema: reportSelectionSchema.extend({ accountId: z.uuid() }),
    invoke: async (args, runtime) => loadAccountInquiry(runtime.sessionPrincipal, await reportSelection(args, runtime)),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_accounting_overview", group: "DAILY", access: "READ" },
    title: "Get accounting overview",
    description: "Summarize the accounting data the connected user can currently access: journal counts, tax-review counts, and open receivable/payable balances.",
    inputSchema: z.object({ entityId: z.uuid().nullable().default(null) }).strict(),
    invoke: (args, runtime) => loadAccountingOverview(runtime.sessionPrincipal, args.entityId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_tax_review_queue", group: "DAILY", access: "READ", permission: PERMISSIONS.readTax },
    title: "List tax determinations",
    description: "List posted and current-draft tax determinations, optionally only items that need manual review. This reports tax evidence and never files a return.",
    inputSchema: z.object({ reviewOnly: z.boolean().default(true) }).strict(),
    invoke: (args, runtime) => loadTaxDeterminations(runtime.sessionPrincipal, { reviewOnly: args.reviewOnly }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_banking_overview", group: "DAILY", access: "READ", permission: PERMISSIONS.readBanking },
    title: "Get banking and reconciliation workspace",
    description: "Return bank connections without credentials, observed accounts and transactions, matches, reconciliation proofs, rules, and suggested draft proposals.",
    inputSchema: z.object({ reconciliationId: z.uuid().optional() }).strict(),
    invoke: (args, runtime) => loadBankingWorkspace(runtime.sessionPrincipal, args.reconciliationId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_sync_bank_feed", group: "DAILY", access: "WRITE", permission: PERMISSIONS.syncBanking },
    title: "Synchronize bank feed",
    description: "Pull a bounded date window from an already-authorized SimpleFIN connection. Credentials remain encrypted inside FinLynQ and are never returned to the model.",
    inputSchema: z.object({ connectionId: z.uuid(), startOn: z.iso.date().optional(), endOn: z.iso.date().optional() }).strict(),
    openWorld: true,
    invoke: (args, runtime) => syncSimpleFin({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_create_bank_reconciliation", group: "DAILY", access: "WRITE", permission: PERMISSIONS.prepareBankReconciliation },
    title: "Create bank reconciliation",
    description: "Create an idempotent draft reconciliation for one mapped external account and statement range using exact opening and closing balances.",
    inputSchema: z.object({ externalAccountId: z.uuid(), statementStartOn: z.iso.date(), statementEndOn: z.iso.date(), openingBalance: z.string().trim().max(60), closingBalance: z.string().trim().max(60), idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
    invoke: (args, runtime) => createBankReconciliation({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_match_bank_transaction", group: "DAILY", access: "WRITE", permission: PERMISSIONS.prepareBankReconciliation },
    title: "Match bank transaction",
    description: "Allocate an exact amount from a current bank-observation version to a posted cash journal line inside a draft reconciliation.",
    inputSchema: z.object({ reconciliationId: z.uuid(), observationVersionId: z.uuid(), journalLineId: z.uuid(), allocatedAmount: exactAmountSchema, idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
    invoke: (args, runtime) => createBankMatchAllocation({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_void_bank_match", group: "DAILY", access: "WRITE", permission: PERMISSIONS.prepareBankReconciliation },
    title: "Void bank match",
    description: "Void one active match allocation while its reconciliation remains a draft. The original match remains in history.",
    inputSchema: z.object({ reconciliationId: z.uuid(), allocationId: z.uuid(), reason: z.string().trim().min(8).max(500) }).strict(),
    destructive: true,
    invoke: (args, runtime) => voidBankMatchAllocation({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_transition_bank_reconciliation", group: "DAILY", access: "WRITE", permissionsAny: [PERMISSIONS.prepareBankReconciliation, PERMISSIONS.reviewBankReconciliation] },
    title: "Advance or void bank reconciliation",
    description: "Submit, review, finalize, or void a reconciliation. Balance proof and current-user permissions are rechecked; finalized reconciliations are immutable.",
    inputSchema: z.object({ reconciliationId: z.uuid(), action: z.enum(["SUBMIT", "REVIEW", "FINALIZE", "VOID"]), reason: z.string().trim().min(8).max(500).optional() }).strict(),
    destructive: true,
    invoke: (args, runtime) => {
      const required = args.action === "REVIEW" || args.action === "FINALIZE" ? PERMISSIONS.reviewBankReconciliation : PERMISSIONS.prepareBankReconciliation;
      if (!runtime.snapshot.permissions.has(required)) throw new Error(`${required} permission is required`);
      if (args.action === "VOID") {
        if (!args.reason) throw new Error("A permanent void reason is required");
        return transitionBankReconciliation({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, reconciliationId: args.reconciliationId, action: "VOID", reason: args.reason });
      }
      return transitionBankReconciliation({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, reconciliationId: args.reconciliationId, action: args.action });
    },
  }),
];
