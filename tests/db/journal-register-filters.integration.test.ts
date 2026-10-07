import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { buildJournalRegisterPredicate, parseJournalFilters, type JournalFilterSearchParams } from "@/modules/ledger/journal-register-filters";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTests = databaseUrl ? describe : describe.skip;

// Connection-local tables exercise the production predicates with PostgreSQL
// numeric/date/EXISTS semantics without changing tenant data or schema.
databaseTests("journal register filters in PostgreSQL", () => {
  const client = new Client({ connectionString: databaseUrl });
  const ids = { organization: randomUUID(), otherOrganization: randomUUID(), entity: randomUUID(), otherEntity: randomUUID(),
    foreignEntity: randomUUID(), ledger: randomUUID(), january: randomUUID(), newerPeriod: randomUUID(), type: randomUUID(),
    account: randomUUID(), otherAccount: randomUUID(), combination: randomUUID(), secondCombination: randomUUID(),
    otherCombination: randomUUID(), posted: randomUUID(), reversed: randomUUID(), reversal: randomUUID() };
  const from = `FROM journal_entries entry
    JOIN legal_entities entity ON entity.organization_id = entry.organization_id AND entity.id = entry.legal_entity_id
    JOIN fiscal_periods entry_period ON entry_period.organization_id = entry.organization_id
      AND entry_period.ledger_id = entry.ledger_id AND entry_period.id = entry.period_id
    JOIN journal_type_definitions journal_type ON journal_type.id = entry.journal_type_definition_id
      AND journal_type.key = entry.journal_type_key AND journal_type.version = entry.journal_type_version`;

  async function select(parameters: JournalFilterSearchParams, page = 1, search = "", selectedEntityId: string | null = ids.entity) {
    const predicate = buildJournalRegisterPredicate({ organizationId: ids.organization, selectedEntityId, search, filterState: parseJournalFilters(parameters) });
    const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count ${from} WHERE ${predicate.sql}`, predicate.parameters);
    const result = await client.query<{ id: string; status: string }>(`SELECT entry.id, entry.status ${from} WHERE ${predicate.sql}
      ORDER BY entry.accounting_date DESC, entry.created_at DESC, entry.id DESC
      LIMIT $${predicate.parameters.length + 1} OFFSET $${predicate.parameters.length + 2}`,
    [...predicate.parameters, 50, (page - 1) * 50]);
    return { count: Number(count.rows[0].count), rows: result.rows };
  }

  async function insertJournal(input: { id?: string; date?: string; status?: string; entity?: string; organization?: string; description?: string; amount?: string; currency?: string; number?: number | null } = {}) {
    const id = input.id ?? randomUUID();
    const organization = input.organization ?? ids.organization;
    const date = input.date ?? "2025-01-15";
    await client.query(`INSERT INTO journal_entries(id, organization_id, legal_entity_id, ledger_id, period_id,
      journal_type_definition_id, journal_type_key, journal_type_version, status, accounting_date, description,
      total_debit_functional, functional_currency, journal_number, created_at)
      VALUES($1,$2,$3,$4,$5,$6,'ledger.manual',1,$7,$8,$9,$10,$11,$12,now())`,
    [id, organization, input.entity ?? ids.entity, ids.ledger, date.startsWith("2026") ? ids.newerPeriod : ids.january,
      ids.type, input.status ?? "SUBMITTED", date, input.description ?? "January depreciation", input.amount ?? "0", input.currency ?? "CAD", input.number ?? null]);
    await client.query(`INSERT INTO journal_lines(organization_id,journal_entry_id,account_combination_id,debit_functional)
      VALUES($1,$2,$3,40.000000001),($1,$2,$4,60.000000002)`, [organization, id, ids.combination, ids.secondCombination]);
    return id;
  }

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE TEMP TABLE journal_entries(id uuid, organization_id uuid, legal_entity_id uuid, ledger_id uuid, period_id uuid,
      journal_type_definition_id uuid, journal_type_key text, journal_type_version integer, status text, accounting_date date,
      description text, total_debit_functional numeric(38,9), functional_currency text, journal_number integer, created_at timestamptz);
      CREATE TEMP TABLE legal_entities(id uuid, organization_id uuid, code text);
      CREATE TEMP TABLE fiscal_periods(id uuid, organization_id uuid, ledger_id uuid, fiscal_year integer);
      CREATE TEMP TABLE journal_type_definitions(id uuid, key text, version integer, owner_module text);
      CREATE TEMP TABLE journal_transaction_controls(organization_id uuid, journal_entry_id uuid, outcome text);
      CREATE TEMP TABLE journal_lines(organization_id uuid, journal_entry_id uuid, account_combination_id uuid, debit_functional numeric(38,9));
      CREATE TEMP TABLE account_combinations(id uuid, organization_id uuid, account_id uuid);
      CREATE TEMP TABLE journal_entry_relations(organization_id uuid, from_journal_id uuid, to_journal_id uuid, kind text);`);
    await client.query(`INSERT INTO legal_entities VALUES($1,$2,'CA01'),($3,$2,'CA02'),($4,$5,'FOREIGN');`,
      [ids.entity, ids.organization, ids.otherEntity, ids.foreignEntity, ids.otherOrganization]);
    await client.query(`INSERT INTO fiscal_periods VALUES($1,$2,$3,2025),($4,$2,$3,2026),($1,$5,$3,2025)`,
      [ids.january, ids.organization, ids.ledger, ids.newerPeriod, ids.otherOrganization]);
    await client.query(`INSERT INTO journal_type_definitions VALUES($1,'ledger.manual',1,'ledger')`, [ids.type]);
    await client.query(`INSERT INTO account_combinations VALUES($1,$2,$3),($4,$2,$3),($5,$2,$6)`,
      [ids.combination, ids.organization, ids.account, ids.secondCombination, ids.otherCombination, ids.otherAccount]);
    for (let index = 0; index < 100; index++) await insertJournal({ date: "2026-10-01", description: "Newer journal" });
    for (let index = 0; index < 60; index++) await insertJournal();
    await insertJournal({ date: "2025-02-01" });
    await insertJournal({ entity: ids.otherEntity });
    await insertJournal({ organization: ids.otherOrganization, entity: ids.foreignEntity });
    const deleted = await insertJournal();
    await client.query(`INSERT INTO journal_transaction_controls VALUES($1,$2,'DELETED')`, [ids.organization, deleted]);
    await insertJournal({ id: ids.posted, status: "POSTED", amount: "9007199254740993.000000001", number: 1 });
    await insertJournal({ id: ids.reversed, status: "POSTED", number: 2 });
    await insertJournal({ id: ids.reversal, status: "POSTED", date: "2026-10-01", number: 3 });
    await client.query(`INSERT INTO journal_entry_relations VALUES($1,$2,$3,'REVERSAL_OF')`, [ids.organization, ids.reversal, ids.reversed]);
  }, 30_000);

  afterAll(async () => { await client.end(); });

  it("finds January 2025 submitted journals before pagination despite 100 newer 2026 journals", async () => {
    const filters = { dateFrom: "2025-01-01", dateTo: "2025-01-31", status: "SUBMITTED" };
    const first = await select(filters);
    const second = await select(filters, 2);
    const beyond = await select(filters, 3);
    expect(first.count).toBe(60);
    expect(first.rows).toHaveLength(50);
    expect(second.count).toBe(60);
    expect(second.rows).toHaveLength(10);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(60);
    expect(beyond).toEqual({ count: 60, rows: [] });
  });

  it("combines fiscal, natural-account, status, module, currency, exact amount, entity and text filters without duplicate rows", async () => {
    const result = await select({ fiscalYear: "2025", periodId: ids.january, dateTo: "2025-01-31", status: ["SUBMITTED", "APPROVED"],
      accountId: ids.account, typeKey: "ledger.manual", ownerModule: "ledger", minAmount: "100.000000003", maxAmount: "100.000000003", currency: "CAD" }, 1, "depreciation");
    expect(result.count).toBe(60);
    expect(result.rows).toHaveLength(50);
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(50);
    expect((await select({ accountId: ids.otherAccount, status: "SUBMITTED" })).count).toBe(0);
    expect((await select({ ownerModule: "receivables" })).count).toBe(0);
    expect((await select({ currency: "USD" })).count).toBe(0);
  });

  it("uses stored posted totals and exact numeric comparisons beyond JavaScript integer precision", async () => {
    expect((await select({ status: "POSTED", minAmount: "9007199254740993.000000001", maxAmount: "9007199254740993.000000001" })).rows.map((row) => row.id)).toEqual([ids.posted]);
    expect((await select({ status: "POSTED", minAmount: "9007199254740993.000000002" })).count).toBe(0);
  });

  it("keeps displayed reversed journals separate from currently posted journals", async () => {
    expect((await select({ status: "REVERSED" })).rows.map((row) => row.id)).toEqual([ids.reversed]);
    expect((await select({ status: "POSTED" })).rows.map((row) => row.id)).not.toContain(ids.reversed);
  });

  it("preserves tenant isolation when all entity scope is selected", async () => {
    expect((await select({ dateFrom: "2025-01-01", dateTo: "2025-01-31", status: "SUBMITTED" }, 1, "", null)).count).toBe(61);
    expect((await select({ status: "SUBMITTED" }, 1, "", ids.foreignEntity)).count).toBe(0);
  });

  it("returns an empty result for invalid dates or amounts without a database cast error", async () => {
    expect(await select({ dateFrom: "2025-02-30", minAmount: "NaN" })).toEqual({ count: 0, rows: [] });
  });
});
