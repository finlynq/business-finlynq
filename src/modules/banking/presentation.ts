function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatBankingTimestamp(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return [
    `${parsed.getUTCFullYear()}-${twoDigits(parsed.getUTCMonth() + 1)}-${twoDigits(parsed.getUTCDate())}`,
    `${twoDigits(parsed.getUTCHours())}:${twoDigits(parsed.getUTCMinutes())}`,
    "UTC",
  ].join(" ");
}
