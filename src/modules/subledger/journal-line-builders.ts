import { exact, minorUnits, quantizeMoney, sumExact } from "@/kernel/money";
import {
  DOCUMENT_KIND_POLICY,
  type BusinessDocumentSnapshot,
} from "./document-model";

export type JournalLineInput = Readonly<{
  accountCombinationId: string;
  debitFunctional: string;
  creditFunctional: string;
  transactionCurrency: string;
  debitTransaction: string;
  creditTransaction: string;
  fxRate: string;
  fxRateSource: string;
  fxRateEffectiveAt: string;
  partyAccountId?: string;
  subledgerEventId?: string;
  taxSnapshotId?: string;
  memo: string;
}>;

function moneyString(value: string | ReturnType<typeof exact>, currency: string): string {
  return quantizeMoney(value, currency).toFixed(minorUnits(currency));
}

function taxTreatmentAmount(
  snapshotLine: BusinessDocumentSnapshot["lines"][number],
  treatment: "PAYABLE" | "RECOVERABLE" | "NONRECOVERABLE" | "SELF_ASSESSED_PAYABLE",
): ReturnType<typeof exact> {
  return sumExact(
    snapshotLine.taxDecision.components
      .filter((component) => component.treatment === treatment)
      .map((component) => component.amount),
  );
}

export function transactionLine(input: Readonly<{
  side: "DEBIT" | "CREDIT";
  accountCombinationId: string;
  transactionAmount: string | ReturnType<typeof exact>;
  transactionCurrency: string;
  fxRate: string | ReturnType<typeof exact>;
  functionalCurrency: string;
  fxRateSource: string;
  fxRateEffectiveAt: string;
  functionalAmount?: string | ReturnType<typeof exact>;
  partyAccountId?: string;
  subledgerEventId?: string;
  taxSnapshotId?: string;
  memo: string;
}>): JournalLineInput {
  const transactionAmount = moneyString(input.transactionAmount, input.transactionCurrency);
  const functionalAmount = input.functionalAmount === undefined
    ? moneyString(exact(transactionAmount).times(input.fxRate), input.functionalCurrency)
    : moneyString(input.functionalAmount, input.functionalCurrency);
  if (!exact(transactionAmount).greaterThan(0) || !exact(functionalAmount).greaterThan(0)) {
    throw new Error("Journal lines require positive transaction and functional amounts");
  }
  return {
    accountCombinationId: input.accountCombinationId,
    debitFunctional: input.side === "DEBIT" ? functionalAmount : "0",
    creditFunctional: input.side === "CREDIT" ? functionalAmount : "0",
    transactionCurrency: input.transactionCurrency,
    debitTransaction: input.side === "DEBIT" ? transactionAmount : "0",
    creditTransaction: input.side === "CREDIT" ? transactionAmount : "0",
    fxRate: exact(input.fxRate).toFixed(),
    fxRateSource: input.fxRateSource,
    fxRateEffectiveAt: input.fxRateEffectiveAt,
    partyAccountId: input.partyAccountId,
    subledgerEventId: input.subledgerEventId,
    taxSnapshotId: input.taxSnapshotId,
    memo: input.memo,
  };
}

export function balanceJournalLines(
  lines: readonly JournalLineInput[],
  input: Readonly<{
    functionalCurrency: string;
    roundingAccountCombinationId: string | null;
    effectiveAt: string;
    memo: string;
  }>,
): readonly JournalLineInput[] {
  const debits = sumExact(lines.map((line) => line.debitFunctional));
  const credits = sumExact(lines.map((line) => line.creditFunctional));
  const difference = debits.minus(credits);
  if (difference.isZero()) return lines;
  if (!input.roundingAccountCombinationId) {
    throw new Error(
      "Per-line FX rounding does not balance this journal; configure an FX rounding account combination",
    );
  }
  const roundingLine = transactionLine({
    side: difference.isPositive() ? "CREDIT" : "DEBIT",
    accountCombinationId: input.roundingAccountCombinationId,
    transactionAmount: difference.abs(),
    transactionCurrency: input.functionalCurrency,
    fxRate: "1",
    functionalCurrency: input.functionalCurrency,
    fxRateSource: "SYSTEM_FX_ROUNDING",
    fxRateEffectiveAt: input.effectiveAt,
    memo: input.memo,
  });
  return [...lines, roundingLine];
}

export function buildIssueJournalLines(
  snapshot: BusinessDocumentSnapshot,
  subledgerEventId: string,
  taxSnapshotIds: ReadonlyMap<number, string>,
): readonly JournalLineInput[] {
  const policy = DOCUMENT_KIND_POLICY[snapshot.kind];
  const lines: JournalLineInput[] = [transactionLine({
    side: snapshot.kind === "SALES_INVOICE" ? "DEBIT" : "CREDIT",
    accountCombinationId: snapshot.controlAccountCombinationId,
    transactionAmount: snapshot.grossTotal,
    transactionCurrency: snapshot.currency,
    fxRate: snapshot.fx.rate,
    functionalCurrency: snapshot.functionalCurrency,
    fxRateSource: snapshot.fx.source,
    fxRateEffectiveAt: snapshot.fx.effectiveAt,
    partyAccountId: snapshot.partyAccountId,
    subledgerEventId,
    memo: `${snapshot.sourceNumber} ${policy.partyRole.toLowerCase()} control`,
  })];

  for (const sourceLine of snapshot.lines) {
    const taxSnapshotId = taxSnapshotIds.get(sourceLine.lineNumber);
    if (!taxSnapshotId) throw new Error("Tax snapshot is missing for a source line");
    const payable = taxTreatmentAmount(sourceLine, "PAYABLE");
    const recoverable = taxTreatmentAmount(sourceLine, "RECOVERABLE");
    const nonrecoverable = taxTreatmentAmount(sourceLine, "NONRECOVERABLE");
    const selfAssessedPayable = taxTreatmentAmount(sourceLine, "SELF_ASSESSED_PAYABLE");
    if (snapshot.kind === "SALES_INVOICE") {
      lines.push(transactionLine({
        side: "CREDIT",
        accountCombinationId: sourceLine.accountCombinationId,
        transactionAmount: sourceLine.netAmount,
        transactionCurrency: snapshot.currency,
        fxRate: snapshot.fx.rate,
        functionalCurrency: snapshot.functionalCurrency,
        fxRateSource: snapshot.fx.source,
        fxRateEffectiveAt: snapshot.fx.effectiveAt,
        memo: sourceLine.description,
      }));
      if (payable.greaterThan(0)) {
        if (!snapshot.taxAccountCombinationId) throw new Error("Sales tax account mapping is missing");
        lines.push(transactionLine({
          side: "CREDIT",
          accountCombinationId: snapshot.taxAccountCombinationId,
          transactionAmount: payable,
          transactionCurrency: snapshot.currency,
          fxRate: snapshot.fx.rate,
          functionalCurrency: snapshot.functionalCurrency,
          fxRateSource: snapshot.fx.source,
          fxRateEffectiveAt: snapshot.fx.effectiveAt,
          taxSnapshotId,
          memo: `${sourceLine.description} tax payable`,
        }));
      }
    } else {
      lines.push(transactionLine({
        side: "DEBIT",
        accountCombinationId: sourceLine.accountCombinationId,
        transactionAmount: exact(sourceLine.netAmount).plus(nonrecoverable).plus(selfAssessedPayable),
        transactionCurrency: snapshot.currency,
        fxRate: snapshot.fx.rate,
        functionalCurrency: snapshot.functionalCurrency,
        fxRateSource: snapshot.fx.source,
        fxRateEffectiveAt: snapshot.fx.effectiveAt,
        taxSnapshotId: nonrecoverable.plus(selfAssessedPayable).greaterThan(0)
          ? taxSnapshotId
          : undefined,
        memo: sourceLine.description,
      }));
      if (recoverable.greaterThan(0)) {
        if (!snapshot.taxAccountCombinationId) throw new Error("Recoverable tax account mapping is missing");
        lines.push(transactionLine({
          side: "DEBIT",
          accountCombinationId: snapshot.taxAccountCombinationId,
          transactionAmount: recoverable,
          transactionCurrency: snapshot.currency,
          fxRate: snapshot.fx.rate,
          functionalCurrency: snapshot.functionalCurrency,
          fxRateSource: snapshot.fx.source,
          fxRateEffectiveAt: snapshot.fx.effectiveAt,
          taxSnapshotId,
          memo: `${sourceLine.description} recoverable tax`,
        }));
      }
      if (selfAssessedPayable.greaterThan(0)) {
        if (!snapshot.taxAccountCombinationId) {
          throw new Error("Self-assessed use-tax payable account mapping is missing");
        }
        lines.push(transactionLine({
          side: "CREDIT",
          accountCombinationId: snapshot.taxAccountCombinationId,
          transactionAmount: selfAssessedPayable,
          transactionCurrency: snapshot.currency,
          fxRate: snapshot.fx.rate,
          functionalCurrency: snapshot.functionalCurrency,
          fxRateSource: snapshot.fx.source,
          fxRateEffectiveAt: snapshot.fx.effectiveAt,
          taxSnapshotId,
          memo: `${sourceLine.description} self-assessed use tax payable`,
        }));
      }
    }
  }
  return balanceJournalLines(lines, {
    functionalCurrency: snapshot.functionalCurrency,
    roundingAccountCombinationId: snapshot.fxRoundingAccountCombinationId,
    effectiveAt: snapshot.fx.effectiveAt,
    memo: `${snapshot.sourceNumber} FX conversion rounding`,
  });
}
