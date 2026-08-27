import { DEMO_BASELINE_DATE } from "./constants";
import {
  WASHINGTON_SALES_USE_EFFECTIVE_FROM,
  WASHINGTON_SALES_USE_EFFECTIVE_TO,
} from "@/modules/tax/packs/washington";

const DEMO_TIME_ZONE = "America/Toronto";

export type DemoAccountingCalendar = Readonly<{
  accountingDate: string;
  fiscalYear: number;
  periodNumber: number;
  timestamp: string;
}>;

function dateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Unable to resolve the demo accounting date");
  return `${year}-${month}-${day}`;
}

function clampDate(value: string, minimum: string, maximum: string): string {
  if (minimum > maximum) {
    throw new Error("The demo baseline date is outside the approved tax-pack window");
  }
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

/**
 * The writable demo follows Toronto's calendar only while every bundled tax
 * fact remains approved. At the tax-content boundary it pins instead of
 * silently applying an expired Washington rate. Advancing the pack's audited
 * effective range lets the clock resume without changing tenant workflows.
 */
export function demoAccountingCalendar(now = new Date()): DemoAccountingCalendar {
  const minimum = DEMO_BASELINE_DATE > WASHINGTON_SALES_USE_EFFECTIVE_FROM
    ? DEMO_BASELINE_DATE
    : WASHINGTON_SALES_USE_EFFECTIVE_FROM;
  const accountingDate = clampDate(
    dateInTimeZone(now, DEMO_TIME_ZONE),
    minimum,
    WASHINGTON_SALES_USE_EFFECTIVE_TO,
  );
  const fiscalYear = Number(accountingDate.slice(0, 4));
  const periodNumber = Number(accountingDate.slice(5, 7));
  return {
    accountingDate,
    fiscalYear,
    periodNumber,
    timestamp: `${accountingDate}T12:00:00.000Z`,
  };
}

export function demoAccountingDate(now = new Date()): string {
  return demoAccountingCalendar(now).accountingDate;
}

export function demoPeriodState(
  periodNumber: number,
  currentPeriod: number,
): "OPEN" | "HARD_CLOSED" | "SEALED" {
  if (periodNumber < currentPeriod - 1) return "SEALED";
  if (periodNumber === currentPeriod - 1) return "HARD_CLOSED";
  return "OPEN";
}

export function demoDateOffset(accountingDate: string, days: number): string {
  const date = new Date(`${accountingDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid demo accounting date: ${accountingDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
