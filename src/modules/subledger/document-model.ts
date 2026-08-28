import { createHash } from "node:crypto";
import { z } from "zod";
import {
  exact,
  isQuantizedMoney,
  minorUnits,
  quantizeMoney,
  sumExact,
} from "@/kernel/money";
import { decideTax } from "@/modules/tax/engine";
import type { TaxDecision, TaxDirection, TaxFacts } from "@/modules/tax/types";

const positiveAmountSchema = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/).refine(
  (value) => exact(value).greaterThan(0),
  "Amount must be greater than zero",
);
const positiveRateSchema = z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/).refine(
  (value) => exact(value).greaterThan(0),
  "FX rate must be greater than zero",
);
const sourceNumberSchema = z.string().trim().toUpperCase().min(1).max(50)
  .regex(/^[A-Z0-9][A-Z0-9._/-]*$/);
const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const businessDocumentKindSchema = z.enum(["SALES_INVOICE", "SUPPLIER_BILL"]);
export type BusinessDocumentKind = z.infer<typeof businessDocumentKindSchema>;

export const settlementDocumentKindSchema = z.enum(["CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"]);
export type SettlementDocumentKind = z.infer<typeof settlementDocumentKindSchema>;

export type SubledgerOwnerModule = "receivables" | "payables";

export const DOCUMENT_KIND_POLICY: Readonly<Record<BusinessDocumentKind, Readonly<{
  ownerModule: SubledgerOwnerModule;
  sourceType: "receivables.sales-invoice" | "payables.supplier-bill";
  journalTypeKey: "receivables.sales-invoice" | "payables.supplier-bill";
  partyRole: "CUSTOMER" | "SUPPLIER";
  controlKind: "AR" | "AP";
  direction: TaxDirection;
}>>> = {
  SALES_INVOICE: {
    ownerModule: "receivables",
    sourceType: "receivables.sales-invoice",
    journalTypeKey: "receivables.sales-invoice",
    partyRole: "CUSTOMER",
    controlKind: "AR",
    direction: "SALE",
  },
  SUPPLIER_BILL: {
    ownerModule: "payables",
    sourceType: "payables.supplier-bill",
    journalTypeKey: "payables.supplier-bill",
    partyRole: "SUPPLIER",
    controlKind: "AP",
    direction: "PURCHASE",
  },
};

export const SETTLEMENT_KIND_POLICY: Readonly<Record<SettlementDocumentKind, Readonly<{
  ownerModule: SubledgerOwnerModule;
  sourceType: "receivables.customer-receipt" | "payables.supplier-payment";
  journalTypeKey: "receivables.customer-receipt" | "payables.supplier-payment";
  partyRole: "CUSTOMER" | "SUPPLIER";
  invoiceSourceType: "receivables.sales-invoice" | "payables.supplier-bill";
  position: "RECEIVABLE" | "PAYABLE";
}>>> = {
  CUSTOMER_RECEIPT: {
    ownerModule: "receivables",
    sourceType: "receivables.customer-receipt",
    journalTypeKey: "receivables.customer-receipt",
    partyRole: "CUSTOMER",
    invoiceSourceType: "receivables.sales-invoice",
    position: "RECEIVABLE",
  },
  SUPPLIER_PAYMENT: {
    ownerModule: "payables",
    sourceType: "payables.supplier-payment",
    journalTypeKey: "payables.supplier-payment",
    partyRole: "SUPPLIER",
    invoiceSourceType: "payables.supplier-bill",
    position: "PAYABLE",
  },
};

export const fxSnapshotSchema = z.object({
  rate: positiveRateSchema,
  source: z.string().trim().min(1).max(100),
  effectiveAt: z.iso.datetime({ offset: true }),
  quoteConvention: z.literal("FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT")
    .default("FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT"),
}).strict();

export const taxInputSchema = z.object({
  packKey: z.string().trim().min(1).max(100),
  category: z.enum([
    "STANDARD",
    "ZERO_RATED",
    "EXEMPT",
    "RESALE",
    "MARKETPLACE_COLLECTED",
    "OUT_OF_SCOPE",
  ]),
  destinationCountry: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  destinationRegion: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/),
  destinationCity: z.string().trim().min(1).max(100).optional(),
  locationCode: z.string().trim().min(1).max(50).optional(),
  registrationId: z.string().trim().min(1).max(200).optional(),
  evidenceReference: z.string().trim().min(1).max(200).optional(),
  recoverablePercent: z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/).optional(),
}).strict();

export const businessDocumentLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  accountCombinationId: z.uuid(),
  netAmount: positiveAmountSchema,
  tax: taxInputSchema,
}).strict();

export const businessDocumentInputSchema = z.object({
  kind: businessDocumentKindSchema,
  sourceNumber: sourceNumberSchema,
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  partyAccountId: z.uuid(),
  controlAccountCombinationId: z.uuid(),
  taxAccountCombinationId: z.uuid().optional(),
  fxRoundingAccountCombinationId: z.uuid().optional(),
  documentDate: z.iso.date(),
  accountingDate: z.iso.date(),
  periodId: z.uuid(),
  dueOn: z.iso.date(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  fx: fxSnapshotSchema,
  description: z.string().trim().min(1).max(500),
  lines: z.array(businessDocumentLineInputSchema).min(1).max(200),
}).strict();

export const createBusinessDocumentSchema = businessDocumentInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const editBusinessDocumentSchema = businessDocumentInputSchema.extend({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const issueBusinessDocumentSchema = z.object({
  kind: businessDocumentKindSchema,
  sourceNumber: sourceNumberSchema,
  expectedVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const voidBusinessDocumentSchema = z.object({
  kind: businessDocumentKindSchema,
  sourceNumber: sourceNumberSchema,
  expectedVersion: z.number().int().positive(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  reason: z.string().trim().min(5).max(500),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const settlementAllocationInputSchema = z.object({
  openItemId: z.uuid(),
  transactionAmount: positiveAmountSchema,
}).strict();

export const recordSettlementSchema = z.object({
  kind: settlementDocumentKindSchema,
  sourceNumber: sourceNumberSchema,
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  partyAccountId: z.uuid(),
  controlAccountCombinationId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  settlementDate: z.iso.date(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  amount: positiveAmountSchema,
  fx: fxSnapshotSchema,
  bankAccountCombinationId: z.uuid(),
  realizedFxGainAccountCombinationId: z.uuid(),
  realizedFxLossAccountCombinationId: z.uuid(),
  fxRoundingAccountCombinationId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500),
  allocations: z.array(settlementAllocationInputSchema).min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const voidSettlementSchema = z.object({
  kind: settlementDocumentKindSchema,
  sourceNumber: sourceNumberSchema,
  expectedVersion: z.number().int().positive(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  reason: z.string().trim().min(5).max(500),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const taxFactsSchema = z.object({
  direction: z.enum(["SALE", "PURCHASE"]),
  taxPointDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  taxableBasis: z.string(),
  destinationCountry: z.string().regex(/^[A-Z]{2}$/),
  destinationRegion: z.string(),
  destinationCity: z.string().optional(),
  locationCode: z.string().optional(),
  category: taxInputSchema.shape.category,
  registrationId: z.string().optional(),
  evidenceReference: z.string().optional(),
  recoverablePercent: z.string().optional(),
}).strict();

const taxComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  rate: z.string(),
  amount: z.string(),
  treatment: z.enum([
    "PAYABLE",
    "RECOVERABLE",
    "NONRECOVERABLE",
    "SELF_ASSESSED_PAYABLE",
    "DISCLOSURE_ONLY",
  ]),
}).strict();

export const taxDecisionSchema = z.object({
  status: z.enum([
    "APPLIED",
    "ZERO_RATED",
    "EXEMPT",
    "RESALE",
    "MARKETPLACE_COLLECTED",
    "OUT_OF_SCOPE",
    "MANUAL_REVIEW_REQUIRED",
  ]),
  packKey: z.string(),
  packVersion: z.string(),
  ruleKey: z.string(),
  jurisdiction: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  facts: taxFactsSchema,
  components: z.array(taxComponentSchema),
  totalTax: z.string(),
  rounding: z.literal("LINE_HALF_UP"),
  source: z.string(),
  reviewReason: z.string().optional(),
}).strict();

const businessDocumentSnapshotLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string(),
  accountCombinationId: z.uuid(),
  netAmount: z.string(),
  tax: taxInputSchema,
  taxDecision: taxDecisionSchema,
  taxDecisionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const businessDocumentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: businessDocumentKindSchema,
  ownerModule: z.enum(["receivables", "payables"]),
  sourceType: z.enum(["receivables.sales-invoice", "payables.supplier-bill"]),
  sourceNumber: sourceNumberSchema,
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  partyAccountId: z.uuid(),
  controlAccountCombinationId: z.uuid(),
  taxAccountCombinationId: z.uuid().nullable(),
  fxRoundingAccountCombinationId: z.uuid().nullable(),
  documentDate: z.iso.date(),
  accountingDate: z.iso.date(),
  periodId: z.uuid(),
  dueOn: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
  fx: fxSnapshotSchema,
  description: z.string(),
  lines: z.array(businessDocumentSnapshotLineSchema).min(1),
  subtotal: z.string(),
  taxTotal: z.string(),
  grossTotal: z.string(),
  grossFunctional: z.string(),
}).strict();

export const settlementSnapshotAllocationSchema = z.object({
  openItemId: z.uuid(),
  transactionAmount: z.string(),
  carryingFunctionalAmount: z.string(),
  settlementFunctionalAmount: z.string(),
  realizedFxFunctional: z.string(),
  carryingFxRate: z.string(),
}).strict();

export const settlementDocumentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: settlementDocumentKindSchema,
  ownerModule: z.enum(["receivables", "payables"]),
  sourceType: z.enum(["receivables.customer-receipt", "payables.supplier-payment"]),
  sourceNumber: sourceNumberSchema,
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  partyAccountId: z.uuid(),
  controlAccountCombinationId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  settlementDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
  amount: z.string(),
  settlementFunctionalAmount: z.string(),
  fx: fxSnapshotSchema,
  bankAccountCombinationId: z.uuid(),
  realizedFxGainAccountCombinationId: z.uuid(),
  realizedFxLossAccountCombinationId: z.uuid(),
  fxRoundingAccountCombinationId: z.uuid().nullable(),
  description: z.string(),
  allocations: z.array(settlementSnapshotAllocationSchema).min(1),
}).strict();

export const subledgerSourceSnapshotSchema = z.discriminatedUnion("kind", [
  businessDocumentSnapshotSchema,
  settlementDocumentSnapshotSchema,
]);

export type BusinessDocumentInput = z.infer<typeof businessDocumentInputSchema>;
export type BusinessDocumentSnapshot = z.infer<typeof businessDocumentSnapshotSchema>;
export type SettlementDocumentSnapshot = z.infer<typeof settlementDocumentSnapshotSchema>;
export type SubledgerSourceSnapshot = z.infer<typeof subledgerSourceSnapshotSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function moneyString(value: string | ReturnType<typeof exact>, currency: string): string {
  return quantizeMoney(value, currency).toFixed(minorUnits(currency));
}

function buildTaxFacts(
  direction: TaxDirection,
  input: z.infer<typeof businessDocumentLineInputSchema>,
  document: z.infer<typeof businessDocumentInputSchema>,
): TaxFacts {
  return {
    direction,
    taxPointDate: document.documentDate,
    currency: document.currency,
    taxableBasis: moneyString(input.netAmount, document.currency),
    destinationCountry: input.tax.destinationCountry,
    destinationRegion: input.tax.destinationRegion,
    destinationCity: input.tax.destinationCity,
    locationCode: input.tax.locationCode,
    category: input.tax.category,
    registrationId: input.tax.registrationId,
    evidenceReference: input.tax.evidenceReference,
    recoverablePercent: input.tax.recoverablePercent,
  };
}

function assertTaxDecisionAccountingShape(
  decision: TaxDecision,
  direction: TaxDirection,
  currency: string,
): void {
  if (!isQuantizedMoney(decision.totalTax, currency) || exact(decision.totalTax).isNegative()) {
    throw new Error("Tax pack returned an invalid transaction-currency tax amount");
  }
  for (const component of decision.components) {
    if (!isQuantizedMoney(component.amount, currency) || exact(component.amount).isNegative()) {
      throw new Error(`Tax component ${component.key} returned an invalid amount`);
    }
  }
  const recognized = sumExact(
    decision.components
      .filter((component) => component.treatment !== "DISCLOSURE_ONLY")
      .map((component) => component.amount),
  );
  if (!recognized.equals(decision.totalTax)) {
    throw new Error("Tax component amounts do not reconcile to total tax");
  }
  const allowedTreatments = direction === "SALE"
    ? new Set(["PAYABLE", "DISCLOSURE_ONLY"])
    : new Set([
        "RECOVERABLE",
        "NONRECOVERABLE",
        "SELF_ASSESSED_PAYABLE",
        "DISCLOSURE_ONLY",
      ]);
  if (decision.components.some((component) => !allowedTreatments.has(component.treatment))) {
    throw new Error("Tax pack returned a component treatment incompatible with the document direction");
  }
}

export function buildBusinessDocumentSnapshot(
  unparsedInput: z.input<typeof businessDocumentInputSchema>,
  unparsedFunctionalCurrency: string,
): BusinessDocumentSnapshot {
  const input = businessDocumentInputSchema.parse(unparsedInput);
  const functionalCurrency = unparsedFunctionalCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(functionalCurrency)) {
    throw new Error("Ledger functional currency must be a canonical three-letter code");
  }
  if (!isQuantizedMoney("0", input.currency) || !isQuantizedMoney("0", functionalCurrency)) {
    throw new Error("Document or functional currency is unsupported");
  }
  if (input.currency === functionalCurrency && !exact(input.fx.rate).equals(1)) {
    throw new Error("Functional-currency documents require an FX rate of exactly 1");
  }
  if (input.dueOn < input.documentDate) {
    throw new Error("Document due date cannot precede its document date");
  }

  const policy = DOCUMENT_KIND_POLICY[input.kind];
  const lines = input.lines.map((line, index) => {
    if (!isQuantizedMoney(line.netAmount, input.currency)) {
      throw new Error(`Line ${index + 1} exceeds ${input.currency} precision`);
    }
    const decision = decideTax(line.tax.packKey, buildTaxFacts(policy.direction, line, input));
    assertTaxDecisionAccountingShape(decision, policy.direction, input.currency);
    return {
      lineNumber: index + 1,
      description: line.description,
      accountCombinationId: line.accountCombinationId,
      netAmount: moneyString(line.netAmount, input.currency),
      tax: line.tax,
      taxDecision: decision,
      taxDecisionHash: canonicalHash(decision),
    };
  });
  const subtotal = sumExact(lines.map((line) => line.netAmount));
  const taxTotal = sumExact(lines.map((line) => line.taxDecision.totalTax));
  // Self-assessed use tax is remitted by the buyer, not paid to the supplier.
  // It remains part of tax evidence but is excluded from the counterparty open item.
  const selfAssessedTaxTotal = sumExact(lines.flatMap((line) =>
    line.taxDecision.components
      .filter((component) => component.treatment === "SELF_ASSESSED_PAYABLE")
      .map((component) => component.amount)));
  const grossTotal = subtotal.plus(taxTotal).minus(selfAssessedTaxTotal);
  const taxMappingRequired = lines.some((line) => line.taxDecision.components.some(
    (component) => component.treatment === "PAYABLE" ||
      component.treatment === "RECOVERABLE" ||
      component.treatment === "SELF_ASSESSED_PAYABLE",
  ));
  if (taxMappingRequired && !input.taxAccountCombinationId) {
    throw new Error("A tax account combination is required by the tax decisions");
  }

  return businessDocumentSnapshotSchema.parse({
    schemaVersion: 1,
    kind: input.kind,
    ownerModule: policy.ownerModule,
    sourceType: policy.sourceType,
    sourceNumber: input.sourceNumber,
    ledgerId: input.ledgerId,
    legalEntityId: input.legalEntityId,
    partyAccountId: input.partyAccountId,
    controlAccountCombinationId: input.controlAccountCombinationId,
    taxAccountCombinationId: input.taxAccountCombinationId ?? null,
    fxRoundingAccountCombinationId: input.fxRoundingAccountCombinationId ?? null,
    documentDate: input.documentDate,
    accountingDate: input.accountingDate,
    periodId: input.periodId,
    dueOn: input.dueOn,
    currency: input.currency,
    functionalCurrency,
    fx: { ...input.fx, rate: exact(input.fx.rate).toFixed() },
    description: input.description,
    lines,
    subtotal: moneyString(subtotal, input.currency),
    taxTotal: moneyString(taxTotal, input.currency),
    grossTotal: moneyString(grossTotal, input.currency),
    grossFunctional: moneyString(grossTotal.times(input.fx.rate), functionalCurrency),
  });
}

export function assertSnapshotTaxDecisionsCurrent(snapshot: BusinessDocumentSnapshot): void {
  for (const line of snapshot.lines) {
    const current = decideTax(line.tax.packKey, line.taxDecision.facts);
    const currentHash = canonicalHash(current);
    if (currentHash !== line.taxDecisionHash) {
      throw new Error(
        `Tax decision changed for source line ${line.lineNumber}; append a new draft version before issuing`,
      );
    }
    if (current.status === "MANUAL_REVIEW_REQUIRED") {
      throw new Error(
        `Tax determination requires manual review on line ${line.lineNumber}: ${current.reviewReason ?? "unsupported facts"}`,
      );
    }
  }
}

export function sourceContentHash(snapshot: SubledgerSourceSnapshot): string {
  return canonicalHash(snapshot);
}
