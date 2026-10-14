import type { TaxFilingSummaryDto, TaxFilingTemplateDto } from "./filing-workspace";

type FilingIdentity = Pick<TaxFilingSummaryDto,
  "id" | "legalEntityId" | "ledgerId" | "templateId" | "periodStart" | "periodEnd" |
  "canonical" | "lifecycleState" | "capturedAt"
> & Readonly<{ registrationId?: string | null }>;

type TemplateIdentity = Pick<TaxFilingTemplateDto, "id" | "templateKey">;

/** Filing alternatives share entity, ledger, registration, form type and period. */
export function groupTaxFilingHistory<T extends FilingIdentity>(
  filings: readonly T[],
  templates: readonly TemplateIdentity[],
): readonly Readonly<{ key: string; typeKey: string; filings: readonly T[] }>[] {
  const templateKeys = new Map(templates.map((template) => [template.id, template.templateKey]));
  const byScope = new Map<string, { key: string; typeKey: string; filings: T[] }>();
  for (const filing of filings) {
    const typeKey = templateKeys.get(filing.templateId) ?? filing.templateId;
    const key = [
      filing.legalEntityId,
      filing.ledgerId,
      filing.registrationId ?? "unlinked-registration",
      typeKey,
      filing.periodStart,
      filing.periodEnd,
    ].join("|");
    const scope = byScope.get(key) ?? { key, typeKey, filings: [] };
    scope.filings.push(filing);
    byScope.set(key, scope);
  }
  return [...byScope.values()];
}

/** Keep one visible candidate per filing scope without claiming it was approved. */
export function partitionTaxFilingHistory<T extends FilingIdentity>(
  filings: readonly T[],
  templates: readonly TemplateIdentity[],
): Readonly<{ current: readonly T[]; history: readonly T[] }> {
  const current: T[] = [];
  const history: T[] = [];
  for (const group of groupTaxFilingHistory(filings, templates)) {
    const ordered = [...group.filings].sort((left, right) =>
      right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id));
    const eligible = ordered.filter((filing) => !["ARCHIVED", "SUPERSEDED"].includes(filing.lifecycleState ?? ""));
    const selected = eligible.find((filing) => filing.canonical)
      ?? eligible.find((filing) => filing.lifecycleState === "CURRENT")
      ?? eligible[0];
    if (selected) current.push(selected);
    history.push(...ordered.filter((filing) => filing.id !== selected?.id));
  }
  current.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  history.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  return { current, history };
}
