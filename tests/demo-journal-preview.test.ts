import { describe, expect, it } from "vitest";
import { validateDemoManualJournalPreview } from "@/modules/demo/workspace";
import type { DemoManualJournalPreviewInput } from "@/modules/demo/types";

const canadaPreview: DemoManualJournalPreviewInput = {
  entityCode: "CA01",
  accountingDate: "2026-08-26",
  description: "Exact decimal preview",
  purpose: "ROUTINE",
  canPostAdjustment: false,
  lines: [
    { accountCode: "6100", debitFunctional: "0.10", creditFunctional: "0.00" },
    { accountCode: "6200", debitFunctional: "0.20", creditFunctional: "0.00" },
    { accountCode: "1000", debitFunctional: "0.00", creditFunctional: "0.30" },
  ],
};

const washingtonPreview: DemoManualJournalPreviewInput = {
  ...canadaPreview,
  entityCode: "US01",
  description: "Washington preview",
  lines: [
    { accountCode: "6100", debitFunctional: "125.00", creditFunctional: "0.00" },
    { accountCode: "2300", debitFunctional: "0.00", creditFunctional: "125.00" },
  ],
};

function issueCodes(input: DemoManualJournalPreviewInput): string[] {
  return validateDemoManualJournalPreview(input).issues.map((issue) => issue.code);
}

describe("demo manual journal preview", () => {
  it("balances exact decimal inputs without writing anything", () => {
    expect(validateDemoManualJournalPreview(canadaPreview)).toEqual({
      valid: true,
      demoOnly: true,
      wouldPersist: false,
      entityCode: "CA01",
      currency: "CAD",
      periodState: "OPEN",
      totalDebit: "0.30",
      totalCredit: "0.30",
      issues: [],
    });
  });

  it("uses the real adjustment-only period policy", () => {
    expect(issueCodes(washingtonPreview)).toContain("PURPOSE_NOT_ALLOWED");

    const adjustment = { ...washingtonPreview, purpose: "ADJUSTING" as const };
    expect(issueCodes(adjustment)).toContain("ADJUSTMENT_PERMISSION_REQUIRED");
    expect(
      validateDemoManualJournalPreview({ ...adjustment, canPostAdjustment: true }),
    ).toMatchObject({ valid: true, wouldPersist: false, periodState: "ADJUSTMENT_ONLY" });
  });

  it("rejects imbalances, excessive precision, invalid dates, and unknown entities", () => {
    expect(
      issueCodes({
        ...canadaPreview,
        lines: [
          { accountCode: "6100", debitFunctional: "10.001", creditFunctional: "0" },
          { accountCode: "1000", debitFunctional: "0", creditFunctional: "10.001" },
        ],
      }),
    ).toContain("FUNCTIONAL_PRECISION");

    expect(
      issueCodes({
        ...canadaPreview,
        lines: [
          { accountCode: "6100", debitFunctional: "10.00", creditFunctional: "0" },
          { accountCode: "1000", debitFunctional: "0", creditFunctional: "9.99" },
        ],
      }),
    ).toContain("UNBALANCED");

    expect(issueCodes({ ...canadaPreview, accountingDate: "2026-02-30" })).toContain(
      "ACCOUNTING_DATE_INVALID",
    );
    expect(issueCodes({ ...canadaPreview, entityCode: "XX99" })).toContain("ENTITY_UNKNOWN");
  });

  it("rejects reserved or non-canonical account segment codes", () => {
    expect(
      issueCodes({
        ...canadaPreview,
        lines: [
          { accountCode: "0000", debitFunctional: "10.00", creditFunctional: "0" },
          { accountCode: " cash ", debitFunctional: "0", creditFunctional: "10.00" },
        ],
      }),
    ).toEqual(expect.arrayContaining(["ACCOUNT_CODE_INVALID", "ACCOUNT_CODE_NOT_CANONICAL"]));
  });
});
