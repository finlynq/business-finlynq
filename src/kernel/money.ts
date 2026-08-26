import Decimal from "decimal.js";

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -50,
  toExpPos: 50,
});

export type DecimalInput = Decimal | string | number;

const currencyMinorUnits: Readonly<Record<string, number>> = {
  CAD: 2,
  USD: 2,
};

export function exact(value: DecimalInput): Decimal {
  const result = value instanceof Decimal ? value : new Decimal(value);

  if (!result.isFinite()) {
    throw new Error("Money values must be finite exact decimals");
  }

  return result;
}

export function minorUnits(currency: string): number {
  const scale = currencyMinorUnits[currency.toUpperCase()];

  if (scale === undefined) {
    throw new Error(`Unsupported currency precision: ${currency}`);
  }

  return scale;
}

export function quantizeMoney(value: DecimalInput, currency: string): Decimal {
  return exact(value).toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);
}

export function isQuantizedMoney(value: DecimalInput, currency: string): boolean {
  const amount = exact(value);
  return amount.equals(quantizeMoney(amount, currency));
}

export function sumExact(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(exact(value)), new Decimal(0));
}

export function formatMoney(value: DecimalInput, currency: string): string {
  const code = currency.toUpperCase();
  const amount = quantizeMoney(value, code);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: minorUnits(code),
    maximumFractionDigits: minorUnits(code),
  }).format(amount.toNumber());
}
