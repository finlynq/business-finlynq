import {
  exact,
  formatMoney,
  minorUnits,
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
