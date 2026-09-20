import Decimal from "decimal.js";
import { z } from "zod";
import { minorUnits, quantizeMoney } from "@/kernel/money";

const positiveAmount = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/).refine((value) => new Decimal(value).greaterThan(0));
const nonNegativeAmount = z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/);
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).optional();

export const assetKindSchema = z.enum(["TANGIBLE", "INTANGIBLE", "PREPAID"]);

export const createAssetCategorySchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  kind: assetKindSchema,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/),
  displayName: z.string().trim().min(1).max(160),
  costAccountCombinationId: z.uuid(),
  contraAccountCombinationId: z.uuid().optional(),
  expenseAccountCombinationId: z.uuid(),
  impairmentAccountCombinationId: z.uuid().optional(),
  disposalAccountCombinationId: z.uuid().optional(),
  effectiveFrom: z.iso.date(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict().superRefine((value, context) => {
  if (value.kind !== "PREPAID" && !value.contraAccountCombinationId) {
    context.addIssue({ code: "custom", path: ["contraAccountCombinationId"], message: "Tangible and intangible categories require an accumulated depreciation or amortization account" });
  }
});

export const reviseAssetCategorySchema = createAssetCategorySchema.safeExtend({
  categoryId: z.uuid(),
  expectedVersion: z.number().int().min(1),
}).strict();

export const deactivateAssetCategorySchema = z.object({
  categoryId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  effectiveFrom: z.iso.date(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const createAssetRecordSchema = z.object({
  categoryId: z.uuid(),
  assetNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
  displayName: z.string().trim().min(1).max(200),
  description: optionalText(2_000),
  classification: z.enum(["FINITE_LIFE", "INDEFINITE_LIFE"]).default("FINITE_LIFE"),
  acquisitionDate: z.iso.date(),
  inServiceOn: z.iso.date(),
  scheduleEndOn: z.iso.date().optional(),
  cost: positiveAmount,
  residualValue: nonNegativeAmount.default("0"),
  usefulLifeMonths: z.number().int().min(1).max(1_200).optional(),
  recognitionFrequency: z.literal("MONTHLY").default("MONTHLY"),
  location: optionalText(200),
  custodian: optionalText(200),
  vendorName: optionalText(200),
  sourceReference: optionalText(200),
  evidenceAssetId: z.uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict().superRefine((value, context) => {
  if (value.acquisitionDate > value.inServiceOn) {
    context.addIssue({ code: "custom", path: ["inServiceOn"], message: "The in-service date cannot precede acquisition" });
  }
  if (new Decimal(value.residualValue).greaterThanOrEqualTo(value.cost)) {
    context.addIssue({ code: "custom", path: ["residualValue"], message: "Residual value must be less than cost" });
  }
  if (value.classification === "INDEFINITE_LIFE" && (value.usefulLifeMonths || value.scheduleEndOn)) {
    context.addIssue({ code: "custom", message: "Indefinite-life intangibles do not have an automatic schedule" });
  }
});

export const assetAdjustmentSchema = z.object({
  assetId: z.uuid(),
  eventType: z.enum(["IMPAIRED", "TRANSFERRED", "DISPOSED", "RETIRED", "TERMINATED", "ADJUSTED", "REVERSED"]),
  effectiveOn: z.iso.date(),
  amount: nonNegativeAmount.optional(),
  reason: z.string().trim().min(5).max(500),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export type AssetKind = z.infer<typeof assetKindSchema>;
export type CreateAssetCategoryInput = z.input<typeof createAssetCategorySchema>;
export type ReviseAssetCategoryInput = z.input<typeof reviseAssetCategorySchema>;
export type DeactivateAssetCategoryInput = z.input<typeof deactivateAssetCategorySchema>;
export type CreateAssetRecordInput = z.input<typeof createAssetRecordSchema>;
export type AssetAdjustmentInput = z.input<typeof assetAdjustmentSchema>;
export type AssetScheduleLine = Readonly<{
  sequenceNumber: number;
  periodStartOn: string;
  periodEndOn: string;
  dueOn: string;
  amount: string;
}>;

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function endOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

export function finiteScheduleEnd(startOn: string, usefulLifeMonths: number): string {
  const start = parseDate(startOn);
  return isoDate(new Date(addMonths(start, usefulLifeMonths).getTime() - 86_400_000));
}

/** Deterministic straight-line/monthly schedule; the final line absorbs rounding. */
export function calculateAssetSchedule(input: Readonly<{
  kind: AssetKind;
  classification: "FINITE_LIFE" | "INDEFINITE_LIFE";
  inServiceOn: string;
  scheduleEndOn?: string;
  usefulLifeMonths?: number;
  cost: string;
  residualValue: string;
  currency: string;
}>): readonly AssetScheduleLine[] {
  if (input.classification === "INDEFINITE_LIFE") {
    if (input.kind !== "INTANGIBLE") throw new Error("Only intangible assets can have an indefinite life");
    return [];
  }
  const start = parseDate(input.inServiceOn);
  const end = input.kind === "PREPAID"
    ? input.scheduleEndOn && parseDate(input.scheduleEndOn)
    : input.usefulLifeMonths && parseDate(finiteScheduleEnd(input.inServiceOn, input.usefulLifeMonths));
  if (!end || end < start) throw new Error("A finite schedule requires a valid end date or useful life");

  const depreciable = new Decimal(input.cost).minus(input.residualValue);
  if (!depreciable.greaterThan(0)) throw new Error("The schedule basis must be greater than zero");
  const totalDays = daysInclusive(start, end);
  const periods: Array<{ start: Date; end: Date; weight: Decimal }> = [];
  let cursor = start;
  while (cursor <= end) {
    const periodEnd = endOfMonth(cursor) < end ? endOfMonth(cursor) : end;
    const weight = input.kind === "PREPAID"
      ? new Decimal(daysInclusive(cursor, periodEnd)).dividedBy(totalDays)
      : new Decimal(1);
    periods.push({ start: cursor, end: periodEnd, weight });
    cursor = addMonths(cursor, 1);
  }

  let allocated = new Decimal(0);
  return periods.map((period, index) => {
    const amount = index === periods.length - 1
      ? depreciable.minus(allocated)
      : quantizeMoney(
        input.kind === "PREPAID"
          ? depreciable.times(period.weight)
          : depreciable.dividedBy(periods.length),
        input.currency,
      );
    allocated = allocated.plus(amount);
    return {
      sequenceNumber: index + 1,
      periodStartOn: isoDate(period.start),
      periodEndOn: isoDate(period.end),
      dueOn: isoDate(period.end),
      amount: amount.toFixed(minorUnits(input.currency)),
    };
  });
}
