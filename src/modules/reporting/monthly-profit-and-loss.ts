import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import { exact } from "@/kernel/money";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { presentAccountKey, type DisplayedAccountSegment } from "@/modules/ledger/account-key-display";
import type { ReportDimensions, ReportEntityOption, ReportFilterInput, ReportSelection } from "./tenant-reporting";

export class MonthlyReportScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyReportScopeError";
  }
}

export function monthlyReportAsOfDate(principal: SessionPrincipal): string {
  return principal.sessionMode === "demo" ? demoAccountingDate() : new Date().toISOString().slice(0, 10);
}

export function monthlyReportSelectionInput(
  dimensions: ReportDimensions,
  input: ReportFilterInput,
): ReportFilterInput {
  if (input.from || input.to || input.fromPeriod || input.toPeriod) return input;
  const entity = dimensions.entities.find((candidate) => candidate.id === input.entity)
    ?? dimensions.entities[0];
  const defaultPeriod = entity?.periods.find((period) => period.id === entity.defaultPeriodId)
    ?? entity?.periods.at(-1);
  const fiscalYear = defaultPeriod?.fiscalYear;
  const periods = entity?.periods.filter((period) => period.fiscalYear === fiscalYear)
    .sort((left, right) => (left.periodNumber ?? 0) - (right.periodNumber ?? 0) || left.startsOn.localeCompare(right.startsOn)) ?? [];
  if (fiscalYear && periods.length) {
    return { ...input, basis: "period", fromPeriod: periods[0]!.id, toPeriod: periods.at(-1)!.id };
  }
  const year = Number(defaultPeriod?.startsOn.slice(0, 4) ?? new Date().getUTCFullYear());
  return { ...input, basis: "date", from: `${year}-01-01`, to: `${year}-12-31` };
}

export type MonthlyReportColumn = Readonly<{
  key: string;
  label: string;
  startsOn: string;
  endsOn: string;
  includedFrom: string | null;
  includedTo: string | null;
  coverage: "COMPLETE" | "PARTIAL" | "FUTURE" | "EXCLUDED";
  periodState: string | null;
}>;

export type MonthlyProfitAndLossRow = Readonly<{
  entityCode: string;
  ledgerCode: string;
  currency: string;
  accountCode: string;
  combinationId: string;
  accountName: string;
  accountClass: "REVENUE" | "EXPENSE";
  canonicalKey: string;
  displayKey: string;
  displaySegments: readonly DisplayedAccountSegment[];
  amount: string;
  months: Readonly<Record<string, string>>;
}>;

export type MonthlyProfitAndLoss = Readonly<{
  selection: ReportSelection;
  fiscalYear: number;
  asOfDate: string;
  snapshotHash: string;
  columns: readonly MonthlyReportColumn[];
  rows: readonly MonthlyProfitAndLossRow[];
}>;

function dateMonth(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** The configured period order is authoritative for non-calendar fiscal years. */
export function monthlyReportColumns(
  entity: ReportEntityOption,
  selection: ReportSelection,
  asOfDate: string,
): Readonly<{ fiscalYear: number; columns: readonly MonthlyReportColumn[] }> {
  const selectedPeriod = (selection.basis === "period" ? entity.periods.find((period) => period.id === selection.toPeriodId) : null)
    ?? entity.periods.find((period) => period.startsOn <= selection.toDate && period.endsOn >= selection.toDate);
  const fiscalYear = selectedPeriod?.fiscalYear ?? Number(selection.toDate.slice(0, 4));
  const configured = entity.periods
    .filter((period) => period.fiscalYear === fiscalYear)
    .sort((left, right) => (left.periodNumber ?? 0) - (right.periodNumber ?? 0) || left.startsOn.localeCompare(right.startsOn));
  if (configured.length === 0 && entity.periods.some((period) => period.fiscalYear !== undefined)) {
    throw new MonthlyReportScopeError(`Fiscal year ${fiscalYear} has no configured periods for this ledger`);
  }
  if (configured.length > 0 && configured.length !== 12) {
    throw new MonthlyReportScopeError(`Fiscal year ${fiscalYear} has ${configured.length} configured periods; twelve are required for the monthly report`);
  }
  for (let index = 1; index < configured.length; index += 1) {
    const previous = configured[index - 1]!;
    const current = configured[index]!;
    const nextDay = new Date(Date.parse(`${previous.endsOn}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    if (current.startsOn !== nextDay) {
      throw new MonthlyReportScopeError(`Fiscal year ${fiscalYear} has overlapping or missing dates between ${previous.label} and ${current.label}`);
    }
  }
  const periods = configured.length === 12 ? configured : Array.from({ length: 12 }, (_, index) => ({
    id: `${fiscalYear}-${String(index + 1).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(fiscalYear, index, 1))),
    startsOn: dateMonth(fiscalYear, index, 1),
    endsOn: dateMonth(fiscalYear, index + 1, 0),
    state: null,
  }));
  if (selection.fromDate < periods[0]!.startsOn || selection.toDate > periods.at(-1)!.endsOn) {
    throw new MonthlyReportScopeError("A monthly profit-and-loss range must stay within one configured fiscal year");
  }
  return {
    fiscalYear,
    columns: periods.map((period) => {
      const from = [period.startsOn, selection.fromDate].sort().at(-1)!;
      const to = [period.endsOn, selection.toDate, asOfDate].sort()[0]!;
      const included = from <= to;
      return {
        key: period.id,
        label: period.label,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        includedFrom: included ? from : null,
        includedTo: included ? to : null,
        coverage: !included
          ? period.startsOn > asOfDate ? "FUTURE" : "EXCLUDED"
          : from > period.startsOn || to < period.endsOn ? "PARTIAL" : "COMPLETE",
        periodState: period.state ?? null,
      };
    }),
  };
}

export async function loadMonthlyProfitAndLoss(
  principal: SessionPrincipal,
  selection: ReportSelection,
  entity: ReportEntityOption,
  asOfDate: string,
): Promise<MonthlyProfitAndLoss> {
  if (entity.id !== selection.entityId || entity.ledgerId !== selection.ledgerId) {
    throw new Error("The monthly report entity and ledger must match the selected report scope");
  }
  const { fiscalYear, columns } = monthlyReportColumns(entity, selection, asOfDate);
  const included = columns.filter((column) => column.includedFrom && column.includedTo);
  if (included.length > 12) throw new Error("A monthly report cannot exceed twelve columns");
  const data = await withWorkspaceTenantRead({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    requestId: `monthly-profit-and-loss:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
    sessionMode: principal.sessionMode,
  }, "/app/reports/profit-and-loss", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    if (included.length === 0) return { rows: [] as MonthlyProfitAndLossRow[], sourceMarkers: [] as readonly unknown[] };
    const result = await client.query<{
      bucket_key: string; entity_code: string; ledger_code: string; functional_currency: string;
      account_code: string; account_name: string; account_class: "REVENUE" | "EXPENSE";
      combination_id: string;
      canonical_key: string; account_segment_definitions: unknown; debit: string; credit: string;
      line_count: string; last_posted_at: string | null;
    }>(
      `WITH buckets AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb)
           AS bucket(bucket_key text, starts_on date, ends_on date)
       )
       SELECT bucket.bucket_key, combination.id AS combination_id, entity.code AS entity_code, ledger.code AS ledger_code,
         ledger.functional_currency, account.code AS account_code,
         account.display_name AS account_name, account.class::text AS account_class,
         concat_ws('.', entity.code, account.code,
           coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
           coalesce(intercompany.code, '0000'),
           coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
           coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
           coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
           coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'key', definition.key, 'displayName', definition.display_name,
              'visible', definition.visible) ORDER BY definition.ordinal), '[]'::jsonb)
          FROM segment_definitions definition
          WHERE definition.organization_id = $1) AS account_segment_definitions,
         sum(line.debit_functional)::text AS debit,
         sum(line.credit_functional)::text AS credit,
         count(*)::text AS line_count,
         max(entry.posted_at)::text AS last_posted_at
       FROM buckets bucket
       JOIN journal_entries entry ON entry.organization_id = $1
         AND entry.legal_entity_id = $2 AND entry.ledger_id = $3
         AND entry.status = 'POSTED'
         AND entry.accounting_date BETWEEN bucket.starts_on AND bucket.ends_on
       JOIN journal_lines line ON line.organization_id = entry.organization_id
         AND line.journal_entry_id = entry.id
       JOIN account_combinations combination ON combination.organization_id = line.organization_id
         AND combination.id = line.account_combination_id
         AND combination.entity_id = $2 AND combination.ledger_id = $3
       JOIN legal_entities entity ON entity.organization_id = combination.organization_id
         AND entity.id = combination.entity_id
       JOIN ledgers ledger ON ledger.organization_id = combination.organization_id
         AND ledger.id = combination.ledger_id
       JOIN gl_accounts account ON account.organization_id = combination.organization_id
         AND account.id = combination.account_id AND account.class IN ('REVENUE', 'EXPENSE')
       LEFT JOIN segment_values subaccount ON subaccount.organization_id = combination.organization_id AND subaccount.id = combination.subaccount_id
       LEFT JOIN segment_values department ON department.organization_id = combination.organization_id AND department.id = combination.department_id
       LEFT JOIN legal_entities intercompany ON intercompany.organization_id = combination.organization_id AND intercompany.id = combination.intercompany_entity_id
       LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
       LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
       LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
       LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
       LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
       LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
       LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
       LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
       WHERE ($5::text IS NULL OR account.code = $5::text)
         AND ($6::text IS NULL OR coalesce(subaccount.code, '0000') = $6::text)
         AND ($7::text IS NULL OR coalesce(department.code, '0000') = $7::text)
         AND ($8::text IS NULL OR coalesce(intercompany.code, '0000') = $8::text)
         AND ($9::text IS NULL OR coalesce(custom1.code, '0000') = $9::text)
         AND ($10::text IS NULL OR coalesce(custom2.code, '0000') = $10::text)
         AND ($11::text IS NULL OR coalesce(custom3.code, '0000') = $11::text)
         AND ($12::text IS NULL OR coalesce(custom4.code, '0000') = $12::text)
         AND ($13::text IS NULL OR coalesce(custom5.code, '0000') = $13::text)
         AND ($14::text IS NULL OR coalesce(custom6.code, '0000') = $14::text)
         AND ($15::text IS NULL OR coalesce(custom7.code, '0000') = $15::text)
         AND ($16::text IS NULL OR coalesce(custom8.code, '0000') = $16::text)
       GROUP BY bucket.bucket_key, entity.id, entity.code, ledger.code, ledger.functional_currency,
         account.code, account.display_name, account.class, combination.id,
         subaccount.code, department.code, intercompany.code,
         custom1.code, custom2.code, custom3.code, custom4.code,
         custom5.code, custom6.code, custom7.code, custom8.code
       ORDER BY account.code, canonical_key, bucket.bucket_key
       LIMIT 2401`,
      [principal.organizationId, selection.entityId, selection.ledgerId,
        JSON.stringify(included.map((column) => ({
          bucket_key: column.key, starts_on: column.includedFrom, ends_on: column.includedTo,
        }))),
        selection.accountCode ?? null,
        selection.segmentFilters?.subaccount ?? null,
        selection.segmentFilters?.department ?? null,
        selection.segmentFilters?.intercompany ?? null,
        selection.segmentFilters?.custom1 ?? null,
        selection.segmentFilters?.custom2 ?? null,
        selection.segmentFilters?.custom3 ?? null,
        selection.segmentFilters?.custom4 ?? null,
        selection.segmentFilters?.custom5 ?? null,
        selection.segmentFilters?.custom6 ?? null,
        selection.segmentFilters?.custom7 ?? null,
        selection.segmentFilters?.custom8 ?? null],
    );
    if (result.rows.length > 2400) {
      throw new Error("The monthly report exceeds 2,400 account-month rows. Narrow the account or segment filters.");
    }
    const grouped = new Map<string, MonthlyProfitAndLossRow>();
    for (const row of result.rows) {
      const displayed = presentAccountKey(row.canonical_key, row.account_segment_definitions);
      const amount = row.account_class === "REVENUE"
        ? exact(row.credit).minus(row.debit)
        : exact(row.debit).minus(row.credit);
      const key = `${row.account_class}:${row.combination_id}`;
      const previous = grouped.get(key);
      grouped.set(key, {
        entityCode: row.entity_code,
        ledgerCode: row.ledger_code,
        currency: row.functional_currency,
        accountCode: row.account_code,
        combinationId: row.combination_id,
        accountName: row.account_name,
        accountClass: row.account_class,
        canonicalKey: displayed.canonicalKey,
        displayKey: displayed.displayKey,
        displaySegments: displayed.displaySegments,
        amount: exact(previous?.amount ?? 0).plus(amount).toFixed(),
        months: {
          ...previous?.months,
          [row.bucket_key]: exact(previous?.months[row.bucket_key] ?? 0).plus(amount).toFixed(),
        },
      });
    }
    return {
      rows: [...grouped.values()],
      sourceMarkers: result.rows.map((row) => [row.bucket_key, row.combination_id, row.line_count, row.last_posted_at]),
    };
  });
  const snapshotHash = createHash("sha256").update(JSON.stringify({ selection, fiscalYear, asOfDate, columns, rows: data.rows, sourceMarkers: data.sourceMarkers })).digest("hex");
  return { selection, fiscalYear, asOfDate, snapshotHash, columns, rows: data.rows };
}
