const exactAmountPattern = /^(-?)(\d+)(?:\.(\d+))?$/;

function minimumCurrencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
    }).resolvedOptions().minimumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatExactCurrencyAmount(amount: string, currency: string): string {
  const match = exactAmountPattern.exec(amount);
  if (!match) return `${currency} ${amount}`;

  const whole = match[2] ?? "0";
  const rawFraction = match[3] ?? "";
  const significantFraction = rawFraction.replace(/0+$/, "");
  const minimumFraction = minimumCurrencyFractionDigits(currency);
  const fraction = significantFraction.padEnd(minimumFraction, "0");
  const isZero = /^0+$/.test(whole) && (rawFraction === "" || /^0+$/.test(rawFraction));
  const sign = match[1] === "-" && !isZero ? "-" : "";
  const groupedWhole = new Intl.NumberFormat("en-CA", {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(BigInt(whole));

  return `${currency} ${sign}${groupedWhole}${fraction ? `.${fraction}` : ""}`;
}
