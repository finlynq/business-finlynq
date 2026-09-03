import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEMO_ORGANIZATION_ID } from "@/modules/demo/constants";
import { demoAccountingCalendar, demoPeriodState } from "@/modules/demo/accounting-clock";
import {
  bootstrapDemoOrganization,
  DEMO_BASELINE_VERSION,
  resetSharedDemoOrganization,
} from "@/modules/onboarding/demo-bootstrap";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;

runDatabaseTests("rich nightly demo baseline", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = DEMO_ORGANIZATION_ID;
  let resetSchedule: {
    is_future: boolean;
    is_within_next_day: boolean;
    toronto_time: string;
  };

  beforeAll(async () => {
    // Exercise the same destructive maintenance boundary used by the nightly
    // job, then prove that an up-to-date deploy bootstrap is non-destructive.
    // TEST_DATABASE_URL always identifies the disposable integration database.
    await pool.query(
      "UPDATE shared_demo_reset_state SET reset_after = now() + interval '7 days' WHERE singleton",
    );
    await resetSharedDemoOrganization(pool, { mode: "nightly" });
    const schedule = await pool.query<{
      is_future: boolean;
      is_within_next_day: boolean;
      toronto_time: string;
    }>(
      `SELECT
         reset_after > last_completed_reset_at AS is_future,
         reset_after <= last_completed_reset_at + interval '25 hours' AS is_within_next_day,
         to_char(reset_after AT TIME ZONE 'America/Toronto', 'HH24:MI') AS toronto_time
       FROM shared_demo_reset_state
       WHERE singleton`,
    );
    if (!schedule.rows[0]) throw new Error("Shared demo reset state is missing");
    resetSchedule = schedule.rows[0];
    await bootstrapDemoOrganization(pool);
    await bootstrapDemoOrganization(pool);

    const ready = await pool.query<{
      organization_id: string;
      status: string;
      baseline_version: number;
      active: boolean;
      is_demo: boolean;
      organization_mode: string;
      active_sessions: number;
    }>(
      `SELECT organization.id AS organization_id, reset_state.status,
         reset_state.baseline_version, organization.active,
         organization.is_demo, organization.organization_mode,
         (SELECT count(*)::int FROM auth_sessions selected_session
            WHERE selected_session.organization_id = organization.id
              AND selected_session.session_mode = 'DEMO'
              AND selected_session.revoked_at IS NULL) AS active_sessions
       FROM organizations organization
       CROSS JOIN shared_demo_reset_state reset_state
       WHERE organization.id = $1 AND reset_state.singleton`,
      [DEMO_ORGANIZATION_ID],
    );
    const selected = ready.rows[0];
    if (!selected) throw new Error("The shared public demo is unavailable");
    expect(selected).toMatchObject({
      organization_id: DEMO_ORGANIZATION_ID,
      status: "READY",
      baseline_version: DEMO_BASELINE_VERSION,
      active: true,
      is_demo: true,
      organization_mode: "PUBLIC_DEMO",
      active_sessions: 0,
    });
  }, 300_000);

  afterAll(async () => pool.end());

  it("reschedules from completion even when the stored boundary is days ahead", () => {
    expect(resetSchedule).toEqual({
      is_future: true,
      is_within_next_day: true,
      toronto_time: "04:15",
    });
  });

  it("has exact deterministic accounting and source-document counts", async () => {
    const result = await pool.query<{
      entities: number;
      ledgers: number;
      periods: number;
      accounts: number;
      combinations: number;
      segments: number;
      parties: number;
      addresses: number;
      party_accounts: number;
      currency_restricted_party_accounts: number;
      registrations: number;
      posting_policies: number;
      source_documents: number;
      tax_snapshots: number;
      subledger_events: number;
      open_items: number;
      journals: number;
      lines: number;
      allocations: number;
      void_events: number;
      relations: number;
      number_sequences: number;
      audit_events: number;
      outbox_events: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM legal_entities WHERE organization_id = $1) AS entities,
         (SELECT count(*)::int FROM ledgers WHERE organization_id = $1) AS ledgers,
         (SELECT count(*)::int FROM fiscal_periods WHERE organization_id = $1) AS periods,
         (SELECT count(*)::int FROM gl_accounts WHERE organization_id = $1) AS accounts,
         (SELECT count(*)::int FROM account_combinations WHERE organization_id = $1) AS combinations,
         (SELECT count(*)::int FROM segment_definitions WHERE organization_id = $1) AS segments,
         (SELECT count(*)::int FROM parties WHERE organization_id = $1) AS parties,
         (SELECT count(*)::int FROM party_addresses WHERE organization_id = $1) AS addresses,
         (SELECT count(*)::int FROM party_accounts WHERE organization_id = $1) AS party_accounts,
         (SELECT count(*)::int FROM party_accounts
            WHERE organization_id = $1 AND transaction_currency IS NOT NULL)
           AS currency_restricted_party_accounts,
         (SELECT count(*)::int FROM entity_tax_registrations WHERE organization_id = $1) AS registrations,
         (SELECT count(*)::int FROM ledger_posting_policies WHERE organization_id = $1) AS posting_policies,
         (SELECT count(*)::int FROM source_documents WHERE organization_id = $1) AS source_documents,
         (SELECT count(*)::int FROM tax_determination_snapshots WHERE organization_id = $1) AS tax_snapshots,
         (SELECT count(*)::int FROM subledger_events WHERE organization_id = $1) AS subledger_events,
         (SELECT count(*)::int FROM open_items WHERE organization_id = $1) AS open_items,
         (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS journals,
         (SELECT count(*)::int FROM journal_lines WHERE organization_id = $1) AS lines,
         (SELECT count(*)::int FROM document_settlement_allocations WHERE organization_id = $1) AS allocations,
         (SELECT count(*)::int FROM open_item_void_events WHERE organization_id = $1) AS void_events,
         (SELECT count(*)::int FROM journal_entry_relations WHERE organization_id = $1) AS relations,
         (SELECT count(*)::int FROM ledger_number_sequences WHERE organization_id = $1) AS number_sequences,
         (SELECT count(*)::int FROM audit_events WHERE organization_id = $1) AS audit_events,
         (SELECT count(*)::int FROM outbox_events WHERE organization_id = $1) AS outbox_events`,
      [organizationId],
    );
    expect(result.rows[0]).toEqual({
      entities: 2,
      ledgers: 2,
      periods: 24,
      accounts: 26,
      combinations: 26,
      segments: 10,
      parties: 4,
      addresses: 4,
      party_accounts: 4,
      currency_restricted_party_accounts: 0,
      registrations: 2,
      posting_policies: 2,
      source_documents: 8,
      tax_snapshots: 4,
      subledger_events: 4,
      open_items: 4,
      journals: 6,
      lines: 16,
      allocations: 0,
      void_events: 0,
      relations: 0,
      number_sequences: 2,
      audit_events: 9,
      outbox_events: 5,
    });

    const lineage = await pool.query<{
      total: number;
      draft_v1: number;
      posted_v2: number;
      logical_documents: number;
      valid_predecessors: number;
      applied_tax: number;
      distinct_tax_sources: number;
    }>(
      `SELECT count(*)::int AS total,
         (count(*) FILTER (
           WHERE source.status = 'DRAFT' AND source.version = 1
             AND source.supersedes_source_document_id IS NULL
         ))::int AS draft_v1,
         (count(*) FILTER (
           WHERE source.status = 'POSTED' AND source.version = 2
         ))::int AS posted_v2,
         count(DISTINCT (source.source_type, source.source_number))::int AS logical_documents,
         (count(*) FILTER (
           WHERE source.status = 'POSTED' AND source.version = 2
             AND EXISTS (
               SELECT 1 FROM source_documents draft
               WHERE draft.organization_id = source.organization_id
                 AND draft.id = source.supersedes_source_document_id
                 AND draft.source_type = source.source_type
                 AND draft.source_number = source.source_number
                 AND draft.status = 'DRAFT' AND draft.version = 1
             )
         ))::int AS valid_predecessors,
         (SELECT count(*)::int FROM tax_determination_snapshots tax
            WHERE tax.organization_id = $1 AND tax.status = 'APPLIED') AS applied_tax,
         (SELECT count(DISTINCT tax.source_document_id)::int
            FROM tax_determination_snapshots tax
            WHERE tax.organization_id = $1) AS distinct_tax_sources
       FROM source_documents source
       WHERE source.organization_id = $1`,
      [organizationId],
    );
    expect(lineage.rows[0]).toEqual({
      total: 8,
      draft_v1: 4,
      posted_v2: 4,
      logical_documents: 4,
      valid_predecessors: 4,
      applied_tax: 4,
      distinct_tax_sources: 4,
    });

    const sharedDemoBanking = await pool.query<{
      connections: number;
      credential_events: number;
      accounts: number;
      sync_runs: number;
      observations: number;
      versions: number;
      anchors: number;
      reconciliations: number;
      reconciliation_voids: number;
      rules: number;
      proposals: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM bank_connections WHERE organization_id = $1) AS connections,
         (SELECT count(*)::int FROM bank_connection_credential_events WHERE organization_id = $1) AS credential_events,
         (SELECT count(*)::int FROM bank_external_accounts WHERE organization_id = $1) AS accounts,
         (SELECT count(*)::int FROM bank_sync_runs WHERE organization_id = $1) AS sync_runs,
         (SELECT count(*)::int FROM bank_observations WHERE organization_id = $1) AS observations,
         (SELECT count(*)::int FROM bank_observation_versions WHERE organization_id = $1) AS versions,
         (SELECT count(*)::int FROM bank_balance_anchors WHERE organization_id = $1) AS anchors,
         (SELECT count(*)::int FROM bank_reconciliation_sessions WHERE organization_id = $1) AS reconciliations,
         (SELECT count(*)::int FROM bank_reconciliation_voids WHERE organization_id = $1) AS reconciliation_voids,
         (SELECT count(*)::int FROM bank_rules WHERE organization_id = $1) AS rules,
         (SELECT count(*)::int FROM bank_draft_proposals WHERE organization_id = $1) AS proposals`,
      [organizationId],
    );
    expect(sharedDemoBanking.rows[0]).toEqual({
      connections: 1,
      credential_events: 1,
      accounts: 2,
      sync_runs: 1,
      observations: 3,
      versions: 3,
      anchors: 2,
      reconciliations: 1,
      reconciliation_voids: 0,
      rules: 1,
      proposals: 1,
    });
  });

  it("locks historical periods while keeping the fixture month open", async () => {
    const calendar = demoAccountingCalendar();
    const periodsByState = (state: "SEALED" | "HARD_CLOSED" | "OPEN") =>
      Array.from({ length: 12 }, (_, index) => index + 1)
        .filter((period) => demoPeriodState(period, calendar.periodNumber) === state);
    const sealedPeriods = periodsByState("SEALED");
    const hardClosedPeriods = periodsByState("HARD_CLOSED");
    const openPeriods = periodsByState("OPEN");
    const result = await pool.query<{
      entity_code: string;
      sealed: number;
      hard_closed: number;
      open: number;
      sealed_periods: number[];
      hard_closed_periods: number[];
      open_periods: number[];
      timestamp_mismatches: number;
    }>(
      `SELECT entity.code AS entity_code,
         (count(*) FILTER (WHERE period.state = 'SEALED'))::int AS sealed,
         (count(*) FILTER (WHERE period.state = 'HARD_CLOSED'))::int AS hard_closed,
         (count(*) FILTER (WHERE period.state = 'OPEN'))::int AS open,
         array_agg(period.period_number ORDER BY period.period_number)
           FILTER (WHERE period.state = 'SEALED') AS sealed_periods,
         array_agg(period.period_number ORDER BY period.period_number)
           FILTER (WHERE period.state = 'HARD_CLOSED') AS hard_closed_periods,
         array_agg(period.period_number ORDER BY period.period_number)
           FILTER (WHERE period.state = 'OPEN') AS open_periods,
         (count(*) FILTER (WHERE
           (period.state = 'OPEN' AND period.closed_at IS NOT NULL)
           OR (period.state <> 'OPEN' AND period.closed_at IS NULL)
         ))::int AS timestamp_mismatches
       FROM fiscal_periods period
       JOIN ledgers ledger
         ON ledger.organization_id = period.organization_id AND ledger.id = period.ledger_id
       JOIN legal_entities entity
         ON entity.organization_id = ledger.organization_id AND entity.id = ledger.legal_entity_id
       WHERE period.organization_id = $1
       GROUP BY entity.code
       ORDER BY entity.code`,
      [organizationId],
    );
    expect(result.rows).toEqual([
      {
        entity_code: "CA01",
        sealed: sealedPeriods.length,
        hard_closed: hardClosedPeriods.length,
        open: openPeriods.length,
        sealed_periods: sealedPeriods,
        hard_closed_periods: hardClosedPeriods,
        open_periods: openPeriods,
        timestamp_mismatches: 0,
      },
      {
        entity_code: "US01",
        sealed: sealedPeriods.length,
        hard_closed: hardClosedPeriods.length,
        open: openPeriods.length,
        sealed_periods: sealedPeriods,
        hard_closed_periods: hardClosedPeriods,
        open_periods: openPeriods,
        timestamp_mismatches: 0,
      },
    ]);

    const journalPeriodIntegrity = await pool.query<{ invalid_journals: number }>(
      `SELECT count(*)::int AS invalid_journals
       FROM journal_entries journal
       JOIN fiscal_periods period
         ON period.organization_id = journal.organization_id
        AND period.ledger_id = journal.ledger_id
        AND period.id = journal.period_id
       WHERE journal.organization_id = $1
         AND (
           journal.accounting_date < period.starts_on
           OR journal.accounting_date > period.ends_on
           OR (journal.status = 'POSTED' AND period.state <> 'OPEN')
         )`,
      [organizationId],
    );
    expect(journalPeriodIntegrity.rows[0]).toEqual({ invalid_journals: 0 });
  });

  it("contains five posted journals, including four source-owned documents, with exact balances", async () => {
    const statuses = await pool.query<{
      journals: number;
      posted: number;
      drafts: number;
      complete_posted: number;
      posting_audits: number;
      posting_outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS journals,
         (SELECT count(*)::int FROM journal_entries
            WHERE organization_id = $1 AND status = 'POSTED') AS posted,
         (SELECT count(*)::int FROM journal_entries
            WHERE organization_id = $1 AND status = 'DRAFT') AS drafts,
         (SELECT count(*)::int FROM journal_entries
            WHERE organization_id = $1 AND status = 'POSTED'
              AND source_document_id IS NOT NULL AND journal_number IS NOT NULL
              AND content_hash ~ '^[0-9a-f]{64}$'
              AND posted_by IS NOT NULL AND posted_at IS NOT NULL
              AND total_debit_functional = total_credit_functional
              AND total_debit_functional > 0) AS complete_posted,
         (SELECT count(*)::int FROM audit_events
            WHERE organization_id = $1 AND action = 'journal.posted') AS posting_audits,
         (SELECT count(*)::int FROM outbox_events
            WHERE organization_id = $1 AND topic = 'ledger.journal-posted') AS posting_outbox`,
      [organizationId],
    );
    expect(statuses.rows[0]).toEqual({
      journals: 6,
      posted: 5,
      drafts: 1,
      complete_posted: 4,
      posting_audits: 5,
      posting_outbox: 5,
    });

    const balances = await pool.query<{
      entity_code: string;
      journal_type_key: string;
      line_count: number;
      header_debit: string;
      header_credit: string;
      line_debit: string;
      line_credit: string;
    }>(
      `SELECT entity.code AS entity_code, journal.journal_type_key,
         count(line.id)::int AS line_count,
         round(journal.total_debit_functional, 2)::text AS header_debit,
         round(journal.total_credit_functional, 2)::text AS header_credit,
         round(sum(line.debit_functional), 2)::text AS line_debit,
         round(sum(line.credit_functional), 2)::text AS line_credit
       FROM journal_entries journal
       JOIN legal_entities entity
         ON entity.organization_id = journal.organization_id
        AND entity.id = journal.legal_entity_id
       JOIN journal_lines line
         ON line.organization_id = journal.organization_id
        AND line.journal_entry_id = journal.id
       WHERE journal.organization_id = $1 AND journal.status = 'POSTED'
       GROUP BY journal.id, entity.code, journal.journal_type_key,
         journal.total_debit_functional, journal.total_credit_functional
       ORDER BY entity.code, journal.journal_type_key`,
      [organizationId],
    );
    expect(balances.rows).toEqual([
      {
        entity_code: "CA01",
        journal_type_key: "payables.supplier-bill",
        line_count: 3,
        header_debit: "4542.60",
        header_credit: "4542.60",
        line_debit: "4542.60",
        line_credit: "4542.60",
      },
      {
        entity_code: "CA01",
        journal_type_key: "receivables.sales-invoice",
        line_count: 3,
        header_debit: "11300.00",
        header_credit: "11300.00",
        line_debit: "11300.00",
        line_credit: "11300.00",
      },
      {
        entity_code: "US01",
        journal_type_key: "ledger.manual",
        line_count: 2,
        header_debit: "2400.00",
        header_credit: "2400.00",
        line_debit: "2400.00",
        line_credit: "2400.00",
      },
      {
        entity_code: "US01",
        journal_type_key: "payables.supplier-bill",
        line_count: 3,
        header_debit: "3272.28",
        header_credit: "3272.28",
        line_debit: "3272.28",
        line_credit: "3272.28",
      },
      {
        entity_code: "US01",
        journal_type_key: "receivables.sales-invoice",
        line_count: 3,
        header_debit: "15477.00",
        header_credit: "15477.00",
        line_debit: "15477.00",
        line_credit: "15477.00",
      },
    ]);
  });

  it("exposes exact CAD and USD customer and supplier open balances", async () => {
    const result = await pool.query<{
      entity_code: string;
      role: string;
      source_type: string;
      source_version: number;
      source_status: string;
      stored_status: string;
      derived_status: string;
      transaction_currency: string;
      original_transaction_amount: string;
      open_transaction_amount: string;
      original_functional_amount: string;
      carrying_functional_amount: string;
    }>(
      `SELECT entity.code AS entity_code, party_account.role::text AS role,
         source.source_type, source.version AS source_version,
         source.status AS source_status, item.status::text AS stored_status,
         balance.derived_status, balance.transaction_currency,
         round(balance.original_transaction_amount, 2)::text AS original_transaction_amount,
         round(balance.open_transaction_amount, 2)::text AS open_transaction_amount,
         round(balance.original_functional_amount, 2)::text AS original_functional_amount,
         round(balance.carrying_functional_amount, 2)::text AS carrying_functional_amount
       FROM open_item_balances balance
       JOIN open_items item
         ON item.organization_id = balance.organization_id AND item.id = balance.id
       JOIN party_accounts party_account
         ON party_account.organization_id = balance.organization_id
        AND party_account.id = balance.party_account_id
       JOIN legal_entities entity
         ON entity.organization_id = party_account.organization_id
        AND entity.id = party_account.legal_entity_id
       JOIN subledger_events event
         ON event.organization_id = balance.organization_id
        AND event.id = balance.source_event_id
       JOIN source_documents source
         ON source.organization_id = event.organization_id
        AND source.id = event.source_document_id
       WHERE balance.organization_id = $1
       ORDER BY entity.code, party_account.role::text`,
      [organizationId],
    );
    expect(result.rows).toEqual([
      {
        entity_code: "CA01",
        role: "CUSTOMER",
        source_type: "receivables.sales-invoice",
        source_version: 2,
        source_status: "POSTED",
        stored_status: "OPEN",
        derived_status: "OPEN",
        transaction_currency: "CAD",
        original_transaction_amount: "11300.00",
        open_transaction_amount: "11300.00",
        original_functional_amount: "11300.00",
        carrying_functional_amount: "11300.00",
      },
      {
        entity_code: "CA01",
        role: "SUPPLIER",
        source_type: "payables.supplier-bill",
        source_version: 2,
        source_status: "POSTED",
        stored_status: "OPEN",
        derived_status: "OPEN",
        transaction_currency: "USD",
        original_transaction_amount: "3390.00",
        open_transaction_amount: "3390.00",
        original_functional_amount: "4542.60",
        carrying_functional_amount: "4542.60",
      },
      {
        entity_code: "US01",
        role: "CUSTOMER",
        source_type: "receivables.sales-invoice",
        source_version: 2,
        source_status: "POSTED",
        stored_status: "OPEN",
        derived_status: "OPEN",
        transaction_currency: "USD",
        original_transaction_amount: "15477.00",
        open_transaction_amount: "15477.00",
        original_functional_amount: "15477.00",
        carrying_functional_amount: "15477.00",
      },
      {
        entity_code: "US01",
        role: "SUPPLIER",
        source_type: "payables.supplier-bill",
        source_version: 2,
        source_status: "POSTED",
        stored_status: "OPEN",
        derived_status: "OPEN",
        transaction_currency: "CAD",
        original_transaction_amount: "4000.00",
        open_transaction_amount: "4000.00",
        original_functional_amount: "2960.00",
        carrying_functional_amount: "2960.00",
      },
    ]);
  });
});
