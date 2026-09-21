import {
  exact,
  formatMoney,
  minorUnits,
  quantizeMoney,
  sumExact,
} from "@/kernel/money";

export function isPositiveExactAmount(value: string): boolean {
  try {
    return exact(value).greaterThan(0);
  } catch {
    return false;
  }
}

export function exactAllocationTotal(
  allocations: Readonly<Record<string, string>>,
  currency: string,
): string {
  const amounts = Object.values(allocations).filter(isPositiveExactAmount);
  return sumExact(amounts).toFixed(minorUnits(currency));
}

export function displayExactMoney(currency: string, amount: string): string {
  try {
    return formatMoney(amount, currency);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function sourceTaxOverridePreview(input: Readonly<{
  netAmount: string;
  ratePercent: string;
  sourceTaxAmount: string;
  currency: string;
}>): Readonly<{
  calculatedTax: string;
  sourceTax: string;
  gross: string;
  arithmeticMatches: boolean;
}> | null {
  try {
    const scale = minorUnits(input.currency);
    const net = exact(input.netAmount);
    const calculatedTax = quantizeMoney(net.times(input.ratePercent).div(100), input.currency);
    const sourceTax = exact(input.sourceTaxAmount);
    return {
      calculatedTax: calculatedTax.toFixed(scale),
      sourceTax: sourceTax.toFixed(scale),
      gross: net.plus(sourceTax).toFixed(scale),
      arithmeticMatches: calculatedTax.equals(sourceTax),
    };
  } catch {
    return null;
  }
}
