import { z } from "zod";
import { resolveSettlementFunding, SETTLEMENT_METHOD_LABELS } from "./settlement-funding";
import { exact, minorUnits, quantizeMoney, sumExact } from "@/kernel/money";
import {
  recordSettlementSchema,
  SETTLEMENT_KIND_POLICY,
  settlementDocumentSnapshotSchema,
  type SettlementDocumentSnapshot,
} from "./document-model";
import {
  balanceJournalLines,
  transactionLine,
  type JournalLineInput,
} from "./journal-line-builders";
import type {
  CalculatedSettlementAllocation,
  LockedOpenItemRow,
  OriginalJournalLineRow,
} from "./ar-ap-types";

function moneyString(value: string | ReturnType<typeof exact>, currency: string): string {
  return quantizeMoney(value, currency).toFixed(minorUnits(currency));
}

export function calculateSettlementAllocations(
  command: z.infer<typeof recordSettlementSchema>,
  openItems: ReadonlyMap<string, LockedOpenItemRow>,
  functionalCurrency: string,
): readonly CalculatedSettlementAllocation[] {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  return command.allocations.map((allocation) => {
    const item = openItems.get(allocation.openItemId);
    if (!item || item.ledger_id !== command.ledgerId ||
        item.party_account_id !== command.partyAccountId ||
        item.transaction_currency !== command.currency ||
        item.source_type !== policy.invoiceSourceType || item.void_event_id !== null) {
      throw new Error("Settlement allocation does not match the payment party, ledger, currency, or source type");
    }
    const transactionAmount = quantizeMoney(allocation.transactionAmount, command.currency);
    if (!transactionAmount.equals(allocation.transactionAmount)) {
      throw new Error(`Settlement allocation exceeds ${command.currency} precision`);
    }
    const originalTransaction = exact(item.original_transaction_amount);
    const originalFunctional = exact(item.original_functional_amount);
    const allocatedTransaction = exact(item.allocated_transaction_amount);
    const allocatedCarrying = exact(item.allocated_carrying_amount);
    const remainingTransaction = originalTransaction.minus(allocatedTransaction);
    const remainingCarrying = originalFunctional.minus(allocatedCarrying);
    if (!remainingTransaction.greaterThan(0) || !remainingCarrying.greaterThan(0) ||
        transactionAmount.greaterThan(remainingTransaction)) {
      throw new Error("Settlement would exceed the current open-item balance");
    }
    const carryingFunctional = transactionAmount.equals(remainingTransaction)
      ? remainingCarrying
      : quantizeMoney(
          transactionAmount.times(originalFunctional).div(originalTransaction),
          functionalCurrency,
        );
    const settlementFunctional = quantizeMoney(
      transactionAmount.times(command.fx.rate),
      functionalCurrency,
    );
    if (!carryingFunctional.greaterThan(0) || !settlementFunctional.greaterThan(0)) {
      throw new Error("Settlement converts to a zero functional amount");
    }
    const carryingRate = carryingFunctional.div(transactionAmount).toDecimalPlaces(18);
    if (!quantizeMoney(transactionAmount.times(carryingRate), functionalCurrency)
      .equals(carryingFunctional)) {
      throw new Error("Open-item carrying rate cannot be represented exactly at ledger precision");
    }
    const realized = policy.position === "RECEIVABLE"
      ? settlementFunctional.minus(carryingFunctional)
      : carryingFunctional.minus(settlementFunctional);
    const effectiveAt = item.source_fx_effective_at;
    if (!effectiveAt || Number.isNaN(Date.parse(effectiveAt))) {
      throw new Error("Open item is missing its immutable carrying FX effective time");
    }
    return {
      openItemId: item.id,
      transactionAmount: moneyString(transactionAmount, command.currency),
      carryingFunctionalAmount: moneyString(carryingFunctional, functionalCurrency),
      settlementFunctionalAmount: moneyString(settlementFunctional, functionalCurrency),
      realizedFxFunctional: moneyString(realized, functionalCurrency),
      carryingFxRate: carryingRate.toFixed(),
      carryingFxSource: item.source_fx_source ?? "OPEN_ITEM_CARRYING_SNAPSHOT",
      carryingFxEffectiveAt: effectiveAt,
    };
  });
}

export function buildSettlementSnapshot(
  command: z.infer<typeof recordSettlementSchema>,
  functionalCurrency: string,
  allocations: readonly CalculatedSettlementAllocation[],
): SettlementDocumentSnapshot {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const funding = resolveSettlementFunding(command);
  return settlementDocumentSnapshotSchema.parse({
    schemaVersion: 1,
    kind: command.kind,
    ownerModule: policy.ownerModule,
    sourceType: policy.sourceType,
    sourceNumber: command.sourceNumber,
    ledgerId: command.ledgerId,
    legalEntityId: command.legalEntityId,
    partyAccountId: command.partyAccountId,
    controlAccountCombinationId: command.controlAccountCombinationId,
    periodId: command.periodId,
    accountingDate: command.accountingDate,
    settlementDate: command.settlementDate,
    currency: command.currency,
    functionalCurrency,
    amount: moneyString(command.amount, command.currency),
    settlementFunctionalAmount: moneyString(
      exact(command.amount).times(command.fx.rate),
      functionalCurrency,
    ),
    fx: { ...command.fx, rate: exact(command.fx.rate).toFixed() },
    ...(funding.method === "BANK"
      ? { bankAccountCombinationId: funding.accountCombinationId }
      : { settlementAccountCombinationId: funding.accountCombinationId, settlementMethod: funding.method }),
    realizedFxGainAccountCombinationId: command.realizedFxGainAccountCombinationId,
    realizedFxLossAccountCombinationId: command.realizedFxLossAccountCombinationId,
    fxRoundingAccountCombinationId: command.fxRoundingAccountCombinationId ?? null,
    description: command.description,
    allocations: allocations.map((allocation) => ({
      openItemId: allocation.openItemId,
      transactionAmount: allocation.transactionAmount,
      carryingFunctionalAmount: allocation.carryingFunctionalAmount,
      settlementFunctionalAmount: allocation.settlementFunctionalAmount,
      realizedFxFunctional: allocation.realizedFxFunctional,
      carryingFxRate: allocation.carryingFxRate,
    })),
  });
}

export function buildSettlementJournalLines(
  snapshot: SettlementDocumentSnapshot,
  allocations: readonly CalculatedSettlementAllocation[],
  subledgerEventId: string,
): readonly JournalLineInput[] {
  const funding = resolveSettlementFunding(snapshot);
  const lines: JournalLineInput[] = [transactionLine({
    side: snapshot.kind === "CUSTOMER_RECEIPT" ? "DEBIT" : "CREDIT",
    accountCombinationId: funding.accountCombinationId,
    transactionAmount: snapshot.amount,
    transactionCurrency: snapshot.currency,
    fxRate: snapshot.fx.rate,
    functionalCurrency: snapshot.functionalCurrency,
    fxRateSource: snapshot.fx.source,
    fxRateEffectiveAt: snapshot.fx.effectiveAt,
    memo: `${snapshot.sourceNumber} ${funding.method === "BANK" ? "bank" : SETTLEMENT_METHOD_LABELS[funding.method]} settlement`,
  })];
  for (const allocation of allocations) {
    lines.push(transactionLine({
      side: snapshot.kind === "CUSTOMER_RECEIPT" ? "CREDIT" : "DEBIT",
      accountCombinationId: snapshot.controlAccountCombinationId,
      transactionAmount: allocation.transactionAmount,
      transactionCurrency: snapshot.currency,
      fxRate: allocation.carryingFxRate,
      functionalCurrency: snapshot.functionalCurrency,
      functionalAmount: allocation.carryingFunctionalAmount,
      fxRateSource: allocation.carryingFxSource,
      fxRateEffectiveAt: allocation.carryingFxEffectiveAt,
      partyAccountId: snapshot.partyAccountId,
      subledgerEventId,
      memo: `${snapshot.sourceNumber} settlement of open item ${allocation.openItemId}`,
    }));
  }
  const realized = sumExact(allocations.map((allocation) => allocation.realizedFxFunctional));
  if (!realized.isZero()) {
    lines.push(transactionLine({
      side: realized.isPositive() ? "CREDIT" : "DEBIT",
      accountCombinationId: realized.isPositive()
        ? snapshot.realizedFxGainAccountCombinationId
        : snapshot.realizedFxLossAccountCombinationId,
      transactionAmount: realized.abs(),
      transactionCurrency: snapshot.functionalCurrency,
      fxRate: "1",
      functionalCurrency: snapshot.functionalCurrency,
      fxRateSource: "SYSTEM_REALIZED_FX",
      fxRateEffectiveAt: snapshot.fx.effectiveAt,
      memo: `${snapshot.sourceNumber} realized FX ${realized.isPositive() ? "gain" : "loss"}`,
    }));
  }
  return balanceJournalLines(lines, {
    functionalCurrency: snapshot.functionalCurrency,
    roundingAccountCombinationId: snapshot.fxRoundingAccountCombinationId,
    effectiveAt: snapshot.fx.effectiveAt,
    memo: `${snapshot.sourceNumber} settlement FX rounding`,
  });
}

export function assertSettlementCommandAmounts(command: z.infer<typeof recordSettlementSchema>): void {
  const amount = quantizeMoney(command.amount, command.currency);
  if (!amount.equals(command.amount)) {
    throw new Error(`Settlement amount exceeds ${command.currency} precision`);
  }
  for (const allocation of command.allocations) {
    if (!quantizeMoney(allocation.transactionAmount, command.currency)
      .equals(allocation.transactionAmount)) {
      throw new Error(`Settlement allocation exceeds ${command.currency} precision`);
    }
  }
  if (!sumExact(command.allocations.map((allocation) => allocation.transactionAmount)).equals(amount)) {
    throw new Error("A settlement must be fully allocated and allocations must equal its exact amount");
  }
  if (new Set(command.allocations.map((allocation) => allocation.openItemId)).size !==
      command.allocations.length) {
    throw new Error("Combine duplicate open-item allocations into one exact amount");
  }
}

export function reverseJournalLines(lines: readonly OriginalJournalLineRow[]): readonly JournalLineInput[] {
  return lines.map((line) => ({
    accountCombinationId: line.account_combination_id,
    debitFunctional: line.credit_functional,
    creditFunctional: line.debit_functional,
    transactionCurrency: line.transaction_currency,
    debitTransaction: line.credit_transaction,
    creditTransaction: line.debit_transaction,
    fxRate: line.fx_rate,
    fxRateSource: line.fx_rate_source,
    fxRateEffectiveAt: line.fx_rate_effective_at instanceof Date
      ? line.fx_rate_effective_at.toISOString()
      : new Date(line.fx_rate_effective_at).toISOString(),
    partyAccountId: line.party_account_id ?? undefined,
    subledgerEventId: line.subledger_event_id ?? undefined,
    taxSnapshotId: line.tax_snapshot_id ?? undefined,
    memo: `${line.memo ? `${line.memo} · ` : ""}Document void reversal`,
  }));
}
