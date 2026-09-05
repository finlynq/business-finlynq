import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceReferencesSchema } from "./evidence-model";
import {
  exact,
  isQuantizedMoney,
  minorUnits,
  quantizeMoney,
  sumExact,
} from "@/kernel/money";
import { decideTax } from "@/modules/tax/engine";
import type { TaxDecision, TaxDirection, TaxFacts } from "@/modules/tax/types";
import { settlementMethodSchema, validateSettlementFunding } from "./settlement-funding";
import { BusinessDocumentValidationError } from "./validation-errors";

const positiveAmountSchema = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/).refine(
  (value) => exact(value).greaterThan(0),
  "Amount must be greater than zero",
);
const signedNonZeroAmountSchema = z.string().trim().regex(/^-?\d+(?:\.\d{1,9})?$/).refine(
  (value) => !exact(value).isZero(),
  "Amount must not be zero",
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

export const fxInputSchema = z.object({
  rate: positiveRateSchema,
  source: z.string().trim().min(1).max(100),
  effectiveAt: z.iso.datetime({ offset: true }),
  quoteConvention: z.literal("FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT")
    .default("FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT"),
}).strict();

const providerFxCalculationSchema = z.enum([
  "DIRECT_TO_CAD",
  "INVERSE_FROM_CAD",
  "CROSS_VIA_CAD",
  "DIRECT_FROM_EUR",
  "INVERSE_TO_EUR",
  "CROSS_VIA_EUR",
]);

const providerFxFormulaSchema = z.enum([
  "CAD_PER_SOURCE_UNIT",
  "1 / CAD_PER_TARGET_UNIT",
  "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT",
  "TARGET_UNITS_PER_EUR",
  "1 / SOURCE_UNITS_PER_EUR",
  "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
]);

const providerFxLegSchema = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  rate: positiveRateSchema,
  rateConvention: z.enum([
    "CAD_PER_CURRENCY_UNIT",
    "CURRENCY_UNITS_PER_EUR",
  ]),
  observedDate: z.iso.date(),
  seriesKey: z.string().trim().min(1).max(100),
}).strict();

const fxProvenanceSchema = z.object({
  mode: z.enum(["FUNCTIONAL", "ORGANIZATION_RATE", "PROVIDER_RATE", "EXPLICIT"]),
  asOfDate: z.iso.date(),
  resolvedAt: z.iso.datetime({ offset: true }),
  policyKey: z.string().trim().min(1).max(100),
  policyVersion: z.number().int().positive(),
  organizationRateId: z.uuid().optional(),
  rateRecordedAt: z.iso.datetime({ offset: true }).optional(),
  providerKey: z.enum([
    "BANK_OF_CANADA",
    "EUROPEAN_CENTRAL_BANK",
    "YAHOO_FINANCE_EXPERIMENTAL",
  ]).optional(),
  providerSymbol: z.string().trim().min(1).max(200).optional(),
  providerSourceCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  providerTargetCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  providerObservedAt: z.iso.datetime({ offset: true }).optional(),
  providerRetrievedAt: z.iso.datetime({ offset: true }).optional(),
  providerResponseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  providerMaxLookbackDays: z.number().int().min(1).max(7).optional(),
  providerCalculation: providerFxCalculationSchema.optional(),
  providerFormula: providerFxFormulaSchema.optional(),
  providerLegs: z.array(providerFxLegSchema).min(1).max(2).optional(),
}).strict().superRefine((value, context) => {
  const stored = value.mode === "ORGANIZATION_RATE";
  const storedEvidence = Boolean(value.organizationRateId) && Boolean(value.rateRecordedAt);
  if (stored !== storedEvidence
      || (!stored && (value.organizationRateId !== undefined || value.rateRecordedAt !== undefined))) {
    context.addIssue({
      code: "custom",
      message: "Stored organization FX provenance requires its rate identity and recorded time",
    });
  }

  const provider = value.mode === "PROVIDER_RATE";
  const providerEvidence = value.providerKey !== undefined
    && value.providerSymbol !== undefined
    && value.providerObservedAt !== undefined
    && value.providerRetrievedAt !== undefined
    && value.providerResponseSha256 !== undefined
    && value.providerMaxLookbackDays !== undefined;
  const providerRetrievedAfterResolution = provider
    && value.providerRetrievedAt !== undefined
    && Date.parse(value.providerRetrievedAt) > Date.parse(value.resolvedAt);
  if (provider !== providerEvidence || providerRetrievedAfterResolution) {
    context.addIssue({
      code: "custom",
      message: "Provider FX provenance requires complete observation, retrieval, and resolution times",
    });
  }
  const pairEvidenceComplete = value.providerSourceCurrency !== undefined
    && value.providerTargetCurrency !== undefined;
  const pairEvidencePartial = value.providerSourceCurrency !== undefined
    || value.providerTargetCurrency !== undefined;
  if (pairEvidencePartial && !pairEvidenceComplete) {
    context.addIssue({
      code: "custom",
      message: "Provider FX currency-pair evidence requires both source and target currencies",
    });
  }

  const centralFieldsPresent = value.providerCalculation !== undefined
    || value.providerFormula !== undefined
    || value.providerLegs !== undefined;
  if (provider && value.providerKey === "YAHOO_FINANCE_EXPERIMENTAL") {
    const yahooSymbolValid = value.providerSymbol !== undefined
      && /^[A-Z]{3}(?:[A-Z]{3})?=X$/.test(value.providerSymbol);
    const yahooSource = value.providerSourceCurrency ?? "";
    const yahooTarget = value.providerTargetCurrency ?? "";
    const expectedSymbol = pairEvidenceComplete
      ? yahooSource === "USD"
        ? yahooTarget + "=X"
        : yahooSource + yahooTarget + "=X"
      : value.providerSymbol;
    if (value.policyKey !== "YAHOO_FINANCE_EXPERIMENTAL_DIRECT_DAILY_CLOSE"
        || !yahooSymbolValid
        || centralFieldsPresent
        || (pairEvidenceComplete && (
          yahooSource === yahooTarget
          || value.providerSymbol !== expectedSymbol
        ))) {
      context.addIssue({
        code: "custom",
        message: "Yahoo FX provenance requires its exact direct symbol and no derived-rate evidence",
      });
    }
  }

  if (provider && value.providerKey === "BANK_OF_CANADA") {
    const source = value.providerSourceCurrency;
    const target = value.providerTargetCurrency;
    const observedDate = value.providerObservedAt?.slice(0, 10);
    const expected = !source || !target || source === target
      ? null
      : target === "CAD"
        ? {
            calculation: "DIRECT_TO_CAD",
            formula: "CAD_PER_SOURCE_UNIT",
            currencies: [source],
          }
        : source === "CAD"
          ? {
              calculation: "INVERSE_FROM_CAD",
              formula: "1 / CAD_PER_TARGET_UNIT",
              currencies: [target],
            }
          : {
              calculation: "CROSS_VIA_CAD",
              formula: "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT",
              currencies: [source, target],
            };
    const legs = value.providerLegs;
    const consistent = expected !== null
      && legs !== undefined
      && value.policyKey === "BANK_OF_CANADA_DAILY_REFERENCE_RATE"
      && value.providerCalculation === expected.calculation
      && value.providerFormula === expected.formula
      && legs.length === expected.currencies.length
      && legs.every((leg, index) => (
        leg.currency === expected.currencies[index]
        && leg.rateConvention === "CAD_PER_CURRENCY_UNIT"
        && leg.seriesKey === "FX" + leg.currency + "CAD"
        && leg.observedDate === observedDate
      ))
      && value.providerSymbol === legs.map((leg) => leg.seriesKey).join("+");
    if (!consistent) {
      context.addIssue({
        code: "custom",
        message: "Bank of Canada provenance must match the CAD calculation, pair, series, and common observation date",
      });
    }
  }

  if (provider && value.providerKey === "EUROPEAN_CENTRAL_BANK") {
    const source = value.providerSourceCurrency;
    const target = value.providerTargetCurrency;
    const observedDate = value.providerObservedAt?.slice(0, 10);
    const expected = !source || !target || source === target
      ? null
      : source === "EUR"
        ? {
            calculation: "DIRECT_FROM_EUR",
            formula: "TARGET_UNITS_PER_EUR",
            currencies: [target],
          }
        : target === "EUR"
          ? {
              calculation: "INVERSE_TO_EUR",
              formula: "1 / SOURCE_UNITS_PER_EUR",
              currencies: [source],
            }
          : {
              calculation: "CROSS_VIA_EUR",
              formula: "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
              currencies: [source, target],
            };
    const legs = value.providerLegs;
    const consistent = expected !== null
      && legs !== undefined
      && value.policyKey === "EUROPEAN_CENTRAL_BANK_REFERENCE_RATE"
      && value.providerCalculation === expected.calculation
      && value.providerFormula === expected.formula
      && legs.length === expected.currencies.length
      && legs.every((leg, index) => (
        leg.currency === expected.currencies[index]
        && leg.rateConvention === "CURRENCY_UNITS_PER_EUR"
        && leg.seriesKey === "EXR.D." + leg.currency + ".EUR.SP00.A"
        && leg.observedDate === observedDate
      ))
      && value.providerSymbol === legs.map((leg) => leg.seriesKey).join("+");
    if (!consistent) {
      context.addIssue({
        code: "custom",
        message: "ECB provenance must match the EUR calculation, pair, series, and common observation date",
      });
    }
  }

  if (!provider && (
    value.providerKey !== undefined
    || value.providerSymbol !== undefined
    || value.providerSourceCurrency !== undefined
    || value.providerTargetCurrency !== undefined
    || value.providerObservedAt !== undefined
    || value.providerRetrievedAt !== undefined
    || value.providerResponseSha256 !== undefined
    || value.providerMaxLookbackDays !== undefined
    || value.providerCalculation !== undefined
    || value.providerFormula !== undefined
    || value.providerLegs !== undefined
  )) {
    context.addIssue({
      code: "custom",
      message: "Provider FX evidence is only valid for provider-resolved rates",
    });
  }
});

export const fxSnapshotSchema = fxInputSchema.extend({
  // Optional only so immutable snapshots written before server-side resolution remain readable.
  provenance: fxProvenanceSchema.optional(),
}).strict().superRefine((value, context) => {
  const provenance = value.provenance;
  if (provenance?.mode === "PROVIDER_RATE" && provenance.providerKey) {
    const expectedSource = {
      BANK_OF_CANADA: "Bank of Canada Valet API daily exchange rates",
      EUROPEAN_CENTRAL_BANK: "Source: ECB statistics. Euro foreign exchange reference rates",
      YAHOO_FINANCE_EXPERIMENTAL: "Yahoo Finance / ICE Data Services",
    }[provenance.providerKey];
    if (value.source !== expectedSource) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Provider FX source attribution must match the recorded provider",
      });
    }
  }

  if (provenance?.mode === "PROVIDER_RATE"
      && provenance.providerObservedAt
      && provenance.providerRetrievedAt
      && provenance.providerMaxLookbackDays) {
    const asOfStart = Date.parse(provenance.asOfDate + "T00:00:00.000Z");
    const observedAt = Date.parse(provenance.providerObservedAt);
    const retrievedAt = Date.parse(provenance.providerRetrievedAt);
    const effectiveAt = Date.parse(value.effectiveAt);
    const earliestObservation = asOfStart
      - (provenance.providerMaxLookbackDays * 24 * 60 * 60 * 1_000);
    if (effectiveAt !== observedAt
        || observedAt < earliestObservation
        || observedAt >= asOfStart + (24 * 60 * 60 * 1_000)
        || retrievedAt < observedAt) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "Provider FX times must match the observation and configured as-of window",
      });
    }
  }

  const legs = provenance?.providerLegs;
  if (!provenance || !legs || !provenance.providerCalculation) return;

  let calculatedRate;
  if (provenance.providerCalculation === "DIRECT_TO_CAD"
      || provenance.providerCalculation === "DIRECT_FROM_EUR") {
    if (legs.length !== 1) return;
    calculatedRate = exact(legs[0]!.rate);
  } else if (provenance.providerCalculation === "INVERSE_FROM_CAD"
      || provenance.providerCalculation === "INVERSE_TO_EUR") {
    if (legs.length !== 1) return;
    calculatedRate = exact(1).div(legs[0]!.rate);
  } else {
    if (legs.length !== 2) return;
    calculatedRate = provenance.providerCalculation === "CROSS_VIA_CAD"
      ? exact(legs[0]!.rate).div(legs[1]!.rate)
      : exact(legs[1]!.rate).div(legs[0]!.rate);
  }

  if (!exact(value.rate).toDecimalPlaces(18).equals(
    calculatedRate.toDecimalPlaces(18),
  )) {
    context.addIssue({
      code: "custom",
      path: ["rate"],
      message: "Central-bank FX rate must equal the disclosed calculation over its source legs",
    });
  }
});

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
  netAmount: signedNonZeroAmountSchema,
  lineType: z.enum(["STANDARD", "ADJUSTMENT"]).optional(),
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

const businessDocumentRequestSchema = businessDocumentInputSchema.extend({
  fx: fxInputSchema.optional(),
}).strict();

export const createBusinessDocumentSchema = businessDocumentRequestSchema.extend({
  idempotencyKey: idempotencyKeySchema,
}).strict();

export function validateEditBusinessDocumentFxMode(
  value: Readonly<{
    fxResolutionMode?: "RESOLVE" | "PRESERVE" | "EXPLICIT";
    fx?: unknown;
  }>,
  context: z.RefinementCtx,
): void {
  if ((value.fxResolutionMode === "RESOLVE" || value.fxResolutionMode === "PRESERVE")
      && value.fx !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["fx"],
      message: `${value.fxResolutionMode} FX mode requires fx to be omitted`,
    });
  }
  if (value.fxResolutionMode === "EXPLICIT" && value.fx === undefined) {
    context.addIssue({
      code: "custom",
      path: ["fx"],
      message: "EXPLICIT FX mode requires rate, source, and effective time",
    });
  }
}

export const editBusinessDocumentSchema = businessDocumentRequestSchema.extend({
  expectedVersion: z.number().int().positive(),
  fxResolutionMode: z.enum(["RESOLVE", "PRESERVE", "EXPLICIT"]).optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine(validateEditBusinessDocumentFxMode);

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
  fx: fxInputSchema.optional(),
  bankAccountCombinationId: z.uuid().optional(),
  settlementAccountCombinationId: z.uuid().optional(),
  settlementMethod: settlementMethodSchema.optional(),
  realizedFxGainAccountCombinationId: z.uuid(),
  realizedFxLossAccountCombinationId: z.uuid(),
  fxRoundingAccountCombinationId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500),
  allocations: z.array(settlementAllocationInputSchema).min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine(validateSettlementFunding);

export const resolvedSettlementSchema = z.object({
  ...recordSettlementSchema.shape,
  fx: fxSnapshotSchema,
}).strict().superRefine(validateSettlementFunding);

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
  // Absent only on snapshots written before signed supplier adjustments.
  lineType: z.enum(["STANDARD", "ADJUSTMENT"]).optional(),
  tax: taxInputSchema,
  taxDecision: taxDecisionSchema,
  taxDecisionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function validateSnapshotProviderPair(
  value: Readonly<{
    accountingDate: string;
    settlementDate?: string;
    currency: string;
    functionalCurrency: string;
    fx: z.output<typeof fxSnapshotSchema>;
  }>,
  context: z.RefinementCtx,
): void {
  const provenance = value.fx.provenance;
  const expectedAsOfDate = value.settlementDate ?? value.accountingDate;
  if (provenance && provenance.asOfDate !== expectedAsOfDate) {
    context.addIssue({
      code: "custom",
      path: ["fx", "provenance", "asOfDate"],
      message: "FX provenance as-of date must match the document's FX resolution date",
    });
  }
  if (provenance?.providerSourceCurrency !== undefined
      && (provenance.providerSourceCurrency !== value.currency
        || provenance.providerTargetCurrency !== value.functionalCurrency)) {
    context.addIssue({
      code: "custom",
      path: ["fx", "provenance"],
      message: "Provider FX currency-pair evidence must match the document currencies",
    });
  }
}

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
  evidence: evidenceReferencesSchema.optional(),
}).strict().superRefine((value, context) => {
  validateSnapshotProviderPair(value, context);
  for (const line of value.lines) {
    if (exact(line.netAmount).isNegative()) {
      if (value.kind === "SALES_INVOICE") {
        context.addIssue({
          code: "custom",
          path: ["lines", line.lineNumber - 1, "netAmount"],
          message: "Sales-invoice lines must remain positive",
        });
      } else if (line.lineType !== "ADJUSTMENT") {
        context.addIssue({
          code: "custom",
          path: ["lines", line.lineNumber - 1, "lineType"],
          message: "A negative supplier-bill line must be marked ADJUSTMENT",
        });
      }
    }
  }
  if (exact(value.grossTotal).isZero()) {
    context.addIssue({
      code: "custom",
      path: ["grossTotal"],
      message: "Zero-gross AR/AP documents are not supported",
    });
  } else if (exact(value.grossTotal).isNegative()) {
    context.addIssue({
      code: "custom",
      path: ["grossTotal"],
      message: value.kind === "SUPPLIER_BILL"
        ? "A net supplier credit cannot be represented as a supplier bill"
        : "A net customer credit cannot be represented as a sales invoice",
    });
  }
});

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
  bankAccountCombinationId: z.uuid().optional(),
  settlementAccountCombinationId: z.uuid().optional(),
  settlementMethod: settlementMethodSchema.optional(),
  realizedFxGainAccountCombinationId: z.uuid(),
  realizedFxLossAccountCombinationId: z.uuid(),
  fxRoundingAccountCombinationId: z.uuid().nullable(),
  description: z.string(),
  allocations: z.array(settlementSnapshotAllocationSchema).min(1),
}).strict()
  .superRefine(validateSettlementFunding)
  .superRefine(validateSnapshotProviderPair);

export const subledgerSourceSnapshotSchema = z.discriminatedUnion("kind", [
  businessDocumentSnapshotSchema,
  settlementDocumentSnapshotSchema,
]);

export type BusinessDocumentInput = z.infer<typeof businessDocumentInputSchema>;
export type BusinessDocumentSnapshot = z.infer<typeof businessDocumentSnapshotSchema>;
export type ResolvedSettlementInput = z.infer<typeof resolvedSettlementSchema>;
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
  taxableBasis: string,
): void {
  const negativeBasis = exact(taxableBasis).isNegative();
  const invalidSign = (amount: string) => negativeBasis
    ? exact(amount).greaterThan(0)
    : exact(amount).lessThan(0);
  if (!isQuantizedMoney(decision.totalTax, currency) || invalidSign(decision.totalTax)) {
    throw new Error("Tax pack returned an invalid transaction-currency tax amount");
  }
  for (const component of decision.components) {
    if (!isQuantizedMoney(component.amount, currency) || invalidSign(component.amount)) {
      throw new Error("Tax component " + component.key + " returned an invalid amount");
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
    const lineNumber = index + 1;
    if (!isQuantizedMoney(line.netAmount, input.currency)) {
      throw new Error("Line " + lineNumber + " exceeds " + input.currency + " precision");
    }
    if (exact(line.netAmount).isNegative()) {
      if (input.kind === "SALES_INVOICE") {
        throw new BusinessDocumentValidationError(
          "NEGATIVE_SALES_LINE_UNSUPPORTED",
          "Line " + lineNumber + " is negative, but sales-invoice lines must remain positive.",
          lineNumber,
        );
      }
      if (line.lineType !== "ADJUSTMENT") {
        throw new BusinessDocumentValidationError(
          "SIGNED_LINE_REQUIRES_ADJUSTMENT",
          "Line " + lineNumber + " is negative and must be marked as an ADJUSTMENT.",
          lineNumber,
        );
      }
    }
    const decision = decideTax(line.tax.packKey, buildTaxFacts(policy.direction, line, input));
    assertTaxDecisionAccountingShape(decision, policy.direction, input.currency, line.netAmount);
    return {
      lineNumber,
      description: line.description,
      accountCombinationId: line.accountCombinationId,
      netAmount: moneyString(line.netAmount, input.currency),
      lineType: line.lineType,
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
  if (grossTotal.isZero()) {
    throw new BusinessDocumentValidationError(
      "ZERO_GROSS_UNSUPPORTED",
      "The document has a zero gross total; FinLynQ does not create zero-gross AR/AP open items.",
    );
  }
  if (grossTotal.isNegative()) {
    throw new BusinessDocumentValidationError(
      "SUPPLIER_CREDIT_NOTE_REQUIRED",
      input.kind === "SUPPLIER_BILL"
        ? "The document is a net supplier credit and cannot be saved as a supplier bill."
        : "The document is a net customer credit and cannot be saved as a sales invoice.",
    );
  }
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
