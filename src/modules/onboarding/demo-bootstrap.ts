import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  createBlindIndex,
  encryptField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { ensureOperatorOrganizationKey } from "./organization-service";
import { DEMO_ORGANIZATION_ID, DEMO_USER_ID } from "@/modules/demo/constants";

export { DEMO_ORGANIZATION_ID } from "@/modules/demo/constants";

const DEMO_BASELINE_VERSION = 1;
const DEMO_FISCAL_YEAR = 2026;
const BASELINE_TIMESTAMP = "2026-08-26T12:00:00.000Z";
const RESET_ADVISORY_LOCK_KEY = "business-finlynq-demo-sandbox-reset";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const BASE_ACCOUNTS = [
  ["1000", "Cash", "ASSET", "NONE"],
  ["1100", "Accounts receivable", "ASSET", "AR"],
  ["1400", "Prepaid expenses", "ASSET", "NONE"],
  ["1500", "Recoverable input tax", "ASSET", "NONE"],
  ["2000", "Accounts payable", "LIABILITY", "AP"],
  ["2200", "Sales and use tax payable", "LIABILITY", "NONE"],
  ["2300", "Accrued liabilities", "LIABILITY", "NONE"],
  ["3000", "Owner equity", "EQUITY", "NONE"],
  ["4100", "Service revenue", "REVENUE", "NONE"],
  ["4900", "Realized FX gain", "REVENUE", "NONE"],
  ["6100", "Operating expenses", "EXPENSE", "NONE"],
  ["7100", "Realized FX loss", "EXPENSE", "NONE"],
  ["7190", "FX rounding", "EXPENSE", "NONE"],
] as const;

const SEGMENTS = [
  ["subaccount", 3, "Subaccount", "CONFIGURED_UNBOUND", true],
  ["department", 4, "Department", "CONFIGURED_UNBOUND", true],
  ...Array.from({ length: 8 }, (_, index) => [
    `custom${index + 1}`,
    index + 6,
    `Custom ${index + 1}`,
    "EMPTY",
    false,
  ] as const),
] as const;

const FOUNDATIONS = [
  {
    entityCode: "CA01",
    entityName: "Northstar Services Canada Inc.",
    countryCode: "CA",
    regionCode: "ON",
    currency: "CAD",
    accountingProfile: "CAN_ASPE",
  },
  {
    entityCode: "US01",
    entityName: "Northstar Services USA LLC",
    countryCode: "US",
    regionCode: "WA",
    currency: "USD",
    accountingProfile: "US_GAAP_NONPUBLIC",
  },
] as const;

const DEMO_PARTIES = [
  {
    key: "harbour-dental",
    publicId: "10000000-0000-4000-8000-000000000101",
    publicAddressId: "10000000-0000-4000-8000-000000000111",
    number: "P-000184",
    name: "Harbour Dental Group",
    address: {
      line1: "184 Harbour Avenue",
      city: "Toronto",
      region: "ON",
      postalCode: "M5V 2T6",
      countryCode: "CA",
    },
    accounts: [{ entityCode: "CA01", role: "CUSTOMER", number: "C-CA-0001" }],
  },
  {
    key: "pine-lake",
    publicId: "10000000-0000-4000-8000-000000000103",
    publicAddressId: "10000000-0000-4000-8000-000000000113",
    number: "P-000256",
    name: "Pine and Lake Advisory",
    address: {
      line1: "256 Pine Street",
      city: "Toronto",
      region: "ON",
      postalCode: "M4B 1B3",
      countryCode: "CA",
    },
    accounts: [{ entityCode: "CA01", role: "SUPPLIER", number: "V-CA-0001" }],
  },
  {
    key: "rainier-creative",
    number: "P-000271",
    name: "Rainier Creative Studio",
    address: {
      line1: "271 Rainier Avenue",
      city: "Seattle",
      region: "WA",
      postalCode: "98144",
      countryCode: "US",
    },
    accounts: [{ entityCode: "US01", role: "CUSTOMER", number: "C-US-0001" }],
  },
  {
    key: "cascade-office",
    publicId: "10000000-0000-4000-8000-000000000102",
    publicAddressId: "10000000-0000-4000-8000-000000000112",
    number: "P-000203",
    name: "Cascade Office Supply",
    address: {
      line1: "203 Cascade Way",
      city: "Seattle",
      region: "WA",
      postalCode: "98101",
      countryCode: "US",
    },
    accounts: [{ entityCode: "US01", role: "SUPPLIER", number: "V-US-0001" }],
  },
] as const;

const PURGE_TABLES = [
  "open_item_void_events",
  "document_settlement_allocations",
  "journal_entry_relations",
  "journal_approvals",
  "journal_lines",
  "open_items",
  "subledger_events",
  "tax_determination_snapshots",
  "journal_entries",
  "source_documents",
  "party_addresses",
  "party_accounts",
  "parties",
  "entity_tax_registrations",
  "period_events",
  "ledger_posting_policies",
  "ledger_number_sequences",
  "account_combinations",
  "segment_values",
  "segment_definitions",
  "fiscal_periods",
  "gl_accounts",
  "ledgers",
  "legal_entities",
  "audit_events",
  "outbox_events",
] as const;

type SeedIdentity = Readonly<{
  organizationId: string;
  userId: string;
  slug: string;
  organizationName: string;
  publicTemplate?: boolean;
}>;

type SeededFoundation = Readonly<{
  legalEntityId: string;
  ledgerId: string;
  currency: "CAD" | "USD";
  accountIds: ReadonlyMap<string, string>;
  combinationIds: ReadonlyMap<string, string>;
}>;

type SandboxSlot = Readonly<{
  slot: number;
  organization_id: string;
  user_id: string | null;
}>;

type SandboxCandidate = Readonly<{
  slot: number;
  organization_id: string;
}>;

function deterministicUuid(organizationId: string, scope: string): string {
  const bytes = createHash("sha256")
    .update(`business-finlynq|demo-baseline-v${DEMO_BASELINE_VERSION}|${organizationId}|${scope}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fixtureId(identity: SeedIdentity, scope: string, publicId?: string): string {
  return identity.publicTemplate && publicId
    ? publicId
    : deterministicUuid(identity.organizationId, scope);
}

function monthDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

async function seedTaxPackVersions(client: PoolClient): Promise<void> {
  const packs = [
    {
      id: deterministicUuid(DEMO_ORGANIZATION_ID, "tax-pack:ca.on.hst:2026.08.26"),
      key: "ca.on.hst",
      version: "2026.08.26",
      jurisdiction: "CA-ON",
      effectiveFrom: "2016-07-01",
      effectiveTo: null,
      source: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html",
    },
    {
      id: deterministicUuid(DEMO_ORGANIZATION_ID, "tax-pack:us.wa.sales-use:2026.Q3.DOR"),
      key: "us.wa.sales-use",
      version: "2026.Q3.DOR",
      jurisdiction: "US-WA-1726",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-09-30",
      source: "https://dor.wa.gov/taxes-rates/sales-use-tax-rates/local-sales-use-tax/local-sales-use-tax-rate-table",
    },
  ] as const;

  for (const pack of packs) {
    const digest = createHash("sha256")
      .update(`${pack.key}|${pack.version}|${pack.source}`, "utf8")
      .digest("hex");
    await client.query(
      `INSERT INTO tax_pack_versions (
         id, pack_key, version, jurisdiction, effective_from, effective_to,
         source_uri, source_digest, approved_by, approved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (pack_key, version) DO UPDATE SET
         jurisdiction = EXCLUDED.jurisdiction,
         effective_from = EXCLUDED.effective_from,
         effective_to = EXCLUDED.effective_to,
         source_uri = EXCLUDED.source_uri,
         source_digest = EXCLUDED.source_digest`,
      [
        pack.id,
        pack.key,
        pack.version,
        pack.jurisdiction,
        pack.effectiveFrom,
        pack.effectiveTo,
        pack.source,
        digest,
        DEMO_USER_ID,
        BASELINE_TIMESTAMP,
      ],
    );
  }
}

async function seedLedgerFoundation(
  client: PoolClient,
  identity: SeedIdentity,
  foundation: (typeof FOUNDATIONS)[number],
): Promise<SeededFoundation> {
  const requestedEntityId = fixtureId(identity, `entity:${foundation.entityCode}`);
  const entity = await client.query<{ id: string }>(
    `INSERT INTO legal_entities (
       id, organization_id, code, display_name, country_code, region_code, active, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, true, $7)
     ON CONFLICT (organization_id, code) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       country_code = EXCLUDED.country_code,
       region_code = EXCLUDED.region_code,
       active = true
     RETURNING id`,
    [
      requestedEntityId,
      identity.organizationId,
      foundation.entityCode,
      foundation.entityName,
      foundation.countryCode,
      foundation.regionCode,
      BASELINE_TIMESTAMP,
    ],
  );
  const legalEntityId = entity.rows[0]?.id;
  if (!legalEntityId) throw new Error(`Unable to seed demo legal entity ${foundation.entityCode}`);

  const requestedLedgerId = fixtureId(identity, `ledger:${foundation.entityCode}:primary`);
  const ledger = await client.query<{ id: string }>(
    `INSERT INTO ledgers (
       id, organization_id, legal_entity_id, code, display_name, kind,
       accounting_profile, functional_currency, active, first_posted_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'PRIMARY', $6, $7, true, NULL, $8)
     ON CONFLICT (organization_id, code) DO UPDATE SET
       legal_entity_id = EXCLUDED.legal_entity_id,
       display_name = EXCLUDED.display_name,
       kind = 'PRIMARY',
       accounting_profile = EXCLUDED.accounting_profile,
       functional_currency = EXCLUDED.functional_currency,
       active = true
     RETURNING id`,
    [
      requestedLedgerId,
      identity.organizationId,
      legalEntityId,
      `${foundation.entityCode}-PRIMARY`,
      `${foundation.entityName} primary ledger`,
      foundation.accountingProfile,
      foundation.currency,
      BASELINE_TIMESTAMP,
    ],
  );
  const ledgerId = ledger.rows[0]?.id;
  if (!ledgerId) throw new Error(`Unable to seed demo ledger ${foundation.entityCode}`);

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const startsOn = monthDate(DEMO_FISCAL_YEAR, monthIndex, 1);
    const endsOn = monthIndex === 11
      ? monthDate(DEMO_FISCAL_YEAR, 11, 31)
      : monthDate(DEMO_FISCAL_YEAR, monthIndex + 1, 0);
    await client.query(
      `INSERT INTO fiscal_periods (
         id, organization_id, ledger_id, fiscal_year, period_number,
         label, starts_on, ends_on, state, version, closed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', 1, NULL)
       ON CONFLICT (ledger_id, fiscal_year, period_number) DO UPDATE SET
         label = EXCLUDED.label,
         starts_on = EXCLUDED.starts_on,
         ends_on = EXCLUDED.ends_on,
         state = 'OPEN',
         version = 1,
         closed_at = NULL`,
      [
        fixtureId(identity, `period:${foundation.entityCode}:${monthIndex + 1}`),
        identity.organizationId,
        ledgerId,
        DEMO_FISCAL_YEAR,
        monthIndex + 1,
        `${MONTH_NAMES[monthIndex]} ${DEMO_FISCAL_YEAR}`,
        startsOn,
        endsOn,
      ],
    );
  }

  const accountIds = new Map<string, string>();
  const combinationIds = new Map<string, string>();
  for (const [code, displayName, accountClass, controlKind] of BASE_ACCOUNTS) {
    const account = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (
         id, organization_id, ledger_id, code, display_name, class,
         control_kind, postable, active, valid_from, valid_to
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8, NULL)
       ON CONFLICT (ledger_id, code) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         class = EXCLUDED.class,
         control_kind = EXCLUDED.control_kind,
         postable = true,
         active = true,
         valid_from = EXCLUDED.valid_from,
         valid_to = NULL
       RETURNING id`,
      [
        fixtureId(identity, `account:${foundation.entityCode}:${code}`),
        identity.organizationId,
        ledgerId,
        code,
        displayName,
        accountClass,
        controlKind,
        `${DEMO_FISCAL_YEAR}-01-01`,
      ],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error(`Unable to seed demo account ${foundation.entityCode}.${code}`);
    accountIds.set(code, accountId);

    const existingCombination = await client.query<{ id: string }>(
      `SELECT id FROM account_combinations
       WHERE organization_id = $1 AND ledger_id = $2
         AND entity_id = $3 AND account_id = $4
         AND subaccount_id IS NULL AND department_id IS NULL
         AND intercompany_entity_id IS NULL AND custom_1_id IS NULL
         AND custom_2_id IS NULL AND custom_3_id IS NULL AND custom_4_id IS NULL
         AND custom_5_id IS NULL AND custom_6_id IS NULL AND custom_7_id IS NULL
         AND custom_8_id IS NULL`,
      [identity.organizationId, ledgerId, legalEntityId, accountId],
    );
    let combinationId = existingCombination.rows[0]?.id;
    if (!combinationId) {
      combinationId = fixtureId(identity, `combination:${foundation.entityCode}:${code}`);
      await client.query(
        `INSERT INTO account_combinations (
           id, organization_id, ledger_id, entity_id, account_id,
           active, created_at, schema_version
         ) VALUES ($1, $2, $3, $4, $5, true, $6, 1)`,
        [combinationId, identity.organizationId, ledgerId, legalEntityId, accountId, BASELINE_TIMESTAMP],
      );
    }
    combinationIds.set(code, combinationId);
  }

  await client.query(
    `INSERT INTO ledger_posting_policies (
       organization_id, ledger_id, manual_mode, version, updated_by, updated_at
     ) VALUES ($1, $2, 'AUTO_POST', 1, $3, $4)
     ON CONFLICT (ledger_id) DO NOTHING`,
    [identity.organizationId, ledgerId, identity.userId, BASELINE_TIMESTAMP],
  );

  return {
    legalEntityId,
    ledgerId,
    currency: foundation.currency,
    accountIds,
    combinationIds,
  };
}

async function seedSegmentDefinitions(client: PoolClient, identity: SeedIdentity): Promise<void> {
  for (const [key, ordinal, displayName, state, visible] of SEGMENTS) {
    await client.query(
      `INSERT INTO segment_definitions (
         id, organization_id, key, ordinal, display_name, state,
         required, visible, protected_use_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, NULL)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [fixtureId(identity, `segment:${key}`), identity.organizationId, key, ordinal, displayName, state, visible],
    );
  }
}

async function seedEncryptedPartyData(
  client: PoolClient,
  identity: SeedIdentity,
  foundations: ReadonlyMap<string, SeededFoundation>,
): Promise<void> {
  const activeKey = await loadActiveOrganizationKey(client, identity.organizationId);
  try {
    for (const party of DEMO_PARTIES) {
      const existingParty = await client.query<{ id: string }>(
        `SELECT id FROM parties WHERE organization_id = $1 AND party_number = $2`,
        [identity.organizationId, party.number],
      );
      const publicPartyId = "publicId" in party ? party.publicId : undefined;
      const partyId = existingParty.rows[0]?.id ?? fixtureId(identity, `party:${party.key}`, publicPartyId);
      const encryptedName = encryptField(party.name, activeKey.dek, {
        organizationId: identity.organizationId,
        table: "parties",
        column: "display_name_ciphertext",
        recordId: partyId,
        keyVersion: activeKey.keyVersion,
      });
      await client.query(
        `INSERT INTO parties (
           id, organization_id, party_number, display_name_ciphertext,
           display_name_key_version, search_token, command_hash, active, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT (organization_id, party_number) DO UPDATE SET
           display_name_ciphertext = EXCLUDED.display_name_ciphertext,
           display_name_key_version = EXCLUDED.display_name_key_version,
           search_token = EXCLUDED.search_token,
           active = true`,
        [
          partyId,
          identity.organizationId,
          party.number,
          serializeEncryptedField(encryptedName),
          activeKey.keyVersion,
          createBlindIndex(party.name, activeKey.dek, identity.organizationId, "parties.display-name"),
          createHash("sha256").update(`demo-party:${identity.organizationId}:${party.key}`, "utf8").digest("hex"),
          BASELINE_TIMESTAMP,
        ],
      );

      const existingAddress = await client.query<{ id: string }>(
        `SELECT id FROM party_addresses
         WHERE organization_id = $1 AND party_id = $2 AND kind = 'BILLING'
         ORDER BY valid_from DESC, id LIMIT 1`,
        [identity.organizationId, partyId],
      );
      const publicAddressId = "publicAddressId" in party ? party.publicAddressId : undefined;
      const addressId = existingAddress.rows[0]?.id ?? fixtureId(
        identity,
        `party-address:${party.key}:billing`,
        publicAddressId,
      );
      const encryptedAddress = encryptField(JSON.stringify(party.address), activeKey.dek, {
        organizationId: identity.organizationId,
        table: "party_addresses",
        column: "ciphertext",
        recordId: addressId,
        keyVersion: activeKey.keyVersion,
      });
      await client.query(
        `INSERT INTO party_addresses (
           id, organization_id, party_id, kind, ciphertext, key_version,
           valid_from, valid_to, created_at
         ) VALUES ($1, $2, $3, 'BILLING', $4, $5, '2026-01-01', NULL, $6)
         ON CONFLICT (id) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           key_version = EXCLUDED.key_version,
           valid_from = EXCLUDED.valid_from,
           valid_to = NULL`,
        [
          addressId,
          identity.organizationId,
          partyId,
          serializeEncryptedField(encryptedAddress),
          String(activeKey.keyVersion),
          BASELINE_TIMESTAMP,
        ],
      );

      for (const account of party.accounts) {
        const selectedFoundation = foundations.get(account.entityCode);
        if (!selectedFoundation) throw new Error(`Missing ${account.entityCode} demo foundation`);
        const controlCode = account.role === "CUSTOMER" ? "1100" : "2000";
        const controlAccountId = selectedFoundation.accountIds.get(controlCode);
        if (!controlAccountId) throw new Error(`Missing ${account.entityCode}.${controlCode} control account`);
        await client.query(
          `INSERT INTO party_accounts (
             id, organization_id, legal_entity_id, ledger_id, party_id,
             role, account_number, control_account_id, transaction_currency,
             active, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
           ON CONFLICT (legal_entity_id, role, account_number) DO UPDATE SET
             party_id = EXCLUDED.party_id,
             ledger_id = EXCLUDED.ledger_id,
             control_account_id = EXCLUDED.control_account_id,
             transaction_currency = EXCLUDED.transaction_currency,
             active = true`,
          [
            fixtureId(identity, `party-account:${account.entityCode}:${account.role}:${party.key}`),
            identity.organizationId,
            selectedFoundation.legalEntityId,
            selectedFoundation.ledgerId,
            partyId,
            account.role,
            account.number,
            controlAccountId,
            // Demo party accounts are deliberately currency-unrestricted so
            // visitors can exercise foreign-currency documents and realized
            // FX while open items and settlements still remain currency-bound.
            null,
            BASELINE_TIMESTAMP,
          ],
        );
      }
    }

    for (const foundation of FOUNDATIONS) {
      const selectedFoundation = foundations.get(foundation.entityCode);
      if (!selectedFoundation) throw new Error(`Missing ${foundation.entityCode} demo tax foundation`);
      const registrationId = fixtureId(identity, `tax-registration:${foundation.entityCode}`);
      const registrationValue = foundation.countryCode === "CA"
        ? "SYNTHETIC-DEMO-GST-HST-000001"
        : "SYNTHETIC-DEMO-WA-1726-000001";
      const encryptedRegistration = encryptField(registrationValue, activeKey.dek, {
        organizationId: identity.organizationId,
        table: "entity_tax_registrations",
        column: "registration_ciphertext",
        recordId: registrationId,
        keyVersion: activeKey.keyVersion,
      });
      await client.query(
        `INSERT INTO entity_tax_registrations (
           id, organization_id, legal_entity_id, regime_key,
           registration_ciphertext, key_version, valid_from, valid_to
         ) VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01', NULL)
         ON CONFLICT (id) DO UPDATE SET
           registration_ciphertext = EXCLUDED.registration_ciphertext,
           key_version = EXCLUDED.key_version,
           valid_from = EXCLUDED.valid_from,
           valid_to = NULL`,
        [
          registrationId,
          identity.organizationId,
          selectedFoundation.legalEntityId,
          foundation.countryCode === "CA" ? "ca.on.hst" : "us.wa.sales-use",
          serializeEncryptedField(encryptedRegistration),
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
  identity: SeedIdentity,
  input: Readonly<{
    fixtureKey: string;
    publicId?: string;
    entityCode: string;
    foundation: SeededFoundation;
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
  }>(
    `SELECT period.id AS period_id, journal_type.id AS journal_type_id,
       journal_type.version AS journal_type_version
     FROM fiscal_periods period
     JOIN LATERAL (
       SELECT id, version FROM journal_type_definitions
       WHERE key = 'ledger.manual' ORDER BY version DESC LIMIT 1
     ) journal_type ON true
     WHERE period.organization_id = $1 AND period.ledger_id = $2
       AND period.fiscal_year = $3 AND period.period_number = 8`,
    [identity.organizationId, input.foundation.ledgerId, DEMO_FISCAL_YEAR],
  );
  const selected = setup.rows[0];
  const debitCombinationId = input.foundation.combinationIds.get(input.debitAccount);
  const creditCombinationId = input.foundation.combinationIds.get(input.creditAccount);
  if (!selected || !debitCombinationId || !creditCombinationId) {
    throw new Error(`Demo ${input.entityCode} journal foundation is incomplete`);
  }

  const requestedJournalId = fixtureId(identity, `journal:${input.fixtureKey}`, input.publicId);
  const idempotencyKey = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:${input.fixtureKey}`;
  const commandHash = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  const existingJournal = await client.query<{ id: string }>(
    `SELECT id FROM journal_entries
     WHERE organization_id = $1 AND (id = $2 OR idempotency_key = $3)
     ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [identity.organizationId, requestedJournalId, idempotencyKey],
  );
  const journalId = existingJournal.rows[0]?.id ?? requestedJournalId;
  if (existingJournal.rows.length === 0) {
    await client.query(
      `INSERT INTO journal_entries (
         id, organization_id, ledger_id, legal_entity_id, period_id,
         journal_type_key, journal_type_definition_id, journal_type_version,
         source_event_key, idempotency_key, command_hash, origin, purpose,
         status, accounting_date, functional_currency, description, created_by, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'ledger.manual', $6, $7,
         $8, $8, $9, 'USER', 'ROUTINE', 'DRAFT', '2026-08-26', $10, $11, $12, $13
       )`,
      [
        journalId,
        identity.organizationId,
        input.foundation.ledgerId,
        input.foundation.legalEntityId,
        selected.period_id,
        selected.journal_type_id,
        selected.journal_type_version,
        idempotencyKey,
        commandHash,
        input.foundation.currency,
        input.description,
        identity.userId,
        BASELINE_TIMESTAMP,
      ],
    );
  }
  await client.query(
    `INSERT INTO journal_lines (
       id, organization_id, ledger_id, journal_entry_id, line_number,
       account_combination_id, debit_functional, credit_functional,
       transaction_currency, debit_transaction, credit_transaction,
       fx_rate, fx_rate_source, fx_rate_effective_at, memo
     ) VALUES
       ($1, $2, $3, $4, 1, $5, $7, 0, $8, $7, 0, 1, 'functional', $9, 'Synthetic demo debit'),
       ($6, $2, $3, $4, 2, $10, 0, $7, $8, 0, $7, 1, 'functional', $9, 'Synthetic demo credit')
     ON CONFLICT (journal_entry_id, line_number) DO NOTHING`,
    [
      fixtureId(identity, `journal-line:${input.fixtureKey}:1`),
      identity.organizationId,
      input.foundation.ledgerId,
      journalId,
      debitCombinationId,
      fixtureId(identity, `journal-line:${input.fixtureKey}:2`),
      input.amount,
      input.foundation.currency,
      BASELINE_TIMESTAMP,
      creditCombinationId,
    ],
  );
}

async function seedOrganizationBaseline(client: PoolClient, identity: SeedIdentity): Promise<void> {
  await ensureOperatorOrganizationKey(client, identity.organizationId);
  const foundations = new Map<string, SeededFoundation>();
  for (const foundation of FOUNDATIONS) {
    foundations.set(foundation.entityCode, await seedLedgerFoundation(client, identity, foundation));
  }
  await seedSegmentDefinitions(client, identity);
  await seedEncryptedPartyData(client, identity, foundations);

  const ca = foundations.get("CA01");
  const us = foundations.get("US01");
  if (!ca || !us) throw new Error("Demo ledger foundations are incomplete");
  await seedDraftJournal(client, identity, {
    fixtureKey: "ca-software-accrual",
    publicId: "10000000-0000-4000-8000-000000000201",
    entityCode: "CA01",
    foundation: ca,
    description: "Synthetic Canadian software accrual",
    debitAccount: "6100",
    creditAccount: "2300",
    amount: "1250.00",
  });
  await seedDraftJournal(client, identity, {
    fixtureKey: "us-prepaid-expense",
    publicId: "10000000-0000-4000-8000-000000000202",
    entityCode: "US01",
    foundation: us,
    description: "Synthetic US prepaid expense entry",
    debitAccount: "1400",
    creditAccount: "1000",
    amount: "2400.00",
  });
}

async function assertOperatorDatabaseOwner(client: PoolClient): Promise<void> {
  const result = await client.query<{ owns_database: boolean; can_reset: boolean }>(
    `SELECT
       current_user = pg_get_userbyid(database.datdba) AS owns_database,
       has_parameter_privilege(current_user, 'session_replication_role', 'SET') AS can_reset
     FROM pg_database database
     WHERE database.datname = current_database()`,
  );
  if (!result.rows[0]?.owns_database || !result.rows[0]?.can_reset) {
    throw new Error("Demo sandbox reset must run as the database-owner maintenance role");
  }
}

async function listSandboxCandidates(
  client: PoolClient,
  nightly: boolean,
): Promise<readonly SandboxCandidate[]> {
  const result = await client.query<SandboxCandidate>(
    `SELECT slot.slot, slot.organization_id
     FROM demo_sandbox_slots slot
     WHERE $1::boolean
       OR slot.state IN ('DIRTY', 'RESETTING')
       OR (
         slot.state = 'LEASED'
         AND NOT EXISTS (
           SELECT 1 FROM auth_sessions selected_session
           WHERE selected_session.id = slot.lease_session_id
             AND selected_session.organization_id = slot.organization_id
             AND selected_session.session_mode = 'DEMO'
             AND selected_session.demo_generation = slot.generation
             AND selected_session.revoked_at IS NULL
             AND selected_session.expires_at > now()
             AND selected_session.idle_expires_at > now()
         )
       )
     ORDER BY slot.slot`,
    [nightly],
  );
  return result.rows;
}

async function claimSandboxForReset(
  client: PoolClient,
  candidate: SandboxCandidate,
  nightly: boolean,
): Promise<SandboxSlot | null> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '45s'");

    // Tenant transactions lock their one live auth row before the slot. Taking
    // the same locks exclusively drains the old visitor without blocking any
    // other sandbox's data tables.
    await client.query(
      `SELECT id FROM auth_sessions
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL
       ORDER BY id
       FOR UPDATE`,
      [candidate.organization_id],
    );
    const selected = await client.query<{
      state: string;
      lease_session_id: string | null;
      live_lease: boolean;
    }>(
      `SELECT slot.state, slot.lease_session_id,
         EXISTS (
           SELECT 1 FROM auth_sessions selected_session
           WHERE selected_session.id = slot.lease_session_id
             AND selected_session.organization_id = slot.organization_id
             AND selected_session.session_mode = 'DEMO'
             AND selected_session.demo_generation = slot.generation
             AND selected_session.revoked_at IS NULL
             AND selected_session.expires_at > now()
             AND selected_session.idle_expires_at > now()
         ) AS live_lease
       FROM demo_sandbox_slots slot
       WHERE slot.slot = $1 AND slot.organization_id = $2
       FOR UPDATE OF slot`,
      [candidate.slot, candidate.organization_id],
    );
    const slot = selected.rows[0];
    const eligible = nightly || slot?.state === "DIRTY" || slot?.state === "RESETTING" ||
      (slot?.state === "LEASED" && !slot.live_lease);
    if (!slot || !eligible) {
      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `UPDATE auth_sessions
       SET revoked_at = coalesce(revoked_at, now())
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL`,
      [candidate.organization_id],
    );
    await client.query(
      `UPDATE demo_sandbox_slots
       SET state = 'RESETTING', lease_session_id = NULL
       WHERE slot = $1 AND organization_id = $2`,
      [candidate.slot, candidate.organization_id],
    );
    const membership = await client.query<{ user_id: string }>(
      `SELECT selected_membership.user_id
       FROM organization_memberships selected_membership
       JOIN membership_roles selected_assignment
         ON selected_assignment.organization_id = selected_membership.organization_id
        AND selected_assignment.membership_id = selected_membership.id
       JOIN roles selected_role
         ON selected_role.organization_id = selected_assignment.organization_id
        AND selected_role.id = selected_assignment.role_id
       WHERE selected_membership.organization_id = $1
         AND selected_membership.active
         AND selected_role.active
         AND selected_role.key = 'demo_accountant'
       ORDER BY selected_membership.id
       LIMIT 1`,
      [candidate.organization_id],
    );
    await client.query("COMMIT");
    return {
      slot: candidate.slot,
      organization_id: candidate.organization_id,
      user_id: membership.rows[0]?.user_id ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function purgeSandboxBusinessData(client: PoolClient, organizationId: string): Promise<void> {
  await client.query("SET LOCAL session_replication_role = replica");
  try {
    for (const table of PURGE_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId]);
    }
  } finally {
    await client.query("SET LOCAL session_replication_role = origin");
  }
}

async function verifySandboxBaseline(client: PoolClient, organizationId: string): Promise<void> {
  const result = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM legal_entities WHERE organization_id = $1)::text AS entities,
       (SELECT count(*) FROM ledgers WHERE organization_id = $1)::text AS ledgers,
       (SELECT count(*) FROM fiscal_periods WHERE organization_id = $1)::text AS periods,
       (SELECT count(*) FROM gl_accounts WHERE organization_id = $1)::text AS accounts,
       (SELECT count(*) FROM account_combinations WHERE organization_id = $1)::text AS combinations,
       (SELECT count(*) FROM segment_definitions WHERE organization_id = $1)::text AS segments,
       (SELECT count(*) FROM parties WHERE organization_id = $1)::text AS parties,
       (SELECT count(*) FROM party_addresses WHERE organization_id = $1)::text AS addresses,
       (SELECT count(*) FROM party_accounts WHERE organization_id = $1)::text AS party_accounts,
       (SELECT count(*) FROM party_accounts
          WHERE organization_id = $1 AND transaction_currency IS NOT NULL)::text
         AS currency_restricted_party_accounts,
       (SELECT count(*) FROM entity_tax_registrations WHERE organization_id = $1)::text AS registrations,
       (SELECT count(*) FROM ledger_posting_policies WHERE organization_id = $1)::text AS posting_policies,
       (SELECT count(*) FROM journal_entries WHERE organization_id = $1)::text AS journals,
       (SELECT count(*) FROM journal_lines WHERE organization_id = $1)::text AS lines,
       (SELECT count(*) FROM source_documents WHERE organization_id = $1)::text AS source_documents,
       (SELECT count(*) FROM subledger_events WHERE organization_id = $1)::text AS subledger_events,
       (SELECT count(*) FROM open_items WHERE organization_id = $1)::text AS open_items,
       (SELECT count(*) FROM open_item_void_events WHERE organization_id = $1)::text AS open_item_void_events,
       (SELECT count(*) FROM document_settlement_allocations WHERE organization_id = $1)::text AS allocations,
       (SELECT count(*) FROM audit_events WHERE organization_id = $1)::text AS audit_events,
       (SELECT count(*) FROM outbox_events WHERE organization_id = $1)::text AS outbox_events`,
    [organizationId],
  );
  const counts = result.rows[0];
  const expected: Readonly<Record<string, string>> = {
    entities: "2",
    ledgers: "2",
    periods: "24",
    accounts: "26",
    combinations: "26",
    segments: "10",
    parties: "4",
    addresses: "4",
    party_accounts: "4",
    currency_restricted_party_accounts: "0",
    registrations: "2",
    posting_policies: "2",
    journals: "2",
    lines: "4",
    source_documents: "0",
    subledger_events: "0",
    open_items: "0",
    open_item_void_events: "0",
    allocations: "0",
    audit_events: "0",
    outbox_events: "0",
  };
  if (!counts || Object.entries(expected).some(([key, value]) => counts[key] !== value)) {
    throw new Error(`Demo sandbox baseline verification failed for ${organizationId}`);
  }
}

async function quarantineSlot(client: PoolClient, slot: SandboxSlot): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '45s'");
    await client.query(
      `SELECT id FROM auth_sessions
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL
       ORDER BY id
       FOR UPDATE`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL`,
      [slot.organization_id],
    );
    await client.query(
      `SELECT slot FROM demo_sandbox_slots
       WHERE slot = $1 AND organization_id = $2
       FOR UPDATE`,
      [slot.slot, slot.organization_id],
    );
    await client.query(
      `UPDATE demo_sandbox_slots
       SET state = 'QUARANTINED', lease_session_id = NULL
       WHERE slot = $1 AND organization_id = $2 AND state = 'RESETTING'`,
      [slot.slot, slot.organization_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function resetClaimedSandbox(client: PoolClient, slot: SandboxSlot): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SET LOCAL lock_timeout = '45s'");
    await client.query(
      `SELECT id FROM auth_sessions
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL
       ORDER BY id
       FOR UPDATE`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL`,
      [slot.organization_id],
    );
    const selected = await client.query<{ organization_mode: string; state: string }>(
      `SELECT organization.organization_mode, sandbox.state
       FROM demo_sandbox_slots sandbox
       JOIN organizations organization ON organization.id = sandbox.organization_id
       WHERE sandbox.slot = $1 AND sandbox.organization_id = $2
       FOR UPDATE OF sandbox`,
      [slot.slot, slot.organization_id],
    );
    if (selected.rows[0]?.organization_mode !== "SANDBOX" || selected.rows[0]?.state !== "RESETTING") {
      throw new Error(`Demo sandbox slot ${slot.slot} is not eligible for reset`);
    }

    const suffix = String(slot.slot).padStart(2, "0");
    await client.query(
      `UPDATE organizations SET
         slug = $2, display_name = $3, active = true,
         is_demo = true, organization_mode = 'SANDBOX'
       WHERE id = $1`,
      [slot.organization_id, `northstar-sandbox-${suffix}`, `Northstar Demo Sandbox ${suffix}`],
    );
    if (!slot.user_id) {
      throw new Error(`Demo sandbox slot ${slot.slot} has no active demo accountant`);
    }
    await purgeSandboxBusinessData(client, slot.organization_id);
    await seedOrganizationBaseline(client, {
      organizationId: slot.organization_id,
      userId: slot.user_id,
      slug: `northstar-sandbox-${suffix}`,
      organizationName: `Northstar Demo Sandbox ${suffix}`,
    });
    await verifySandboxBaseline(client, slot.organization_id);
    const released = await client.query(
      `UPDATE demo_sandbox_slots SET
         state = 'READY',
         generation = generation + 1,
         lease_session_id = NULL,
         baseline_version = $2,
         last_claimed_at = NULL,
         last_reset_at = now()
       WHERE slot = $1 AND organization_id = $3 AND state = 'RESETTING'
       RETURNING slot`,
      [slot.slot, DEMO_BASELINE_VERSION, slot.organization_id],
    );
    if (released.rowCount !== 1) throw new Error(`Demo sandbox slot ${slot.slot} lost its reset claim`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function resetDemoSandboxes(
  pool: Pool,
  options: Readonly<{ nightly: boolean }>,
): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await assertOperatorDatabaseOwner(client);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [RESET_ADVISORY_LOCK_KEY]);
    lockHeld = true;
    const candidates = await listSandboxCandidates(client, options.nightly);
    const failures: string[] = [];
    for (const candidate of candidates) {
      const claimed = await claimSandboxForReset(client, candidate, options.nightly);
      if (!claimed) continue;
      try {
        await resetClaimedSandbox(client, claimed);
      } catch (error) {
        let quarantineFailure = "";
        try {
          await quarantineSlot(client, claimed);
        } catch (quarantineError) {
          quarantineFailure = `; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : "unknown error"}`;
        }
        failures.push(
          `slot ${claimed.slot}: ${error instanceof Error ? error.message : "reset failed"}${quarantineFailure}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`Demo sandbox reset quarantined ${failures.length} slot(s): ${failures.join("; ")}`);
    }
  } finally {
    try {
      if (lockHeld) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [RESET_ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}

export async function bootstrapDemoOrganization(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await assertOperatorDatabaseOwner(client);
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq-demo-bootstrap', 0))");
    const demo = await client.query<{ is_demo: boolean; organization_mode: string }>(
      "SELECT is_demo, organization_mode FROM organizations WHERE id = $1 FOR UPDATE",
      [DEMO_ORGANIZATION_ID],
    );
    if (!demo.rows[0]?.is_demo || demo.rows[0].organization_mode !== "PUBLIC_DEMO") {
      throw new Error("Fixed public demo template has not been installed by migrations");
    }
    const user = await client.query("SELECT 1 FROM users WHERE id = $1 AND is_demo AND active", [DEMO_USER_ID]);
    if (user.rows.length !== 1) throw new Error("Fixed public demo user has not been installed by migrations");

    await seedTaxPackVersions(client);
    await seedOrganizationBaseline(client, {
      organizationId: DEMO_ORGANIZATION_ID,
      userId: DEMO_USER_ID,
      slug: "northstar-demo",
      organizationName: "Northstar Demo Group",
      publicTemplate: true,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Deploys repair only new, dirty, expired, or interrupted slots. Active
  // leases survive releases; the nightly job intentionally resets all slots.
  await resetDemoSandboxes(pool, { nightly: false });
}
