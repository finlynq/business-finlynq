import type { z } from "zod";
import type { businessDocumentLineInputSchema } from "./document-model";

type DraftLine = z.infer<typeof businessDocumentLineInputSchema>;

// An unreviewed source amount may be preserved in a draft. Only an actor with
// the tax-review permission can mark its treatment reviewed or issue the bill.
export function draftRequiresSourceTaxReviewPermission(lines: readonly DraftLine[]): boolean {
  return lines.some((line) => line.tax.sourceTaxRounding !== undefined
    || line.tax.sourceTaxOverride?.reviewedTreatment !== undefined);
}
