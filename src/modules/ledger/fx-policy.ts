import { exact, quantizeMoney } from "@/kernel/money";

export const FX_QUOTE_CONVENTION =
  "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const;
export const FX_REVALUATION_METHOD = "REVERSE_NEXT_PERIOD" as const;

export type MonetaryPosition = "RECEIVABLE" | "PAYABLE";

export function convertToFunctional(
  transactionAmount: string,
  functionalPerTransactionRate: string,
  functionalCurrency: string,
): string {
  return quantizeMoney(
    exact(transactionAmount).times(functionalPerTransactionRate),
    functionalCurrency,
  ).toFixed();
}

export function calculatePartialSettlementFx(input: Readonly<{
  position: MonetaryPosition;
  allocatedTransactionAmount: string;
  carryingRate: string;
  settlementRate: string;
  functionalCurrency: string;
}>): Readonly<{
  carryingFunctionalAmount: string;
  settlementFunctionalAmount: string;
  gainLossFunctional: string;
}> {
  const carrying = quantizeMoney(
    exact(input.allocatedTransactionAmount).times(input.carryingRate),
    input.functionalCurrency,
  );
  const settlement = quantizeMoney(
    exact(input.allocatedTransactionAmount).times(input.settlementRate),
    input.functionalCurrency,
  );
  const assetGain = settlement.minus(carrying);
  const gainLoss = input.position === "RECEIVABLE" ? assetGain : assetGain.negated();

  return {
    carryingFunctionalAmount: carrying.toFixed(),
    settlementFunctionalAmount: settlement.toFixed(),
    gainLossFunctional: gainLoss.toFixed(),
  };
}

export function calculateOpenItemRevaluation(input: Readonly<{
  position: MonetaryPosition;
  openTransactionAmount: string;
  carryingFunctionalAmount: string;
  closingRate: string;
  functionalCurrency: string;
}>): Readonly<{
  revaluedFunctionalAmount: string;
  gainLossFunctional: string;
  reversesNextPeriod: true;
}> {
  const revalued = quantizeMoney(
    exact(input.openTransactionAmount).times(input.closingRate),
    input.functionalCurrency,
  );
  const carrying = exact(input.carryingFunctionalAmount);
  const assetGain = revalued.minus(carrying);

  return {
    revaluedFunctionalAmount: revalued.toFixed(),
    gainLossFunctional:
      input.position === "RECEIVABLE" ? assetGain.toFixed() : assetGain.negated().toFixed(),
    reversesNextPeriod: true,
  };
}
