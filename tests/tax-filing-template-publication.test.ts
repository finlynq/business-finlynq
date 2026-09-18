import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderTaxFilingTemplateSeedSql } from "../scripts/operations/tax-filing-template-seed-contract";
import { taxFilingTemplateDefinitionSchema } from "@/modules/tax/filing-template";
import { canadaGstHstTemplate } from "@/modules/tax/templates/canada-gst-hst";

const publication = {
  id: "f1000000-0000-4000-8000-000000000099",
  templateKey: "ca.gst-hst.return",
  version: 2,
  name: "Canada GST/HST Return",
  authority: "Canada Revenue Agency",
  jurisdiction: "CA-FEDERAL",
  formCode: "GST34",
  currencyCode: "cad",
  effectiveFrom: "2027-01-01",
  effectiveTo: null,
  sourceUri: "https://example.com/reviewed-source.pdf",
  publishedAt: "2026-09-18T00:00:00Z",
  definition: canadaGstHstTemplate,
};

describe("tax filing template publication", () => {
  it("validates a reviewed manifest and emits a deterministic immutable seed", () => {
    const generated = renderTaxFilingTemplateSeedSql(publication);
    const digest = createHash("sha256")
      .update(JSON.stringify(taxFilingTemplateDefinitionSchema.parse(canadaGstHstTemplate)), "utf8")
      .digest("hex");

    expect(generated.digest).toBe(digest);
    expect(generated.sql).toContain("INSERT INTO tax_filing_templates");
    expect(generated.sql).toContain("'ca.gst-hst.return', 2");
    expect(generated.sql).toContain("'CAD'");
    expect(generated.sql).toContain(`'${digest}'`);
    expect(generated.sql).toContain("--> statement-breakpoint");
  });

  it("rejects invalid effective periods and malformed definitions", () => {
    expect(() => renderTaxFilingTemplateSeedSql({
      ...publication,
      effectiveTo: "2026-12-31",
    })).toThrow(/effective end/i);
    expect(() => renderTaxFilingTemplateSeedSql({
      ...publication,
      definition: { ...canadaGstHstTemplate, schemaVersion: 2 },
    })).toThrow();
  });
});
