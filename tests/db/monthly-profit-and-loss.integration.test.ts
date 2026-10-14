import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: async (_context: unknown, _route: string, work: (client: unknown) => Promise<unknown>) => work(state.client),
}));
vi.mock("@/modules/identity/authorization", () => ({ assertActorHasActivePermission: async () => undefined }));
vi.mock("@/modules/identity/session", () => ({ transactionAuthMethod: () => "demo-link" }));

import { loadMonthlyProfitAndLoss } from "@/modules/reporting/monthly-profit-and-loss";
import { loadTrialBalance, profitAndLossRows, type ReportEntityOption, type ReportSelection } from "@/modules/reporting/tenant-reporting";

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;

run("monthly P&L posted activity in PostgreSQL", () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const ids = {
    org: randomUUID(), foreignOrg: randomUUID(), entity: randomUUID(), foreignEntity: randomUUID(),
    ledger: randomUUID(), otherLedger: randomUUID(), foreignLedger: randomUUID(),
    revenue: randomUUID(), expense: randomUUID(), foreignRevenue: randomUUID(), revenueCombination: randomUUID(), expenseCombination: randomUUID(),
    otherLedgerCombination: randomUUID(), foreignCombination: randomUUID(),
  };
  const entity: ReportEntityOption = {
    id: ids.entity, code: "CA01", displayName: "Synthetic company", ledgerId: ids.ledger,
    ledgerCode: "PRIMARY", currency: "CAD", defaultPeriodId: "period-3", accounts: [],
    periods: Array.from({ length: 12 }, (_, index) => ({
      id: `period-${index + 1}`, label: new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))),
      startsOn: new Date(Date.UTC(2026, index, 1)).toISOString().slice(0, 10),
      endsOn: new Date(Date.UTC(2026, index + 1, 0)).toISOString().slice(0, 10),
      fiscalYear: 2026, periodNumber: index + 1, state: "OPEN",
    })),
  };
  const selection: ReportSelection = {
    entityId: ids.entity, entityCode: entity.code, entityName: entity.displayName,
    ledgerId: ids.ledger, ledgerCode: entity.ledgerCode, currency: "CAD",
    basis: "period", fromDate: "2026-01-01", toDate: "2026-12-31",
    fromPeriodId: "period-1", toPeriodId: "period-12", accountId: null, accountCode: null, segmentFilters: {},
  };
  const principal = { organizationId: ids.org, userId: randomUUID(), sessionId: randomUUID(), sessionMode: "demo" };

  async function journal(organizationId: string, legalEntityId: string, ledgerId: string, date: string, status: string,
    combinationId: string, debit: string, credit: string) {
    const id = randomUUID();
    await client.query(`INSERT INTO journal_entries VALUES($1,$2,$3,$4,$5,$6,now())`,
      [id, organizationId, legalEntityId, ledgerId, status, date]);
    await client.query(`INSERT INTO journal_lines VALUES($1,$2,$3,$4,$5)`,
      [organizationId, id, combinationId, debit, credit]);
  }

  beforeAll(async () => {
    await client.connect();
    state.client = client;
    await client.query(`
      CREATE TEMP TABLE journal_entries(id uuid, organization_id uuid, legal_entity_id uuid, ledger_id uuid,
        status text, accounting_date date, posted_at timestamptz);
      CREATE TEMP TABLE journal_lines(organization_id uuid, journal_entry_id uuid, account_combination_id uuid,
        debit_functional numeric(38,9), credit_functional numeric(38,9));
      CREATE TEMP TABLE account_combinations(id uuid, organization_id uuid, entity_id uuid, ledger_id uuid,
        account_id uuid, subaccount_id uuid, department_id uuid, intercompany_entity_id uuid,
        custom_1_id uuid, custom_2_id uuid, custom_3_id uuid, custom_4_id uuid,
        custom_5_id uuid, custom_6_id uuid, custom_7_id uuid, custom_8_id uuid);
      CREATE TEMP TABLE legal_entities(id uuid, organization_id uuid, code text);
      CREATE TEMP TABLE ledgers(id uuid, organization_id uuid, code text, functional_currency text);
      CREATE TEMP TABLE gl_accounts(id uuid, organization_id uuid, code text, display_name text, class text);
      CREATE TEMP TABLE segment_values(id uuid, organization_id uuid, code text);
      CREATE TEMP TABLE segment_definitions(organization_id uuid, key text, display_name text, visible boolean, ordinal integer);
    `);
    await client.query("INSERT INTO legal_entities VALUES($1,$2,'CA01'),($3,$4,'FOREIGN')",
      [ids.entity, ids.org, ids.foreignEntity, ids.foreignOrg]);
    await client.query("INSERT INTO ledgers VALUES($1,$2,'PRIMARY','CAD'),($3,$2,'SECONDARY','CAD'),($4,$5,'FOREIGN','CAD')",
      [ids.ledger, ids.org, ids.otherLedger, ids.foreignLedger, ids.foreignOrg]);
    await client.query("INSERT INTO gl_accounts VALUES($1,$3,'4000','Sales','REVENUE'),($2,$3,'6000','Expense','EXPENSE')",
      [ids.revenue, ids.expense, ids.org]);
    await client.query("INSERT INTO gl_accounts VALUES($1,$2,'4000','Foreign sales','REVENUE')", [ids.foreignRevenue, ids.foreignOrg]);
    await client.query(`INSERT INTO account_combinations(id,organization_id,entity_id,ledger_id,account_id)
      VALUES($1,$5,$6,$7,$8),($2,$5,$6,$7,$9),($3,$5,$6,$10,$8),($4,$11,$12,$13,$14)`,
    [ids.revenueCombination, ids.expenseCombination, ids.otherLedgerCombination, ids.foreignCombination,
      ids.org, ids.entity, ids.ledger, ids.revenue, ids.expense, ids.otherLedger,
      ids.foreignOrg, ids.foreignEntity, ids.foreignLedger, ids.foreignRevenue]);
    await journal(ids.org, ids.entity, ids.ledger, "2026-01-10", "POSTED", ids.revenueCombination, "0", "100.00");
    await journal(ids.org, ids.entity, ids.ledger, "2026-01-11", "POSTED", ids.expenseCombination, "30.00", "0");
    await journal(ids.org, ids.entity, ids.ledger, "2026-02-02", "POSTED", ids.revenueCombination, "20.00", "0");
    await journal(ids.org, ids.entity, ids.ledger, "2026-02-03", "POSTED", ids.expenseCombination, "5.00", "0");
    await journal(ids.org, ids.entity, ids.ledger, "2026-02-04", "DRAFT", ids.revenueCombination, "0", "900.00");
    await journal(ids.org, ids.entity, ids.otherLedger, "2026-02-05", "POSTED", ids.otherLedgerCombination, "0", "400.00");
    await journal(ids.org, ids.entity, ids.ledger, "2026-04-01", "POSTED", ids.revenueCombination, "0", "200.00");
    await journal(ids.foreignOrg, ids.foreignEntity, ids.foreignLedger, "2026-02-06", "POSTED", ids.foreignCombination, "0", "500.00");
  }, 30_000);

  afterAll(async () => { state.client = null; await client.end(); });

  it("nets posted reversal and expense in their months, excluding drafts, other ledgers, tenants and future", async () => {
    const report = await loadMonthlyProfitAndLoss(principal as never, selection, entity, "2026-03-15");
    const revenue = report.rows.find((row) => row.accountCode === "4000");
    const expense = report.rows.find((row) => row.accountCode === "6000");
    expect(revenue).toMatchObject({ currency: "CAD", amount: "80", months: { "period-1": "100", "period-2": "-20" } });
    expect(expense).toMatchObject({ currency: "CAD", amount: "35", months: { "period-1": "30", "period-2": "5" } });
    expect(report.rows).toHaveLength(2);
    expect(report.columns[2]?.coverage).toBe("PARTIAL");
    expect(report.columns[3]?.coverage).toBe("FUTURE");
    for (const [key, fromDate, toDate] of [
      ["period-1", "2026-01-01", "2026-01-31"],
      ["period-2", "2026-02-01", "2026-02-28"],
    ] as const) {
      const existing = profitAndLossRows(await loadTrialBalance(principal as never, { ...selection, fromDate, toDate }));
      for (const row of existing) {
        expect(report.rows.find((candidate) => candidate.accountCode === row.accountCode)?.months[key]).toBe(row.amount);
      }
    }
    const aggregate = profitAndLossRows(await loadTrialBalance(principal as never, { ...selection, toDate: "2026-03-15" }));
    for (const row of aggregate) {
      expect(report.rows.find((candidate) => candidate.accountCode === row.accountCode)?.amount).toBe(row.amount);
    }
  });
});
