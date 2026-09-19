import { createHash } from "node:crypto";
import { z } from "zod";
import { taxFilingTemplateDefinitionSchema } from "../../src/modules/tax/filing-template";

export const taxFilingTemplatePublicationSchema = z.object({
  id: z.uuid(),
  templateKey: z.string().trim().regex(/^[a-z][a-z0-9.-]{2,99}$/),
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(200),
  authority: z.string().trim().min(1).max(200),
  jurisdiction: z.string().trim().min(1).max(100),
  formCode: z.string().trim().min(1).max(50),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable().default(null),
  sourceUri: z.url(),
  publishedAt: z.iso.datetime({ offset: true }),
  definition: taxFilingTemplateDefinitionSchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({
      code: "custom",
      path: ["effectiveTo"],
      message: "The effective end cannot precede the effective start",
    });
  }
});

export type TaxFilingTemplatePublication = z.input<typeof taxFilingTemplatePublicationSchema>;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderTaxFilingTemplateSeedSql(
  input: unknown,
): Readonly<{ digest: string; sql: string }> {
  const template = taxFilingTemplatePublicationSchema.parse(input);
  const definition = JSON.stringify(template.definition);
  const digest = createHash("sha256").update(definition, "utf8").digest("hex");
  const effectiveTo = template.effectiveTo === null
    ? "NULL"
    : `${sqlString(template.effectiveTo)}::date`;
  const sql = `INSERT INTO tax_filing_templates (
  id, template_key, version, name, authority, jurisdiction, form_code,
  currency_code, effective_from, effective_to, definition, source_uri,
  source_digest, published_at
) VALUES (
  ${sqlString(template.id)}::uuid,
  ${sqlString(template.templateKey)}, ${template.version}, ${sqlString(template.name)},
  ${sqlString(template.authority)}, ${sqlString(template.jurisdiction)}, ${sqlString(template.formCode)},
  ${sqlString(template.currencyCode)}, ${sqlString(template.effectiveFrom)}::date, ${effectiveTo},
  ${sqlString(definition)}::jsonb,
  ${sqlString(template.sourceUri)},
  ${sqlString(digest)},
  ${sqlString(template.publishedAt)}::timestamptz
);
--> statement-breakpoint
`;
  return { digest, sql };
}
