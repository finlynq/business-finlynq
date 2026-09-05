import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { supportedCurrencies } from "@/kernel/money";

const exactDecimalSchema = z.string().trim().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/).refine((value) => {
  try {
    return new Decimal(value).abs().lessThanOrEqualTo("99999999999999999999999999999");
  } catch {
    return false;
  }
}, "Use an exact decimal with no more than nine fractional digits");

const positiveExactDecimalSchema = exactDecimalSchema.refine(
  (value) => new Decimal(value).greaterThan(0),
  "The row amount must be greater than zero",
);

const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).refine(
  (value) => supportedCurrencies.includes(value),
  "The currency is not enabled by FinLynQ",
);

const safeText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const bankStatementSourceKindSchema = z.enum([
  "DEPOSIT",
  "WITHDRAWAL",
  "PURCHASE",
  "PAYMENT",
  "REFUND",
  "FEE",
  "INTEREST",
  "OTHER_INCREASE",
  "OTHER_DECREASE",
]);

export const bankStatementRowSchema = z.object({
  rowNumber: z.number().int().min(1).max(1_000_000),
  postedOn: z.iso.date(),
  direction: z.enum(["INCREASE", "DECREASE"]),
  sourceKind: bankStatementSourceKindSchema,
  amount: positiveExactDecimalSchema,
  payee: safeText(500).optional(),
  description: safeText(2_000).optional(),
  reference: safeText(500).optional(),
  originalAmount: exactDecimalSchema.optional(),
  originalCurrency: currencySchema.optional(),
  excluded: z.boolean().default(false),
  exclusionReason: safeText(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.originalAmount) !== Boolean(value.originalCurrency)) {
    context.addIssue({ code: "custom", message: "Original amount and currency must be supplied together" });
  }
  if (value.excluded !== Boolean(value.exclusionReason)) {
    context.addIssue({ code: "custom", message: "Excluded rows require a reason, and included rows cannot have one" });
  }
});

export const bankStatementExtractionSchema = z.object({
  extractionVersion: z.literal("finlynq.statement.v1"),
  institution: safeText(200),
  maskedAccount: safeText(100),
  accountKind: z.enum(["CASH", "CREDIT_CARD"]),
  currency: currencySchema,
  statementStartOn: z.iso.date(),
  statementEndOn: z.iso.date(),
  balanceConvention: z.enum(["SIGNED_ACCOUNT_BALANCE", "POSITIVE_AMOUNT_OWED"]),
  openingBalance: exactDecimalSchema,
  closingBalance: exactDecimalSchema,
  namedBalances: z.array(z.object({
    name: safeText(100),
    amount: exactDecimalSchema,
  }).strict()).max(20).default([]),
  pageCount: z.number().int().min(1).max(1_000).optional(),
  rows: z.array(bankStatementRowSchema).min(1).max(1_000),
}).strict();

export const bankStatementMappingSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("EXISTING_ACCOUNT"),
    externalAccountId: z.uuid(),
  }).strict(),
  z.object({
    mode: z.literal("CREATE_OR_REUSE_ACCOUNT"),
    legalEntityId: z.uuid(),
    ledgerId: z.uuid(),
    accountCombinationId: z.uuid(),
  }).strict(),
]);

export type BankStatementExtraction = z.input<typeof bankStatementExtractionSchema>;
export type BankStatementMapping = z.input<typeof bankStatementMappingSchema>;

export type NormalizedBankStatementRow = Readonly<{
  rowNumber: number;
  postedOn: string;
  status: "POSTED";
  amount: string;
  currencyCode: string;
  direction: "INCREASE" | "DECREASE";
  sourceKind: z.infer<typeof bankStatementSourceKindSchema>;
  payee: string | null;
  description: string | null;
  reference: string | null;
  originalAmount: string | null;
  originalCurrency: string | null;
  excluded: boolean;
  exclusionReason: string | null;
  fingerprint: string;
}>;

export type BankStatementPreview = Readonly<{
  extractionVersion: "finlynq.statement.v1";
  institution: string;
  maskedAccount: string;
  accountKind: "CASH" | "CREDIT_CARD";
  currencyCode: string;
  statementStartOn: string;
  statementEndOn: string;
  openingBalance: string;
  closingBalance: string;
  namedBalances: readonly Readonly<{ name: string; amount: string }>[];
  rows: readonly NormalizedBankStatementRow[];
  includedRowCount: number;
  excludedRowCount: number;
  transactionTotal: string;
  statementMovement: string;
  movementDifference: string;
  issues: readonly Readonly<{ code: string; message: string; rowNumber?: number }>[];
  readyToImport: boolean;
  previewHash: string;
  instruction: string;
}>;

function canonicalText(value: string | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim();
  return normalized ? normalized : null;
}

function fixed(value: Decimal.Value): string {
  return new Decimal(value).toFixed(9);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Normalize an MCP-produced extraction without persisting anything. Positive
 * amounts always increase the account's economic balance. A credit-card
 * purchase therefore becomes negative while its payment becomes positive.
 */
export function previewBankStatementExtraction(input: BankStatementExtraction): BankStatementPreview {
  const parsed = bankStatementExtractionSchema.parse(input);
  const issues: { code: string; message: string; rowNumber?: number }[] = [];
  if (parsed.statementStartOn > parsed.statementEndOn) {
    issues.push({ code: "STATEMENT_PERIOD_INVALID", message: "Statement start must not be after statement end." });
  }
  if (parsed.balanceConvention === "POSITIVE_AMOUNT_OWED" && parsed.accountKind !== "CREDIT_CARD") {
    issues.push({ code: "BALANCE_CONVENTION_INVALID", message: "Positive amount owed is only valid for a credit-card statement." });
  }

  const normalizeBalance = (value: string) => fixed(
    parsed.balanceConvention === "POSITIVE_AMOUNT_OWED" ? new Decimal(value).negated() : value,
  );
  const openingBalance = normalizeBalance(parsed.openingBalance);
  const closingBalance = normalizeBalance(parsed.closingBalance);
  const namedBalances = parsed.namedBalances.map((balance) => ({
    name: canonicalText(balance.name)!,
    amount: normalizeBalance(balance.amount),
  }));

  const rowNumbers = new Set<number>();
  const occurrences = new Map<string, number>();
  const rows: NormalizedBankStatementRow[] = parsed.rows.map((row) => {
    if (rowNumbers.has(row.rowNumber)) {
      issues.push({ code: "DUPLICATE_ROW_NUMBER", message: "Source row numbers must be unique.", rowNumber: row.rowNumber });
    }
    rowNumbers.add(row.rowNumber);
    if (row.postedOn < parsed.statementStartOn || row.postedOn > parsed.statementEndOn) {
      issues.push({ code: "ROW_OUTSIDE_PERIOD", message: "The posted date falls outside the statement period.", rowNumber: row.rowNumber });
    }
    const amount = fixed(row.direction === "INCREASE" ? row.amount : new Decimal(row.amount).negated());
    const payee = canonicalText(row.payee);
    const description = canonicalText(row.description);
    const reference = canonicalText(row.reference);
    const originalAmount = row.originalAmount === undefined ? null : fixed(row.originalAmount);
    const originalCurrency = row.originalCurrency ?? null;
    const identity = {
      postedOn: row.postedOn,
      amount,
      currencyCode: parsed.currency,
      ...(reference ? { reference } : { payee, description }),
      originalAmount,
      originalCurrency,
    };
    const baseFingerprint = digest(identity);
    const occurrence = (occurrences.get(baseFingerprint) ?? 0) + 1;
    occurrences.set(baseFingerprint, occurrence);
    return {
      rowNumber: row.rowNumber,
      postedOn: row.postedOn,
      status: "POSTED" as const,
      amount,
      currencyCode: parsed.currency,
      direction: row.direction,
      sourceKind: row.sourceKind,
      payee,
      description,
      reference,
      originalAmount,
      originalCurrency,
      excluded: row.excluded,
      exclusionReason: canonicalText(row.exclusionReason),
      fingerprint: digest({ baseFingerprint, occurrence }),
    };
  });

  const included = rows.filter((row) => !row.excluded);
  const transactionTotal = included.reduce((total, row) => total.plus(row.amount), new Decimal(0));
  const statementMovement = new Decimal(closingBalance).minus(openingBalance);
  const movementDifference = statementMovement.minus(transactionTotal);
  if (!movementDifference.isZero()) {
    issues.push({
      code: "STATEMENT_MOVEMENT_MISMATCH",
      message: "Included rows must equal closing balance minus opening balance before import.",
    });
  }
  if (included.length === 0) {
    issues.push({ code: "NO_INCLUDED_ROWS", message: "At least one statement transaction must be included." });
  }

  const canonicalPreview = {
    extractionVersion: parsed.extractionVersion,
    institution: canonicalText(parsed.institution),
    maskedAccount: canonicalText(parsed.maskedAccount),
    accountKind: parsed.accountKind,
    currencyCode: parsed.currency,
    statementStartOn: parsed.statementStartOn,
    statementEndOn: parsed.statementEndOn,
    openingBalance,
    closingBalance,
    namedBalances,
    pageCount: parsed.pageCount ?? null,
    rows,
  };
  return {
    extractionVersion: parsed.extractionVersion,
    institution: canonicalPreview.institution!,
    maskedAccount: canonicalPreview.maskedAccount!,
    accountKind: parsed.accountKind,
    currencyCode: parsed.currency,
    statementStartOn: parsed.statementStartOn,
    statementEndOn: parsed.statementEndOn,
    openingBalance,
    closingBalance,
    namedBalances,
    rows,
    includedRowCount: included.length,
    excludedRowCount: rows.length - included.length,
    transactionTotal: fixed(transactionTotal),
    statementMovement: fixed(statementMovement),
    movementDifference: fixed(movementDifference),
    issues,
    readyToImport: issues.length === 0,
    previewHash: digest(canonicalPreview),
    instruction: issues.length === 0
      ? "Review the normalized signs, account mapping, period, balances, exclusions, and previewHash before confirming import. Import creates immutable banking observations and a draft reconciliation; it never posts a journal."
      : "Correct every reported extraction issue and preview again. Do not import this result.",
  };
}
