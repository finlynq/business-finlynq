import "server-only";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import { exact } from "@/kernel/money";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import {
  presentAccountKey,
  type DisplayedAccountSegment,
} from "@/modules/ledger/account-key-display";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    requestId: `report:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
    sessionMode: principal.sessionMode,
  };
}

async function assertReportPermission(
  client: PoolClient,
  principal: SessionPrincipal,
  permission: Permission,
): Promise<void> {
  await assertActorHasActivePermission(client, {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    permission,
  });
}

export type EntitySummary = Readonly<{
  id: string;
  code: string;
  displayName: string;
  countryCode: string;
  regionCode: string;
  accountingProfile: string;
  ledgerId: string;
  ledgerCode: string;
  functionalCurrency: string;
  periodLabel: string | null;
  periodState: string | null;
}>;

export async function loadEntitySummaries(principal: SessionPrincipal): Promise<readonly EntitySummary[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/entities", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    const asOfDate = principal.sessionMode === "demo"
      ? demoAccountingDate()
      : new Date().toISOString().slice(0, 10);
    const result = await client.query<{
      id: string; code: string; display_name: string; country_code: string; region_code: string;
      accounting_profile: string; ledger_id: string; ledger_code: string; functional_currency: string;
      period_label: string | null; period_state: string | null;
    }>(
      `SELECT entity.id, entity.code, entity.display_name, entity.country_code,
         entity.region_code, ledger.accounting_profile, ledger.id AS ledger_id,
         ledger.code AS ledger_code, ledger.functional_currency,
         current_period.label AS period_label, current_period.state::text AS period_state
       FROM legal_entities entity
       JOIN ledgers ledger ON ledger.organization_id = entity.organization_id
         AND ledger.legal_entity_id = entity.id AND ledger.kind = 'PRIMARY' AND ledger.active
       LEFT JOIN LATERAL (
         SELECT period.label, period.state
         FROM fiscal_periods period
         WHERE period.organization_id = entity.organization_id AND period.ledger_id = ledger.id
         ORDER BY ($2::date BETWEEN period.starts_on AND period.ends_on) DESC,
           period.starts_on DESC LIMIT 1
       ) current_period ON true
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code`,
      [principal.organizationId, asOfDate],
    );
    return result.rows.map((row) => ({
      id: row.id, code: row.code, displayName: row.display_name,
      countryCode: row.country_code, regionCode: row.region_code,
      accountingProfile: row.accounting_profile, ledgerId: row.ledger_id,
      ledgerCode: row.ledger_code, functionalCurrency: row.functional_currency,
      periodLabel: row.period_label, periodState: row.period_state,
    }));
  });
}

export type TrialBalanceRow = Readonly<{
  entityId: string;
  entityCode: string;
  ledgerCode: string;
  currency: string;
  accountCode: string;
  accountName: string;
  accountClass: string;
  canonicalKey: string;
  displayKey: string;
  displaySegments: readonly DisplayedAccountSegment[];
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  debit: string;
  credit: string;
}>;

export type ReportPeriodOption = Readonly<{
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
}>;

export type ReportAccountOption = Readonly<{
  id: string;
  code: string;
  displayName: string;
  accountClass: string;
}>;

export type ReportEntityOption = Readonly<{
  id: string;
  code: string;
  displayName: string;
  ledgerId: string;
  ledgerCode: string;
  currency: string;
  defaultPeriodId: string | null;
  periods: readonly ReportPeriodOption[];
  accounts: readonly ReportAccountOption[];
}>;

export type ReportDimensions = Readonly<{
  entities: readonly ReportEntityOption[];
}>;

export type ReportFilterInput = Readonly<{
  entity?: string;
  basis?: string;
  from?: string;
  to?: string;
  fromPeriod?: string;
  toPeriod?: string;
  account?: string;
}>;

export function reportFilterInput(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): ReportFilterInput {
  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === "string" ? value : value?.[0];
  };
  return {
    entity: one("entity"),
    basis: one("basis"),
    from: one("from"),
    to: one("to"),
    fromPeriod: one("fromPeriod"),
    toPeriod: one("toPeriod"),
    account: one("account"),
  };
}

export type ReportSelection = Readonly<{
  entityId: string;
  entityCode: string;
  entityName: string;
  ledgerId: string;
  ledgerCode: string;
  currency: string;
  basis: "period" | "date";
  fromDate: string;
  toDate: string;
  fromPeriodId: string | null;
  toPeriodId: string | null;
  accountId: string | null;
}>;

export async function loadReportDimensions(principal: SessionPrincipal): Promise<ReportDimensions> {
  return withWorkspaceTenantRead(readContext(principal), "/app/reports", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    const asOfDate = principal.sessionMode === "demo"
      ? demoAccountingDate()
      : new Date().toISOString().slice(0, 10);
    const entityResult = await client.query<{
      id: string;
      code: string;
      display_name: string;
      ledger_id: string;
      ledger_code: string;
      functional_currency: string;
    }>(
      `SELECT entity.id, entity.code, entity.display_name,
         ledger.id AS ledger_id, ledger.code AS ledger_code,
         ledger.functional_currency
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.kind = 'PRIMARY' AND ledger.active
       WHERE entity.organization_id = $1 AND entity.active
       ORDER BY entity.code`,
      [principal.organizationId],
    );
    const periodResult = await client.query<{
      id: string;
      ledger_id: string;
      label: string;
      starts_on: string;
      ends_on: string;
    }>(
      `SELECT period.id, period.ledger_id, period.label,
         period.starts_on::text, period.ends_on::text
       FROM fiscal_periods period
       JOIN ledgers ledger
         ON ledger.organization_id = period.organization_id
        AND ledger.id = period.ledger_id AND ledger.active
       WHERE period.organization_id = $1
       ORDER BY period.starts_on, period.period_number`,
      [principal.organizationId],
    );
    const accountResult = await client.query<{
      entity_id: string;
      id: string;
      code: string;
      display_name: string;
      account_class: string;
    }>(
      `SELECT DISTINCT combination.entity_id, account.id, account.code,
         account.display_name, account.class::text AS account_class
       FROM account_combinations combination
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.id = combination.account_id
       JOIN legal_entities entity
         ON entity.organization_id = combination.organization_id
        AND entity.id = combination.entity_id AND entity.active
       WHERE combination.organization_id = $1 AND account.active
       ORDER BY combination.entity_id, account.code`,
      [principal.organizationId],
    );
    return {
      entities: entityResult.rows.map((entity) => {
        const periods = periodResult.rows
          .filter((period) => period.ledger_id === entity.ledger_id)
          .map((period) => ({
            id: period.id,
            label: period.label,
            startsOn: period.starts_on,
            endsOn: period.ends_on,
          }));
        const currentPeriod = periods.find((period) => (
          asOfDate >= period.startsOn && asOfDate <= period.endsOn
        ));
        return {
          id: entity.id,
          code: entity.code,
          displayName: entity.display_name,
          ledgerId: entity.ledger_id,
          ledgerCode: entity.ledger_code,
          currency: entity.functional_currency,
          defaultPeriodId: currentPeriod?.id ?? periods.at(-1)?.id ?? null,
          periods,
          accounts: accountResult.rows
            .filter((account) => account.entity_id === entity.id)
            .map((account) => ({
              id: account.id,
              code: account.code,
              displayName: account.display_name,
              accountClass: account.account_class,
            })),
        };
      }),
    };
  });
}

function validDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

export function resolveReportSelection(
  dimensions: ReportDimensions,
  input: ReportFilterInput = {},
): ReportSelection | null {
  const entity = dimensions.entities.find((candidate) => candidate.id === input.entity)
    ?? dimensions.entities[0];
  if (!entity) return null;
  const defaultPeriod = entity.periods.find((period) => period.id === entity.defaultPeriodId)
    ?? entity.periods.at(-1);
  const requestedFromPeriod = entity.periods.find((period) => period.id === input.fromPeriod)
    ?? defaultPeriod;
  const requestedToPeriod = entity.periods.find((period) => period.id === input.toPeriod)
    ?? defaultPeriod;
  const basis = input.basis === "date" ? "date" : "period";
  const fallbackDate = new Date().toISOString().slice(0, 10);
  let fromDate = basis === "date"
    ? validDate(input.from) ?? requestedFromPeriod?.startsOn ?? fallbackDate
    : requestedFromPeriod?.startsOn ?? validDate(input.from) ?? fallbackDate;
  let toDate = basis === "date"
    ? validDate(input.to) ?? requestedToPeriod?.endsOn ?? fromDate
    : requestedToPeriod?.endsOn ?? validDate(input.to) ?? fromDate;
  let fromPeriodId = requestedFromPeriod?.id ?? null;
  let toPeriodId = requestedToPeriod?.id ?? null;
  if (fromDate > toDate) {
    [fromDate, toDate] = [toDate, fromDate];
    [fromPeriodId, toPeriodId] = [toPeriodId, fromPeriodId];
  }
  const account = entity.accounts.find((candidate) => candidate.id === input.account)
    ?? entity.accounts[0];
  return {
    entityId: entity.id,
    entityCode: entity.code,
    entityName: entity.displayName,
    ledgerId: entity.ledgerId,
    ledgerCode: entity.ledgerCode,
    currency: entity.currency,
    basis,
    fromDate,
    toDate,
    fromPeriodId,
    toPeriodId,
    accountId: account?.id ?? null,
  };
}

export function reportSearchParams(selection: ReportSelection): URLSearchParams {
  const params = new URLSearchParams({
    entity: selection.entityId,
    basis: selection.basis,
    from: selection.fromDate,
    to: selection.toDate,
  });
  if (selection.fromPeriodId) params.set("fromPeriod", selection.fromPeriodId);
  if (selection.toPeriodId) params.set("toPeriod", selection.toPeriodId);
  if (selection.accountId) params.set("account", selection.accountId);
  return params;
}

export async function loadTrialBalance(
  principal: SessionPrincipal,
  selection?: ReportSelection | null,
): Promise<readonly TrialBalanceRow[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/reports/trial-balance", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    const result = await client.query<{
      entity_id: string; entity_code: string; ledger_code: string; functional_currency: string;
      account_code: string; account_name: string; account_class: string;
      canonical_key: string; account_segment_definitions: unknown;
      opening_debit: string; opening_credit: string;
      period_debit: string; period_credit: string; debit: string; credit: string;
    }>(
      `SELECT entity.id AS entity_id, entity.code AS entity_code, ledger.code AS ledger_code,
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
              'key', definition.key,
              'displayName', definition.display_name,
              'visible', definition.visible
            ) ORDER BY definition.ordinal), '[]'::jsonb)
          FROM segment_definitions definition
          WHERE definition.organization_id = $1
         ) AS account_segment_definitions,
         greatest(coalesce(sum(line.debit_functional - line.credit_functional)
           FILTER (WHERE $3::date IS NOT NULL AND entry.accounting_date < $3::date), 0), 0)::text AS opening_debit,
         greatest(-coalesce(sum(line.debit_functional - line.credit_functional)
           FILTER (WHERE $3::date IS NOT NULL AND entry.accounting_date < $3::date), 0), 0)::text AS opening_credit,
         coalesce(sum(line.debit_functional)
           FILTER (WHERE ($3::date IS NULL OR entry.accounting_date >= $3::date)
             AND ($4::date IS NULL OR entry.accounting_date <= $4::date)), 0)::text AS period_debit,
         coalesce(sum(line.credit_functional)
           FILTER (WHERE ($3::date IS NULL OR entry.accounting_date >= $3::date)
             AND ($4::date IS NULL OR entry.accounting_date <= $4::date)), 0)::text AS period_credit,
         greatest(coalesce(sum(line.debit_functional - line.credit_functional)
           FILTER (WHERE $4::date IS NULL OR entry.accounting_date <= $4::date), 0), 0)::text AS debit,
         greatest(-coalesce(sum(line.debit_functional - line.credit_functional)
           FILTER (WHERE $4::date IS NULL OR entry.accounting_date <= $4::date), 0), 0)::text AS credit
       FROM journal_lines line
       JOIN journal_entries entry
         ON entry.organization_id = line.organization_id
        AND entry.id = line.journal_entry_id AND entry.status = 'POSTED'
       JOIN account_combinations combination
         ON combination.organization_id = line.organization_id
        AND combination.id = line.account_combination_id
       JOIN legal_entities entity ON entity.organization_id = combination.organization_id
         AND entity.id = combination.entity_id
       JOIN ledgers ledger ON ledger.organization_id = combination.organization_id
         AND ledger.id = combination.ledger_id
       JOIN gl_accounts account ON account.organization_id = combination.organization_id
         AND account.id = combination.account_id
       LEFT JOIN segment_values subaccount ON subaccount.organization_id = combination.organization_id
         AND subaccount.id = combination.subaccount_id
       LEFT JOIN segment_values department ON department.organization_id = combination.organization_id
         AND department.id = combination.department_id
       LEFT JOIN legal_entities intercompany ON intercompany.organization_id = combination.organization_id
         AND intercompany.id = combination.intercompany_entity_id
       LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
       LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
       LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
       LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
       LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
       LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
       LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
       LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
       WHERE line.organization_id = $1
         AND ($2::uuid IS NULL OR entry.legal_entity_id = $2::uuid)
         AND ($4::date IS NULL OR entry.accounting_date <= $4::date)
       GROUP BY entity.id, entity.code, ledger.code, ledger.functional_currency,
         account.code, account.display_name, account.class, combination.id,
         subaccount.code, department.code, intercompany.code,
         custom1.code, custom2.code, custom3.code, custom4.code,
         custom5.code, custom6.code, custom7.code, custom8.code
       HAVING coalesce(sum(line.debit_functional), 0) <> 0
           OR coalesce(sum(line.credit_functional), 0) <> 0
       ORDER BY entity.code, account.code, canonical_key`,
      [
        principal.organizationId,
        selection?.entityId ?? null,
        selection?.fromDate ?? null,
        selection?.toDate ?? null,
      ],
    );
    return result.rows.map((row) => {
      const presentedKey = presentAccountKey(
        row.canonical_key,
        row.account_segment_definitions,
      );
      return {
        entityId: row.entity_id, entityCode: row.entity_code, ledgerCode: row.ledger_code,
        currency: row.functional_currency, accountCode: row.account_code,
        accountName: row.account_name, accountClass: row.account_class,
        canonicalKey: presentedKey.canonicalKey,
        displayKey: presentedKey.displayKey,
        displaySegments: presentedKey.displaySegments,
        openingDebit: row.opening_debit,
        openingCredit: row.opening_credit,
        periodDebit: row.period_debit,
        periodCredit: row.period_credit,
        debit: row.debit,
        credit: row.credit,
      };
    });
  });
}

export type FinancialStatementRow = Readonly<{
  entityCode: string;
  ledgerCode: string;
  currency: string;
  accountCode: string;
  accountName: string;
  accountClass: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  canonicalKey: string;
  displayKey: string;
  displaySegments: readonly DisplayedAccountSegment[];
  amount: string;
  synthetic: boolean;
}>;

function statementAmount(row: TrialBalanceRow, periodActivity: boolean): string {
  const debit = exact(periodActivity ? row.periodDebit : row.debit);
  const credit = exact(periodActivity ? row.periodCredit : row.credit);
  return (row.accountClass === "ASSET" || row.accountClass === "EXPENSE")
    ? debit.minus(credit).toFixed()
    : credit.minus(debit).toFixed();
}

export function balanceSheetRows(rows: readonly TrialBalanceRow[]): readonly FinancialStatementRow[] {
  const statementRows: FinancialStatementRow[] = rows
    .filter((row) => ["ASSET", "LIABILITY", "EQUITY"].includes(row.accountClass))
    .map((row) => ({
      entityCode: row.entityCode,
      ledgerCode: row.ledgerCode,
      currency: row.currency,
      accountCode: row.accountCode,
      accountName: row.accountName,
      accountClass: row.accountClass as "ASSET" | "LIABILITY" | "EQUITY",
      canonicalKey: row.canonicalKey,
      displayKey: row.displayKey,
      displaySegments: row.displaySegments,
      amount: statementAmount(row, false),
      synthetic: false,
    }));
  const earnings = new Map<string, { entityCode: string; ledgerCode: string; currency: string; amount: ReturnType<typeof exact> }>();
  for (const row of rows.filter((candidate) => candidate.accountClass === "REVENUE" || candidate.accountClass === "EXPENSE")) {
    const key = `${row.entityCode}:${row.ledgerCode}:${row.currency}`;
    const existing = earnings.get(key) ?? {
      entityCode: row.entityCode,
      ledgerCode: row.ledgerCode,
      currency: row.currency,
      amount: exact(0),
    };
    const amount = exact(statementAmount(row, false));
    existing.amount = row.accountClass === "REVENUE"
      ? existing.amount.plus(amount)
      : existing.amount.minus(amount);
    earnings.set(key, existing);
  }
  for (const earning of earnings.values()) {
    statementRows.push({
      entityCode: earning.entityCode,
      ledgerCode: earning.ledgerCode,
      currency: earning.currency,
      accountCode: "UNCLSD-EARNINGS",
      accountName: "Unclosed earnings",
      accountClass: "EQUITY",
      canonicalKey: `${earning.entityCode}.UNCLSD-EARNINGS`,
      displayKey: `${earning.entityCode}.UNCLSD-EARNINGS`,
      displaySegments: [
        { key: "entity", displayName: "Entity", code: earning.entityCode },
        { key: "account", displayName: "Account", code: "UNCLSD-EARNINGS" },
      ],
      amount: earning.amount.toFixed(),
      synthetic: true,
    });
  }
  return statementRows;
}

export function profitAndLossRows(rows: readonly TrialBalanceRow[]): readonly FinancialStatementRow[] {
  return rows
    .filter((row) => (
      (row.accountClass === "REVENUE" || row.accountClass === "EXPENSE") &&
      !exact(row.periodDebit).equals(row.periodCredit)
    ))
    .map((row) => ({
      entityCode: row.entityCode,
      ledgerCode: row.ledgerCode,
      currency: row.currency,
      accountCode: row.accountCode,
      accountName: row.accountName,
      accountClass: row.accountClass as "REVENUE" | "EXPENSE",
      canonicalKey: row.canonicalKey,
      displayKey: row.displayKey,
      displaySegments: row.displaySegments,
      amount: statementAmount(row, true),
      synthetic: false,
    }));
}

export type AccountInquiryLine = Readonly<{
  id: string;
  journalId: string;
  journalNumber: string;
  accountingDate: string;
  description: string;
  canonicalKey: string;
  displayKey: string;
  displaySegments: readonly DisplayedAccountSegment[];
  memo: string | null;
  transactionCurrency: string;
  debitTransaction: string;
  creditTransaction: string;
  fxRate: string;
  fxRateSource: string;
  fxRateEffectiveAt: string;
  debitFunctional: string;
  creditFunctional: string;
  runningFunctionalBalance: string;
}>;

export type AccountInquiry = Readonly<{
  openingBalance: string;
  lines: readonly AccountInquiryLine[];
}>;

export async function loadAccountInquiry(
  principal: SessionPrincipal,
  selection: ReportSelection,
): Promise<AccountInquiry> {
  return withWorkspaceTenantRead(readContext(principal), "/app/reports/account-inquiry", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readMcpLedger);
    if (!selection.accountId) return { openingBalance: "0", lines: [] };
    const openingResult = await client.query<{ opening_balance: string }>(
      `SELECT coalesce(sum(CASE
           WHEN account.class IN ('ASSET', 'EXPENSE')
             THEN line.debit_functional - line.credit_functional
           ELSE line.credit_functional - line.debit_functional
         END), 0)::text AS opening_balance
       FROM journal_lines line
       JOIN journal_entries entry
         ON entry.organization_id = line.organization_id
        AND entry.id = line.journal_entry_id AND entry.status = 'POSTED'
       JOIN account_combinations combination
         ON combination.organization_id = line.organization_id
        AND combination.id = line.account_combination_id
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.id = combination.account_id
       WHERE line.organization_id = $1
         AND entry.legal_entity_id = $2
         AND combination.account_id = $3
         AND entry.accounting_date < $4::date`,
      [principal.organizationId, selection.entityId, selection.accountId, selection.fromDate],
    );
    const lineResult = await client.query<{
      id: string;
      journal_id: string;
      journal_number: number | null;
      accounting_date: string;
      description: string;
      canonical_key: string;
      account_segment_definitions: unknown;
      memo: string | null;
      transaction_currency: string;
      debit_transaction: string;
      credit_transaction: string;
      fx_rate: string;
      fx_rate_source: string;
      fx_rate_effective_at: string;
      debit_functional: string;
      credit_functional: string;
      account_class: string;
    }>(
      `SELECT line.id, entry.id AS journal_id, entry.journal_number,
         entry.accounting_date::text, entry.description,
         concat_ws('.', entity.code, account.code,
           coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
           coalesce(intercompany.code, '0000'),
           coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
           coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
           coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
           coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'key', definition.key,
              'displayName', definition.display_name,
              'visible', definition.visible
            ) ORDER BY definition.ordinal), '[]'::jsonb)
          FROM segment_definitions definition
          WHERE definition.organization_id = $1
         ) AS account_segment_definitions,
         line.memo, line.transaction_currency,
         line.debit_transaction::text, line.credit_transaction::text,
         line.fx_rate::text, line.fx_rate_source, line.fx_rate_effective_at::text,
         line.debit_functional::text, line.credit_functional::text,
         account.class::text AS account_class
       FROM journal_lines line
       JOIN journal_entries entry
         ON entry.organization_id = line.organization_id
        AND entry.id = line.journal_entry_id AND entry.status = 'POSTED'
       JOIN account_combinations combination
         ON combination.organization_id = line.organization_id
        AND combination.id = line.account_combination_id
       JOIN legal_entities entity
         ON entity.organization_id = combination.organization_id
        AND entity.id = combination.entity_id
       JOIN gl_accounts account
         ON account.organization_id = combination.organization_id
        AND account.id = combination.account_id
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
       WHERE line.organization_id = $1
         AND entry.legal_entity_id = $2
         AND combination.account_id = $3
         AND entry.accounting_date BETWEEN $4::date AND $5::date
       ORDER BY entry.accounting_date, entry.posted_at, entry.journal_number, line.line_number, line.id`,
      [
        principal.organizationId,
        selection.entityId,
        selection.accountId,
        selection.fromDate,
        selection.toDate,
      ],
    );
    const openingBalance = openingResult.rows[0]?.opening_balance ?? "0";
    let runningBalance = exact(openingBalance);
    return {
      openingBalance,
      lines: lineResult.rows.map((line) => {
        const presentedKey = presentAccountKey(
          line.canonical_key,
          line.account_segment_definitions,
        );
        const naturalMovement = line.account_class === "ASSET" || line.account_class === "EXPENSE"
          ? exact(line.debit_functional).minus(line.credit_functional)
          : exact(line.credit_functional).minus(line.debit_functional);
        runningBalance = runningBalance.plus(naturalMovement);
        return {
          id: line.id,
          journalId: line.journal_id,
          journalNumber: line.journal_number === null ? "Unnumbered" : String(line.journal_number),
          accountingDate: line.accounting_date,
          description: line.description,
          canonicalKey: presentedKey.canonicalKey,
          displayKey: presentedKey.displayKey,
          displaySegments: presentedKey.displaySegments,
          memo: line.memo,
          transactionCurrency: line.transaction_currency,
          debitTransaction: line.debit_transaction,
          creditTransaction: line.credit_transaction,
          fxRate: line.fx_rate,
          fxRateSource: line.fx_rate_source,
          fxRateEffectiveAt: line.fx_rate_effective_at,
          debitFunctional: line.debit_functional,
          creditFunctional: line.credit_functional,
          runningFunctionalBalance: runningBalance.toFixed(),
        };
      }),
    };
  });
}

export type AccountingOverview = Readonly<{
  access: Readonly<{
    ledger: boolean;
    receivables: boolean;
    payables: boolean;
    tax: boolean;
  }>;
  postedJournalCount: number;
  unpostedJournalCount: number;
  taxDecisionCount: number;
  manualReviewTaxCount: number;
  openReceivables: readonly Readonly<{ currency: string; amount: string }>[];
  openPayables: readonly Readonly<{ currency: string; amount: string }>[];
}>;

export async function loadAccountingOverview(principal: SessionPrincipal): Promise<AccountingOverview> {
  return withWorkspaceTenantRead(readContext(principal), "/app", async (client) => {
    const canReadLedger = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readMcpLedger,
    });
    const canReadReceivables = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readReceivables,
    });
    const canReadPayables = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readPayables,
    });
    const canReadTax = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const journalCounts = canReadLedger ? await client.query<{ posted: number; unposted: number }>(
        `SELECT count(*) FILTER (WHERE status = 'POSTED')::int AS posted,
           count(*) FILTER (WHERE status IN ('DRAFT','SUBMITTED','APPROVED'))::int AS unposted
         FROM journal_entries WHERE organization_id = $1`, [principal.organizationId],
      ) : { rows: [{ posted: 0, unposted: 0 }] };
    const taxCounts = canReadTax ? await client.query<{ total: number; manual_review: number }>(
        `WITH current_draft_decisions AS (
           SELECT line.value -> 'taxDecision' ->> 'status' AS status
           FROM source_documents source
           CROSS JOIN LATERAL jsonb_array_elements(source.snapshot -> 'lines') AS line(value)
           WHERE source.organization_id = $1
             AND source.status = 'DRAFT'
             AND source.source_type IN ('receivables.sales-invoice', 'payables.supplier-bill')
             AND NOT EXISTS (
               SELECT 1 FROM source_documents newer
               WHERE newer.organization_id = source.organization_id
                 AND newer.source_type = source.source_type
                 AND newer.source_number = source.source_number
                 AND newer.version > source.version
             )
         )
         SELECT ((SELECT count(*) FROM tax_determination_snapshots snapshot
                    WHERE snapshot.organization_id = $1)
                 + (SELECT count(*) FROM current_draft_decisions))::int AS total,
           ((SELECT count(*) FROM tax_determination_snapshots snapshot
               WHERE snapshot.organization_id = $1
                 AND snapshot.status IN ('MANUAL_REVIEW', 'MANUAL_REVIEW_REQUIRED'))
             + (SELECT count(*) FROM current_draft_decisions
                  WHERE status = 'MANUAL_REVIEW_REQUIRED'))::int AS manual_review`,
        [principal.organizationId],
      ) : { rows: [{ total: 0, manual_review: 0 }] };
    const openBalances = canReadReceivables || canReadPayables
        ? await client.query<{ role: "CUSTOMER" | "SUPPLIER"; currency: string; amount: string }>(
        `SELECT account.role, balance.transaction_currency AS currency,
           coalesce(sum(balance.open_transaction_amount), 0)::text AS amount
         FROM open_item_balances balance
         JOIN party_accounts account ON account.organization_id = balance.organization_id
           AND account.id = balance.party_account_id
         WHERE balance.organization_id = $1 AND balance.open_transaction_amount > 0
           AND ((account.role = 'CUSTOMER' AND $2::boolean)
             OR (account.role = 'SUPPLIER' AND $3::boolean))
         GROUP BY account.role, balance.transaction_currency
         ORDER BY account.role, balance.transaction_currency`,
        [principal.organizationId, canReadReceivables, canReadPayables],
      ) : { rows: [] as { role: "CUSTOMER" | "SUPPLIER"; currency: string; amount: string }[] };
    return {
      access: {
        ledger: canReadLedger,
        receivables: canReadReceivables,
        payables: canReadPayables,
        tax: canReadTax,
      },
      postedJournalCount: journalCounts.rows[0]?.posted ?? 0,
      unpostedJournalCount: journalCounts.rows[0]?.unposted ?? 0,
      taxDecisionCount: taxCounts.rows[0]?.total ?? 0,
      manualReviewTaxCount: taxCounts.rows[0]?.manual_review ?? 0,
      openReceivables: openBalances.rows.filter((row) => row.role === "CUSTOMER")
        .map((row) => ({ currency: row.currency, amount: row.amount })),
      openPayables: openBalances.rows.filter((row) => row.role === "SUPPLIER")
        .map((row) => ({ currency: row.currency, amount: row.amount })),
    };
  });
}

function csvValue(value: string): string {
  const spreadsheetSafeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}

export function trialBalanceCsv(rows: readonly TrialBalanceRow[]): string {
  return [
    ["Entity", "Ledger", "Currency", "Account", "Displayed key", "Canonical key", "Name", "Class",
      "Opening debit", "Opening credit", "Period debit", "Period credit", "Ending debit", "Ending credit"],
    ...rows.map((row) => [row.entityCode, row.ledgerCode, row.currency, row.accountCode,
      row.displayKey, row.canonicalKey, row.accountName, row.accountClass,
      row.openingDebit, row.openingCredit, row.periodDebit, row.periodCredit, row.debit, row.credit]),
  ].map((row) => row.map(csvValue).join(",")).join("\r\n");
}

export type TaxDeterminationSummary = Readonly<{
  id: string;
  entityCode: string;
  ledgerCode: string;
  sourceDocumentId: string;
  sourceType: string;
  sourceNumber: string;
  sourceStatus: string;
  status: string;
  ruleKey: string;
  jurisdiction: string;
  currency: string;
  taxableBasis: string;
  totalTax: string;
  packKey: string;
  packVersion: string;
  createdAt: string;
  reviewReason: string | null;
}>;

type TaxDeterminationRow = Readonly<{
  id: string;
  entity_code: string;
  ledger_code: string;
  source_document_id: string;
  source_type: string;
  source_number: string;
  source_status: string;
  status: string;
  rule_key: string;
  jurisdiction: string;
  currency: string;
  taxable_basis: string;
  total_tax: string;
  pack_key: string;
  pack_version: string;
  created_at: string;
  review_reason: string | null;
}>;

export async function loadTaxDeterminations(
  principal: SessionPrincipal,
  options: Readonly<{ reviewOnly?: boolean }> = {},
): Promise<readonly TaxDeterminationSummary[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertReportPermission(client, principal, PERMISSIONS.readTax);
    const result = await client.query<TaxDeterminationRow>(
      `WITH determinations AS (
         SELECT snapshot.id::text AS id, entity.code AS entity_code,
           ledger.code AS ledger_code, snapshot.source_document_id,
           source.source_type, source.source_number, source.status::text AS source_status,
           snapshot.status, snapshot.rule_key, snapshot.jurisdiction,
           snapshot.currency, snapshot.taxable_basis::text AS taxable_basis,
           snapshot.total_tax::text AS total_tax, pack.pack_key,
           pack.version AS pack_version, snapshot.created_at,
           NULL::text AS review_reason
         FROM tax_determination_snapshots snapshot
         JOIN legal_entities entity
           ON entity.organization_id = snapshot.organization_id
          AND entity.id = snapshot.legal_entity_id
         JOIN ledgers ledger
           ON ledger.organization_id = snapshot.organization_id
          AND ledger.id = snapshot.ledger_id
         JOIN source_documents source
           ON source.organization_id = snapshot.organization_id
          AND source.id = snapshot.source_document_id
         JOIN tax_pack_versions pack ON pack.id = snapshot.tax_pack_version_id
         WHERE snapshot.organization_id = $1
           AND (NOT $2::boolean OR snapshot.status IN ('MANUAL_REVIEW', 'MANUAL_REVIEW_REQUIRED'))

         UNION ALL

         SELECT source.id::text || ':draft-tax:' || line.ordinality::text AS id,
           entity.code AS entity_code, ledger.code AS ledger_code,
           source.id AS source_document_id, source.source_type,
           source.source_number, source.status::text AS source_status,
           line.value -> 'taxDecision' ->> 'status' AS status,
           line.value -> 'taxDecision' ->> 'ruleKey' AS rule_key,
           line.value -> 'taxDecision' ->> 'jurisdiction' AS jurisdiction,
           source.snapshot ->> 'currency' AS currency,
           line.value ->> 'netAmount' AS taxable_basis,
           line.value -> 'taxDecision' ->> 'totalTax' AS total_tax,
           line.value -> 'taxDecision' ->> 'packKey' AS pack_key,
           line.value -> 'taxDecision' ->> 'packVersion' AS pack_version,
           source.created_at,
           line.value -> 'taxDecision' ->> 'reviewReason' AS review_reason
         FROM source_documents source
         JOIN legal_entities entity
           ON entity.organization_id = source.organization_id
          AND entity.id = source.legal_entity_id
         JOIN ledgers ledger
           ON ledger.organization_id = source.organization_id
          AND ledger.legal_entity_id = source.legal_entity_id
          AND ledger.id::text = source.snapshot ->> 'ledgerId'
         CROSS JOIN LATERAL jsonb_array_elements(source.snapshot -> 'lines')
           WITH ORDINALITY AS line(value, ordinality)
         WHERE source.organization_id = $1
           AND source.status = 'DRAFT'
           AND source.source_type IN ('receivables.sales-invoice', 'payables.supplier-bill')
           AND line.value -> 'taxDecision' ->> 'status' = 'MANUAL_REVIEW_REQUIRED'
           AND NOT EXISTS (
             SELECT 1 FROM source_documents newer
             WHERE newer.organization_id = source.organization_id
               AND newer.source_type = source.source_type
               AND newer.source_number = source.source_number
               AND newer.version > source.version
           )
       )
       SELECT id, entity_code, ledger_code, source_document_id, source_type,
         source_number, source_status, status, rule_key, jurisdiction, currency,
         taxable_basis, total_tax, pack_key, pack_version, created_at::text,
         review_reason
       FROM determinations
       ORDER BY created_at DESC, id DESC
       LIMIT 250`,
      [principal.organizationId, options.reviewOnly === true],
    );
    return result.rows.map((row) => ({
      id: row.id,
      entityCode: row.entity_code,
      ledgerCode: row.ledger_code,
      sourceDocumentId: row.source_document_id,
      sourceType: row.source_type,
      sourceNumber: row.source_number,
      sourceStatus: row.source_status,
      status: row.status,
      ruleKey: row.rule_key,
      jurisdiction: row.jurisdiction,
      currency: row.currency,
      taxableBasis: row.taxable_basis,
      totalTax: row.total_tax,
      packKey: row.pack_key,
      packVersion: row.pack_version,
      createdAt: row.created_at,
      reviewReason: row.review_reason,
    }));
  });
}
