import { describe, expect, it } from "vitest";
import {
  evaluateTaxFilingTemplate,
  taxFilingTemplateDefinitionSchema,
} from "@/modules/tax/filing-template";
import { canadaGstHstTemplate } from "@/modules/tax/templates/canada-gst-hst";

describe("generic tax filing templates", () => {
  it("validates the shared Canadian template and calculates CRA return formulas", () => {
    const definition = taxFilingTemplateDefinitionSchema.parse(canadaGstHstTemplate);
    const result = evaluateTaxFilingTemplate({
      definition,
      currency: "CAD",
      mappedValues: {
        line_101: "10000.00",
        line_103: "1300.00",
        line_106: "650.00",
      },
      manualValues: {
        line_104: "10.00",
        line_107: "5.00",
        line_110: "100.00",
        line_111: "25.00",
        line_205: "0.00",
        line_405: "15.00",
      },
    });

    expect(result.calculatedValues).toMatchObject({
      line_105: "1310.00",
      line_108: "655.00",
      line_109: "655.00",
      line_112: "125.00",
      line_113a: "530.00",
      line_113b: "15.00",
      line_113c: "545.00",
      line_114: "0.00",
      line_115: "545.00",
    });
    expect(result.validations.find((rule) => rule.ruleKey === "collected_rate_range"))
      .toMatchObject({ status: "PASS", actual: "0.13" });
  });

  it("uses optional account mappings for manual input fields and reports their source", () => {
    const result = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: {
        line_101: "10000",
        line_103: "1300",
        line_104: "25",
        line_106: "650",
      },
      manualValues: { line_107: "5" },
      reportedValues: { line_104: "25", line_107: "5" },
    });

    expect(result.calculatedValues).toMatchObject({
      line_104: "25.00",
      line_105: "1325.00",
      line_107: "5.00",
      line_108: "655.00",
    });
    expect(result.reconciliation.find((field) => field.fieldKey === "line_104"))
      .toMatchObject({ source: "MAPPED_ACCOUNTS", status: "MATCHED" });
    expect(result.reconciliation.find((field) => field.fieldKey === "line_107"))
      .toMatchObject({ source: "MANUAL_INPUT", status: "MATCHED" });
  });

  it("reconciles reported fields with exact decimal tolerance and flags missing values", () => {
    const base = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_101: "1000", line_103: "130", line_106: "50" },
    });
    const result = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_101: "1000", line_103: "130", line_106: "50" },
      reportedValues: {
        line_101: "999.99",
        line_103: base.calculatedValues.line_103!,
      },
    });

    expect(result.reconciliation.find((field) => field.fieldKey === "line_101"))
      .toMatchObject({ status: "MATCHED", difference: "-0.01" });
    expect(result.reconciliation.find((field) => field.fieldKey === "line_105"))
      .toMatchObject({ status: "NOT_REPORTED", reportedValue: null });

    const variance = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_101: "1000", line_103: "130", line_106: "50" },
      reportedValues: { line_101: "999.98" },
    });
    expect(variance.reconciliation.find((field) => field.fieldKey === "line_101"))
      .toMatchObject({ status: "VARIANCE", difference: "-0.02" });
  });

  it("keeps percentage and threshold conditions in the template version", () => {
    const result = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_101: "40000", line_103: "8000", line_106: "0" },
    });
    expect(result.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleKey: "collected_rate_range", status: "FAIL", severity: "WARNING" }),
      expect.objectContaining({ ruleKey: "small_supplier_review", status: "FAIL", severity: "WARNING" }),
      expect.objectContaining({ ruleKey: "refund_or_payment", status: "PASS", severity: "ERROR" }),
    ]));
    expect(result.failedValidationCount).toBe(2);
  });

  it("does not turn a negative tax rate positive during percentage validation", () => {
    const result = evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_101: "1000", line_103: "-50", line_106: "0" },
    });

    expect(result.validations.find((rule) => rule.ruleKey === "collected_rate_range"))
      .toMatchObject({ status: "FAIL", actual: "-0.05" });
  });

  it("rejects templates whose formulas refer forward or whose mappings target calculated fields", () => {
    const malformed = structuredClone(canadaGstHstTemplate);
    malformed.fields[0] = {
      ...malformed.fields[0]!,
      kind: "CALCULATED",
      allowAccountMapping: true,
      formula: { operation: "ADD", operands: ["line_103"] },
    };
    expect(taxFilingTemplateDefinitionSchema.safeParse(malformed).success).toBe(false);
  });

  it("fails closed on values for unknown template fields", () => {
    expect(() => evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { unknown_line: "1.00" },
    })).toThrow(/Unknown tax template field/);
  });

  it("rejects mapped formula fields and manual values outside manual fields", () => {
    expect(() => evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      mappedValues: { line_105: "1" },
    })).toThrow(/does not accept mapped values/);
    expect(() => evaluateTaxFilingTemplate({
      definition: canadaGstHstTemplate,
      currency: "CAD",
      manualValues: { line_101: "1" },
    })).toThrow(/does not accept manual values/);
  });
});
