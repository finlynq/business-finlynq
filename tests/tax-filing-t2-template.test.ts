import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateTaxFilingTemplate } from "@/modules/tax/filing-template";
import {
  CANADA_T2_CORPORATION_SOURCE,
  CANADA_T2_CORPORATION_TEMPLATE_KEY,
  canadaT2CorporationTemplate,
} from "@/modules/tax/templates/canada-t2-corporation";
import manifest from "@/modules/tax/templates/canada-t2-corporation.json";
import { renderTaxFilingTemplateSeedSql } from "../scripts/operations/tax-filing-template-seed-contract";

describe("Canada T2 corporation income-tax template", () => {
  it("publishes the reviewed 2025-and-later CRA T2 manifest without migration drift", () => {
    const migration = readFileSync("migrations/drizzle/0059_publish_canada_t2_template.sql", "utf8");
    const generated = renderTaxFilingTemplateSeedSql(manifest);

    expect(CANADA_T2_CORPORATION_TEMPLATE_KEY).toBe("ca.t2.corporation-income-tax");
    expect(CANADA_T2_CORPORATION_SOURCE).toBe(
      "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t2/t2-26e.pdf",
    );
    expect(manifest.effectiveFrom).toBe("2025-01-01");
    expect(migration).toBe(generated.sql);
    expect(migration).toContain(`'${generated.digest}'`);
  });

  it("reconciles Schedule 1 income, taxable income, and the final refund", () => {
    const result = evaluateTaxFilingTemplate({
      definition: canadaT2CorporationTemplate,
      currency: "CAD",
      mappedValues: { wp_book_net_income: "125000" },
      manualValues: {
        wp_schedule_1_additions: "15000",
        wp_schedule_1_deductions: "5000",
        line_311: "2500",
        line_331: "7500",
        line_700: "18000",
        line_760: "11000",
        line_840: "35000",
      },
      reportedValues: {
        line_300: "135000",
        line_360: "125000",
        line_770: "29000",
        line_890: "35000",
        refund_amount: "6000",
        balance_owing: "0",
      },
    });

    expect(result.calculatedValues).toMatchObject({
      line_300: "135000.00",
      line_360: "125000.00",
      line_770: "29000.00",
      line_890: "35000.00",
      refund_amount: "6000.00",
      balance_owing: "0.00",
    });
    expect(result.varianceCount).toBe(0);
    expect(result.failedValidationCount).toBe(0);
  });

  it("keeps Quebec and Alberta separate-return guidance in the reviewed instructions", () => {
    expect(canadaT2CorporationTemplate.instructions).toMatch(/Quebec and Alberta require separate/i);
    expect(canadaT2CorporationTemplate.instructions).toMatch(/does not .*file a return/i);
  });
});
