export type PeriodState = "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";

export type PostingPurpose =
  | "ROUTINE"
  | "ADJUSTING"
  | "REVERSAL"
  | "OPENING"
  | "CLOSING"
  | "REVALUATION"
  | "TAX_ADJUSTMENT";

export type PeriodPostingContext = Readonly<{
  state: PeriodState;
  purpose: PostingPurpose;
  canPostAdjustment: boolean;
}>;

export type PeriodPostingDecision = Readonly<{
  allowed: boolean;
  code: "ALLOWED" | "ADJUSTMENT_PERMISSION_REQUIRED" | "PURPOSE_NOT_ALLOWED" | "PERIOD_CLOSED";
  reason: string;
}>;

const adjustmentPurposes = new Set<PostingPurpose>([
  "ADJUSTING",
  "REVERSAL",
  "CLOSING",
  "REVALUATION",
  "TAX_ADJUSTMENT",
]);

export function decidePeriodPosting(context: PeriodPostingContext): PeriodPostingDecision {
  if (context.state === "OPEN") {
    return { allowed: true, code: "ALLOWED", reason: "Period is open" };
  }

  if (context.state === "HARD_CLOSED" || context.state === "SEALED") {
    return {
      allowed: false,
      code: "PERIOD_CLOSED",
      reason: "Post the correction in an allowed open period and link it to the original",
    };
  }

  if (!adjustmentPurposes.has(context.purpose)) {
    return {
      allowed: false,
      code: "PURPOSE_NOT_ALLOWED",
      reason: "Routine activity is not permitted in an adjustment-only period",
    };
  }

  if (!context.canPostAdjustment) {
    return {
      allowed: false,
      code: "ADJUSTMENT_PERMISSION_REQUIRED",
      reason: "Adjustment posting permission is required",
    };
  }

  return { allowed: true, code: "ALLOWED", reason: "Authorized adjustment" };
}
