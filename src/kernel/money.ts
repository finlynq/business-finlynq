import Decimal from "decimal.js";

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -50,
  toExpPos: 50,
});

export type DecimalInput = Decimal | string | number;

const currencyMinorUnits: Readonly<Record<string, number>> = {
  USD: 2, CAD: 2, EUR: 2, GBP: 2, AUD: 2, NZD: 2, CHF: 2,
  CNY: 2, HKD: 2, SGD: 2, INR: 2, MXN: 2, BRL: 2, ZAR: 2,
  AED: 2, SAR: 2, ILS: 2, TRY: 2, THB: 2, MYR: 2, PHP: 2,
  SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, IDR: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, XAF: 0, XOF: 0,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3,
};

export const supportedCurrencies = Object.freeze(Object.keys(currencyMinorUnits).sort());

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

export function formatMoneyAmount(value: DecimalInput, currency: string): string {
  const code = currency.toUpperCase();
  const amount = quantizeMoney(value, code);
  const fixed = amount.toFixed(minorUnits(code));
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function formatMoney(value: DecimalInput, currency: string): string {
  const code = currency.toUpperCase();
  const amount = formatMoneyAmount(value, code);
  return amount.startsWith("-")
    ? `-${code} ${amount.slice(1)}`
    : `${code} ${amount}`;
}
