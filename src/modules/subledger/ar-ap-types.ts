import type { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  createBusinessDocumentSchema,
  editBusinessDocumentSchema,
  issueBusinessDocumentSchema,
  recordSettlementSchema,
  voidBusinessDocumentSchema,
  voidSettlementSchema,
  type SubledgerOwnerModule,
  type SubledgerSourceSnapshot,
} from "./document-model";

export type SourceDocumentStatus = "DRAFT" | "POSTED" | "VOIDED";

export type SourceDocumentRow = Readonly<{
  id: string;
  organization_id: string;
  legal_entity_id: string;
  owner_module: SubledgerOwnerModule;
  source_type: string;
  source_number: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: unknown;
  content_hash: string;
  command_hash: string | null;
  supersedes_source_document_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: Date | string;
}>;

export type SubledgerDocumentRecord = Readonly<{
  id: string;
  organizationId: string;
  legalEntityId: string;
  ownerModule: SubledgerOwnerModule;
  sourceType: string;
  sourceNumber: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: SubledgerSourceSnapshot;
  contentHash: string;
  supersedesSourceDocumentId: string | null;
  voidReason: string | null;
  createdBy: string | null;
  createdAt: string;
}>;

export type CreateBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createBusinessDocumentSchema>;

export type EditBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof editBusinessDocumentSchema>;

export type IssueBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof issueBusinessDocumentSchema>;

export type VoidBusinessDocumentCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof voidBusinessDocumentSchema>;

export type RecordSettlementCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof recordSettlementSchema>;

export type VoidSettlementCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof voidSettlementSchema>;

export type DocumentMutationResult = Readonly<{
  document: SubledgerDocumentRecord;
  idempotentReplay: boolean;
}>;

export type IssuedDocumentResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  subledgerEventId: string;
  openItemId: string;
}>;

export type SettlementResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  subledgerEventId: string;
  allocationIds: readonly string[];
}>;

export type VoidedDocumentResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  openItemVoidEventId: string;
}>;

export type VoidedSettlementResult = DocumentMutationResult & Readonly<{
  journalId: string;
  journalNumber: number;
  reversedAllocationIds: readonly string[];
}>;

export type ListCurrentDocumentsCommand = Readonly<{
  context: TenantTransactionContext;
  ownerModule: SubledgerOwnerModule;
  statuses?: readonly SourceDocumentStatus[];
  limit?: number;
}>;

export type GetCurrentDocumentCommand = Readonly<{
  context: TenantTransactionContext;
  ownerModule: SubledgerOwnerModule;
  sourceType: string;
  sourceNumber: string;
}>;

export type AccountingSetup = Readonly<{
  functional_currency: string;
  period_state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
  starts_on: string;
  ends_on: string;
  party_role: "CUSTOMER" | "SUPPLIER";
  control_account_id: string;
  party_currency: string | null;
}>;

export type AccountCombinationRow = Readonly<{
  id: string;
  account_id: string;
  account_class: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  control_kind: "NONE" | "AR" | "AP";
}>;

export type TaxPackVersionRow = Readonly<{
  id: string;
  pack_key: string;
  version: string;
  effective_from: string;
  effective_to: string | null;
}>;

export type EntityTaxRegistrationRow = Readonly<{
  id: string;
  regime_key: string;
  destination_country: string | null;
  destination_region: string | null;
  destination_city: string | null;
  location_code: string | null;
  valid_from: string;
  valid_to: string | null;
}>;

export const SOURCE_TYPES_BY_OWNER: Readonly<Record<SubledgerOwnerModule, readonly string[]>> = {
  receivables: ["receivables.sales-invoice", "receivables.customer-receipt"],
  payables: ["payables.supplier-bill", "payables.supplier-payment"],
};

export type LockedOpenItemRow = Readonly<{
  id: string;
  ledger_id: string;
  party_account_id: string;
  transaction_currency: string;
  original_transaction_amount: string;
  original_functional_amount: string;
  allocated_transaction_amount: string;
  allocated_carrying_amount: string;
  source_type: string;
  source_fx_source: string | null;
  source_fx_effective_at: string | null;
  void_event_id: string | null;
}>;

export type CalculatedSettlementAllocation = Readonly<{
  openItemId: string;
  transactionAmount: string;
  carryingFunctionalAmount: string;
  settlementFunctionalAmount: string;
  realizedFxFunctional: string;
  carryingFxRate: string;
  carryingFxSource: string;
  carryingFxEffectiveAt: string;
}>;

export type OriginalJournalRow = Readonly<{
  id: string;
  status: string;
  functional_currency: string;
}>;

export type OriginalJournalLineRow = Readonly<{
  account_combination_id: string;
  debit_functional: string;
  credit_functional: string;
  transaction_currency: string;
  debit_transaction: string;
  credit_transaction: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_effective_at: Date | string;
  party_account_id: string | null;
  subledger_event_id: string | null;
  tax_snapshot_id: string | null;
  memo: string | null;
}>;

export type SettlementAllocationRow = Readonly<{
  id: string;
  open_item_id: string;
  transaction_currency: string;
  transaction_amount: string;
  carrying_functional_amount: string;
  settlement_functional_amount: string;
  realized_fx_functional: string;
  settlement_fx_rate: string;
  fx_rate_source: string;
  fx_rate_effective_at: Date | string;
}>;
