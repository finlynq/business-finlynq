import "server-only";
import type { PoolClient } from "pg";
import type { JournalFilterOptions } from "./journal-register-filters";

export async function loadJournalFilterOptions(client: PoolClient, organizationId: string, selectedEntityId: string | null): Promise<JournalFilterOptions> {
  const periods = await client.query<{
    id: string; label: string; fiscal_year: number; starts_on: string; ends_on: string; entity_code: string; ledger_code: string;
  }>(`SELECT period.id, period.label, period.fiscal_year, period.starts_on::text, period.ends_on::text,
        entity.code AS entity_code, ledger.code AS ledger_code
      FROM fiscal_periods period
      JOIN ledgers ledger ON ledger.organization_id = period.organization_id AND ledger.id = period.ledger_id
      JOIN legal_entities entity ON entity.organization_id = ledger.organization_id AND entity.id = ledger.legal_entity_id
      WHERE period.organization_id = $1 AND ($2::uuid IS NULL OR ledger.legal_entity_id = $2::uuid)
      ORDER BY period.starts_on DESC, entity.code, ledger.code, period.id`, [organizationId, selectedEntityId]);
  const accounts = await client.query<{ id: string; code: string; display_name: string; entity_code: string; ledger_code: string }>(
    `SELECT account.id, account.code, account.display_name, entity.code AS entity_code, ledger.code AS ledger_code
      FROM gl_accounts account
      JOIN ledgers ledger ON ledger.organization_id = account.organization_id AND ledger.id = account.ledger_id
      JOIN legal_entities entity ON entity.organization_id = ledger.organization_id AND entity.id = ledger.legal_entity_id
      WHERE account.organization_id = $1 AND ($2::uuid IS NULL OR ledger.legal_entity_id = $2::uuid)
      ORDER BY account.code, entity.code, ledger.code, account.id`, [organizationId, selectedEntityId]);
  const types = await client.query<{ key: string; display_name: string; owner_module: string; functional_currency: string }>(
    `SELECT DISTINCT journal_type.key, journal_type.display_name, journal_type.owner_module, entry.functional_currency
      FROM journal_entries entry
      JOIN journal_type_definitions journal_type ON journal_type.id = entry.journal_type_definition_id
        AND journal_type.key = entry.journal_type_key AND journal_type.version = entry.journal_type_version
      WHERE entry.organization_id = $1 AND ($2::uuid IS NULL OR entry.legal_entity_id = $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM journal_transaction_controls control
          WHERE control.organization_id = entry.organization_id AND control.journal_entry_id = entry.id AND control.outcome = 'DELETED')
      ORDER BY journal_type.key, entry.functional_currency`, [organizationId, selectedEntityId]);
  return {
    fiscalYears: [...new Set(periods.rows.map((period) => String(period.fiscal_year)))].sort().reverse(),
    periods: periods.rows.map((period) => ({
      id: period.id, label: `${period.entity_code} · ${period.ledger_code} · ${period.label}`,
      fiscalYear: String(period.fiscal_year), startsOn: period.starts_on, endsOn: period.ends_on,
    })),
    accounts: accounts.rows.map((account) => ({ id: account.id, label: `${account.code} · ${account.display_name} · ${account.entity_code} · ${account.ledger_code}` })),
    journalTypes: [...new Map(types.rows.map((type) => [type.key, { key: type.key, label: type.display_name }])).values()],
    sourceModules: [...new Set(types.rows.map((type) => type.owner_module))].sort(),
    currencies: [...new Set(types.rows.map((type) => type.functional_currency))].sort(),
  };
}
