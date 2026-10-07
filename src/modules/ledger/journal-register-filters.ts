import Decimal from "decimal.js";
import { z } from "zod";

export const journalFilterStatuses = ["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "REVERSED"] as const;
export const journalFilterInputSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  fiscalYear: z.string().optional(),
  periodId: z.string().optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  accountId: z.string().optional(),
  typeKey: z.string().optional(),
  ownerModule: z.string().optional(),
  minAmount: z.string().optional(),
  maxAmount: z.string().optional(),
  currency: z.string().optional(),
});
export type JournalFilterSearchParams = Readonly<Record<string, string | string[] | undefined>>;
export type JournalFilterValues = Readonly<{
  dateFrom: string;
  dateTo: string;
  fiscalYear: string;
  periodId: string;
  status: readonly string[];
  accountId: string;
  typeKey: string;
  ownerModule: string;
  minAmount: string;
  maxAmount: string;
  currency: string;
}>;
export type JournalFilterState = Readonly<{
  values: JournalFilterValues;
  errors: readonly string[];
}>;
export type JournalFilterOptions = Readonly<{
  fiscalYears: readonly string[];
  periods: readonly Readonly<{ id: string; label: string; fiscalYear: string; startsOn: string; endsOn: string }>[];
  accounts: readonly Readonly<{ id: string; label: string }>[];
  journalTypes: readonly Readonly<{ key: string; label: string }>[];
  sourceModules: readonly string[];
  currencies: readonly string[];
}>;

export function journalFilterText(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseJournalFilters(parameters: JournalFilterSearchParams = {}): JournalFilterState {
  const statusValues = Array.isArray(parameters.status) ? parameters.status : [parameters.status ?? ""];
  const values: JournalFilterValues = {
    dateFrom: journalFilterText(parameters.dateFrom),
    dateTo: journalFilterText(parameters.dateTo),
    fiscalYear: journalFilterText(parameters.fiscalYear),
    periodId: journalFilterText(parameters.periodId),
    status: [...new Set(statusValues.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))],
    accountId: journalFilterText(parameters.accountId),
    typeKey: journalFilterText(parameters.typeKey),
    ownerModule: journalFilterText(parameters.ownerModule),
    minAmount: journalFilterText(parameters.minAmount),
    maxAmount: journalFilterText(parameters.maxAmount),
    currency: journalFilterText(parameters.currency).toUpperCase(),
  };
  const errors: string[] = [];
  for (const [value, label] of [[values.dateFrom, "Accounting date from"], [values.dateTo, "Accounting date to"]]) {
    if (value && !validDate(value)) errors.push(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
  if (values.dateFrom && values.dateTo && validDate(values.dateFrom) && validDate(values.dateTo) && values.dateFrom > values.dateTo) {
    errors.push("Accounting date from must be on or before accounting date to.");
  }
  const amountPattern = /^\d{1,29}(?:\.\d{1,9})?$/;
  for (const [value, label] of [[values.minAmount, "Minimum amount"], [values.maxAmount, "Maximum amount"]]) {
    if (value && !amountPattern.test(value)) errors.push(`${label} must be a non-negative decimal with at most 29 whole digits and 9 decimal places.`);
  }
  if (values.minAmount && values.maxAmount && amountPattern.test(values.minAmount) && amountPattern.test(values.maxAmount) && new Decimal(values.minAmount).greaterThan(values.maxAmount)) {
    errors.push("Minimum amount must be less than or equal to maximum amount.");
  }
  if (values.status.some((status) => !journalFilterStatuses.some((allowed) => allowed === status))) errors.push("Choose a valid journal status.");
  if (values.fiscalYear && !/^\d{4}$/.test(values.fiscalYear)) errors.push("Choose a valid fiscal year.");
  for (const [value, label] of [[values.periodId, "Accounting period"], [values.accountId, "Natural account"]]) {
    if (value && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) errors.push(`${label} selection is invalid.`);
  }
  if (values.currency && !/^[A-Z]{3}$/.test(values.currency)) errors.push("Currency must be a three-letter code.");
  if (values.typeKey.length > 200 || values.ownerModule.length > 100) errors.push("Journal type or source module selection is too long.");
  return { values, errors };
}

export function journalFilterParameters(values: JournalFilterValues, search = ""): Record<string, string | undefined> {
  const parameters: Record<string, string | undefined> = { q: search.trim() || undefined };
  for (const [key, value] of Object.entries(values)) {
    parameters[key] = (typeof value === "string" ? value : value.join(",")) || undefined;
  }
  return parameters;
}

export function journalFilterHref(values: JournalFilterValues, search = "", remove?: keyof JournalFilterValues | "q", status?: string): string {
  const parameters = journalFilterParameters(values, search);
  if (remove === "status" && status) parameters.status = values.status.filter((value) => value !== status).join(",") || undefined;
  else if (remove) delete parameters[remove];
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) if (value) query.set(key, value);
  return query.size ? `/app/journals?${query}` : "/app/journals";
}

// The basis matches the register's journal debit total, including unposted lines.
export const journalFunctionalTotalSql = `CASE WHEN entry.status = 'POSTED' THEN entry.total_debit_functional
  ELSE coalesce((SELECT sum(amount_line.debit_functional) FROM journal_lines amount_line
    WHERE amount_line.organization_id = entry.organization_id AND amount_line.journal_entry_id = entry.id), 0) END`;

export function buildJournalRegisterPredicate(input: Readonly<{
  organizationId: string;
  selectedEntityId: string | null;
  search: string;
  filterState: JournalFilterState;
}>): Readonly<{ sql: string; parameters: unknown[] }> {
  const search = input.search.trim().slice(0, 100);
  const parameters: unknown[] = [input.organizationId, search, `%${search.replace(/[\\%_]/g, "\\$&")}%`, input.selectedEntityId];
  const conditions = [
    `entry.organization_id = $1`,
    `NOT EXISTS (SELECT 1 FROM journal_transaction_controls control
      WHERE control.organization_id = entry.organization_id AND control.journal_entry_id = entry.id AND control.outcome = 'DELETED')`,
    `($4::uuid IS NULL OR entry.legal_entity_id = $4::uuid)`,
    `($2 = '' OR entry.description ILIKE $3 ESCAPE '\\'
      OR entry.journal_type_key ILIKE $3 ESCAPE '\\' OR entity.code ILIKE $3 ESCAPE '\\'
      OR coalesce(entry.journal_number::text, 'draft') ILIKE $3 ESCAPE '\\')`,
  ];
  if (input.filterState.errors.length) conditions.push("FALSE");
  else {
    const filter = input.filterState.values;
    const bind = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    if (filter.dateFrom) conditions.push(`entry.accounting_date >= ${bind(filter.dateFrom)}::date`);
    if (filter.dateTo) conditions.push(`entry.accounting_date <= ${bind(filter.dateTo)}::date`);
    if (filter.fiscalYear) conditions.push(`entry_period.fiscal_year = ${bind(filter.fiscalYear)}::integer`);
    if (filter.periodId) conditions.push(`entry.period_id = ${bind(filter.periodId)}::uuid`);
    if (filter.status.length) conditions.push(`(CASE WHEN EXISTS (
      SELECT 1 FROM journal_entry_relations status_relation
      JOIN journal_entries status_reversal ON status_reversal.organization_id = status_relation.organization_id
        AND status_reversal.id = status_relation.from_journal_id
      WHERE status_relation.organization_id = entry.organization_id AND status_relation.to_journal_id = entry.id
        AND status_relation.kind = 'REVERSAL_OF' AND status_reversal.journal_number IS NOT NULL
    ) THEN 'REVERSED' ELSE entry.status::text END) = ANY(${bind(filter.status)}::text[])`);
    if (filter.accountId) conditions.push(`EXISTS (SELECT 1 FROM journal_lines filter_line
      JOIN account_combinations filter_combination ON filter_combination.organization_id = filter_line.organization_id
        AND filter_combination.id = filter_line.account_combination_id
      WHERE filter_line.organization_id = entry.organization_id AND filter_line.journal_entry_id = entry.id
        AND filter_combination.account_id = ${bind(filter.accountId)}::uuid)`);
    if (filter.typeKey) conditions.push(`entry.journal_type_key = ${bind(filter.typeKey)}`);
    if (filter.ownerModule) conditions.push(`journal_type.owner_module = ${bind(filter.ownerModule)}`);
    if (filter.currency) conditions.push(`entry.functional_currency = ${bind(filter.currency)}`);
    if (filter.minAmount) conditions.push(`(${journalFunctionalTotalSql}) >= ${bind(filter.minAmount)}::numeric`);
    if (filter.maxAmount) conditions.push(`(${journalFunctionalTotalSql}) <= ${bind(filter.maxAmount)}::numeric`);
  }
  return { sql: conditions.join("\n         AND "), parameters };
}
