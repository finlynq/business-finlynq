import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  createBlindIndex,
  encryptField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import {
  ensureOperatorLedgerFoundation,
  ensureOperatorOrganizationKey,
} from "./organization-service";

export const DEMO_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const DEMO_USER_ID = "10000000-0000-4000-8000-000000000002";

const DEMO_PARTIES = [
  {
    id: "10000000-0000-4000-8000-000000000101",
    addressId: "10000000-0000-4000-8000-000000000111",
    number: "P-000184",
    name: "Harbour Dental Group",
    address: { line1: "184 Harbour Avenue", city: "Toronto", region: "ON", postalCode: "M5V 2T6", countryCode: "CA" },
  },
  {
    id: "10000000-0000-4000-8000-000000000102",
    addressId: "10000000-0000-4000-8000-000000000112",
    number: "P-000203",
    name: "Cascade Office Supply",
    address: { line1: "203 Cascade Way", city: "Seattle", region: "WA", postalCode: "98101", countryCode: "US" },
  },
  {
    id: "10000000-0000-4000-8000-000000000103",
    addressId: "10000000-0000-4000-8000-000000000113",
    number: "P-000256",
    name: "Pine and Lake Advisory",
    address: { line1: "256 Pine Street", city: "Toronto", region: "ON", postalCode: "M4B 1B3", countryCode: "CA" },
  },
] as const;

async function seedEncryptedParties(client: PoolClient): Promise<void> {
  const activeKey = await loadActiveOrganizationKey(client, DEMO_ORGANIZATION_ID);
  try {
    for (const party of DEMO_PARTIES) {
      const encryptedName = encryptField(party.name, activeKey.dek, {
        organizationId: DEMO_ORGANIZATION_ID,
        table: "parties",
        column: "display_name_ciphertext",
        recordId: party.id,
        keyVersion: activeKey.keyVersion,
      });
      await client.query(
         `INSERT INTO parties (
           id, organization_id, party_number, display_name_ciphertext,
           display_name_key_version, search_token, command_hash, active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (id) DO NOTHING`,
        [
          party.id,
          DEMO_ORGANIZATION_ID,
          party.number,
          serializeEncryptedField(encryptedName),
          activeKey.keyVersion,
          createBlindIndex(party.name, activeKey.dek, DEMO_ORGANIZATION_ID, "parties.display-name"),
          createHash("sha256").update(`demo-party:${party.id}`, "utf8").digest("hex"),
        ],
      );
      const encryptedAddress = encryptField(JSON.stringify(party.address), activeKey.dek, {
        organizationId: DEMO_ORGANIZATION_ID,
        table: "party_addresses",
        column: "ciphertext",
        recordId: party.addressId,
        keyVersion: activeKey.keyVersion,
      });
      await client.query(
        `INSERT INTO party_addresses (
           id, organization_id, party_id, kind, ciphertext, key_version, valid_from
         ) VALUES ($1, $2, $3, 'BILLING', $4, $5, '2026-01-01')
         ON CONFLICT (id) DO NOTHING`,
        [
          party.addressId,
          DEMO_ORGANIZATION_ID,
          party.id,
          serializeEncryptedField(encryptedAddress),
          String(activeKey.keyVersion),
        ],
      );
    }
  } finally {
    activeKey.dek.fill(0);
  }
}

async function seedDraftJournal(
  client: PoolClient,
  input: Readonly<{
    id: string;
    entityCode: string;
    ledgerId: string;
    legalEntityId: string;
    currency: "CAD" | "USD";
    description: string;
    debitAccount: string;
    creditAccount: string;
    amount: string;
  }>,
): Promise<void> {
  const setup = await client.query<{
    period_id: string;
    journal_type_id: string;
    journal_type_version: number;
    debit_combination_id: string;
    credit_combination_id: string;
  }>(
    `SELECT period.id AS period_id, journal_type.id AS journal_type_id,
       journal_type.version AS journal_type_version,
       debit_combination.id AS debit_combination_id,
       credit_combination.id AS credit_combination_id
     FROM fiscal_periods period
     JOIN LATERAL (
       SELECT id, version FROM journal_type_definitions
       WHERE key = 'ledger.manual' ORDER BY version DESC LIMIT 1
     ) journal_type ON true
     JOIN gl_accounts debit_account
       ON debit_account.organization_id = period.organization_id
      AND debit_account.ledger_id = period.ledger_id AND debit_account.code = $3
     JOIN account_combinations debit_combination
       ON debit_combination.organization_id = debit_account.organization_id
      AND debit_combination.ledger_id = debit_account.ledger_id
      AND debit_combination.account_id = debit_account.id
     JOIN gl_accounts credit_account
       ON credit_account.organization_id = period.organization_id
      AND credit_account.ledger_id = period.ledger_id AND credit_account.code = $4
     JOIN account_combinations credit_combination
       ON credit_combination.organization_id = credit_account.organization_id
      AND credit_combination.ledger_id = credit_account.ledger_id
      AND credit_combination.account_id = credit_account.id
     WHERE period.organization_id = $1 AND period.ledger_id = $2
       AND period.fiscal_year = 2026 AND period.period_number = 8`,
    [DEMO_ORGANIZATION_ID, input.ledgerId, input.debitAccount, input.creditAccount],
  );
  const selected = setup.rows[0];
  if (!selected) throw new Error(`Demo ${input.entityCode} journal foundation is incomplete`);
  const idempotencyKey = `demo:${input.entityCode}:${input.id}`;
  const commandHash = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  await client.query(
    `INSERT INTO journal_entries (
       id, organization_id, ledger_id, legal_entity_id, period_id,
       journal_type_key, journal_type_definition_id, journal_type_version,
       source_event_key, idempotency_key, command_hash, origin, purpose,
       accounting_date, functional_currency, description, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'ledger.manual', $6, $7,
       $8, $8, $9, 'USER', 'ROUTINE', '2026-08-26', $10, $11, $12
     ) ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      DEMO_ORGANIZATION_ID,
      input.ledgerId,
      input.legalEntityId,
      selected.period_id,
      selected.journal_type_id,
      selected.journal_type_version,
      idempotencyKey,
      commandHash,
      input.currency,
      input.description,
      DEMO_USER_ID,
    ],
  );
  await client.query(
    `INSERT INTO journal_lines (
       organization_id, ledger_id, journal_entry_id, line_number,
       account_combination_id, debit_functional, credit_functional,
       transaction_currency, debit_transaction, credit_transaction,
       fx_rate, fx_rate_source, fx_rate_effective_at, memo
     ) VALUES
       ($1, $2, $3, 1, $4, $6, 0, $7, $6, 0, 1, 'functional', '2026-08-26T12:00:00Z', 'Synthetic demo debit'),
       ($1, $2, $3, 2, $5, 0, $6, $7, 0, $6, 1, 'functional', '2026-08-26T12:00:00Z', 'Synthetic demo credit')
     ON CONFLICT (journal_entry_id, line_number) DO NOTHING`,
    [
      DEMO_ORGANIZATION_ID,
      input.ledgerId,
      input.id,
      selected.debit_combination_id,
      selected.credit_combination_id,
      input.amount,
      input.currency,
    ],
  );
}

export async function bootstrapDemoOrganization(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq-demo-bootstrap', 0))");
    const demo = await client.query<{ is_demo: boolean }>(
      "SELECT is_demo FROM organizations WHERE id = $1 FOR UPDATE",
      [DEMO_ORGANIZATION_ID],
    );
    if (!demo.rows[0]?.is_demo) throw new Error("Fixed demo organization has not been installed by migrations");
    await ensureOperatorOrganizationKey(client, DEMO_ORGANIZATION_ID);
    const ca = await ensureOperatorLedgerFoundation(client, DEMO_ORGANIZATION_ID, {
      slug: "northstar-demo",
      organizationName: "Northstar Demo Group",
      entityCode: "CA01",
      entityName: "Northstar Services Canada Inc.",
      countryCode: "CA",
      regionCode: "ON",
      functionalCurrency: "CAD",
      accountingProfile: "CAN_ASPE",
      fiscalYear: 2026,
    });
    const us = await ensureOperatorLedgerFoundation(client, DEMO_ORGANIZATION_ID, {
      slug: "northstar-demo",
      organizationName: "Northstar Demo Group",
      entityCode: "US01",
      entityName: "Northstar Services USA LLC",
      countryCode: "US",
      regionCode: "WA",
      functionalCurrency: "USD",
      accountingProfile: "US_GAAP_NONPUBLIC",
      fiscalYear: 2026,
    });
    await seedEncryptedParties(client);
    await seedDraftJournal(client, {
      id: "10000000-0000-4000-8000-000000000201",
      entityCode: "CA01",
      ...ca,
      currency: "CAD",
      description: "Synthetic Canadian software accrual",
      debitAccount: "6100",
      creditAccount: "2300",
      amount: "1250.00",
    });
    await seedDraftJournal(client, {
      id: "10000000-0000-4000-8000-000000000202",
      entityCode: "US01",
      ...us,
      currency: "USD",
      description: "Synthetic US prepaid expense entry",
      debitAccount: "1400",
      creditAccount: "1000",
      amount: "2400.00",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
