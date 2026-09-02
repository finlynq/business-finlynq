import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  demoAccountingCalendar,
  demoDateOffset,
  demoPeriodState,
} from "@/modules/demo/accounting-clock";
import { DEMO_BASELINE_DATE, DEMO_ORGANIZATION_ID, DEMO_USER_ID } from "@/modules/demo/constants";
import { postJournalInTransaction } from "@/modules/ledger/posting-engine";
import {
  defaultFinancialStatementGroupCode,
  defaultFinancialStatementGroups,
} from "@/modules/ledger/accounting-hierarchy-contract";
import { buildIssueJournalLines } from "@/modules/subledger/journal-line-builders";
import {
  assertSnapshotTaxDecisionsCurrent,
  buildBusinessDocumentSnapshot,
  canonicalHash,
  sourceContentHash,
  type SubledgerOwnerModule,
} from "@/modules/subledger/document-model";
import {
  createBlindIndex,
  encryptField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import {
  WASHINGTON_SALES_USE_EFFECTIVE_FROM,
  WASHINGTON_SALES_USE_EFFECTIVE_TO,
  WASHINGTON_SALES_USE_SOURCE,
  washingtonSalesUsePack,
} from "@/modules/tax/packs/washington";
import { ensureOperatorOrganizationKey } from "./organization-service";

export { DEMO_ORGANIZATION_ID } from "@/modules/demo/constants";

// Increment whenever the exact reconstructed sandbox fixture changes. Bootstrap
// may refresh only unclaimed READY slots on an older version; assigned visitor
// workspaces remain untouched until the ordinary nightly reset.
const DEMO_BASELINE_VERSION = 6;
const DEMO_CALENDAR = demoAccountingCalendar();
const DEMO_FISCAL_YEAR = DEMO_CALENDAR.fiscalYear;
const DEMO_CURRENT_PERIOD = DEMO_CALENDAR.periodNumber;
const BASELINE_TIMESTAMP = DEMO_CALENDAR.timestamp;
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

const DEMO_ISSUED_DOCUMENTS = [
  {
    fixtureKey: "ca-sale-cad",
    entityCode: "CA01",
    partyKey: "harbour-dental",
    kind: "SALES_INVOICE",
    sourceNumber: "INV-CA-1001",
    documentDate: demoDateOffset(DEMO_CALENDAR.accountingDate, -16),
    dueOn: demoDateOffset(DEMO_CALENDAR.accountingDate, 14),
    currency: "CAD",
    fxRate: "1",
    fxSource: "FUNCTIONAL_CURRENCY",
    description: "Harbour Dental implementation services",
    lineDescription: "Implementation and onboarding services",
    netAmount: "10000.00",
    sourceAccountCode: "4100",
    controlAccountCode: "1100",
    taxAccountCode: "2200",
    tax: {
      packKey: "ca.on.hst",
      category: "STANDARD",
      destinationCountry: "CA",
      destinationRegion: "ON",
      destinationCity: "Toronto",
    },
  },
  {
    fixtureKey: "ca-supplier-bill-usd",
    entityCode: "CA01",
    partyKey: "pine-lake",
    kind: "SUPPLIER_BILL",
    sourceNumber: "BILL-CA-FX-3001",
    documentDate: demoDateOffset(DEMO_CALENDAR.accountingDate, -14),
    dueOn: demoDateOffset(DEMO_CALENDAR.accountingDate, 16),
    currency: "USD",
    fxRate: "1.34",
    fxSource: "DEMO_BANK_OF_CANADA_DAILY",
    description: "Pine and Lake cross-border advisory bill",
    lineDescription: "Advisory services",
    netAmount: "3000.00",
    sourceAccountCode: "6100",
    controlAccountCode: "2000",
    taxAccountCode: "1500",
    tax: {
      packKey: "ca.on.hst",
      category: "STANDARD",
      destinationCountry: "CA",
      destinationRegion: "ON",
      destinationCity: "Toronto",
      recoverablePercent: "100",
    },
  },
  {
    fixtureKey: "us-sale-usd",
    entityCode: "US01",
    partyKey: "rainier-creative",
    kind: "SALES_INVOICE",
    sourceNumber: "INV-US-2001",
    documentDate: demoDateOffset(DEMO_CALENDAR.accountingDate, -11),
    dueOn: demoDateOffset(DEMO_CALENDAR.accountingDate, 19),
    currency: "USD",
    fxRate: "1",
    fxSource: "FUNCTIONAL_CURRENCY",
    description: "Rainier Creative managed-services invoice",
    lineDescription: "Managed business services",
    netAmount: "14000.00",
    sourceAccountCode: "4100",
    controlAccountCode: "1100",
    taxAccountCode: "2200",
    tax: {
      packKey: "us.wa.sales-use",
      category: "STANDARD",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
    },
  },
  {
    fixtureKey: "us-supplier-bill-cad",
    entityCode: "US01",
    partyKey: "cascade-office",
    kind: "SUPPLIER_BILL",
    sourceNumber: "BILL-US-FX-4001",
    documentDate: demoDateOffset(DEMO_CALENDAR.accountingDate, -8),
    dueOn: demoDateOffset(DEMO_CALENDAR.accountingDate, 22),
    currency: "CAD",
    fxRate: "0.74",
    fxSource: "DEMO_FEDERAL_RESERVE_DAILY",
    description: "Cascade Office cross-border supply bill",
    lineDescription: "Office supplies and workspace services",
    netAmount: "4000.00",
    sourceAccountCode: "6100",
    controlAccountCode: "2000",
    taxAccountCode: "2200",
    tax: {
      packKey: "us.wa.sales-use",
      category: "STANDARD",
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
    },
  },
] as const;

export type DemoSandboxResetMode = "bootstrap" | "nightly";

const SAFE_RESET_TABLE_NAME = /^[a-z][a-z0-9_]*$/;

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
  periodIds: ReadonlyMap<number, string>;
}>;

type SeededPartyData = Readonly<{
  partyAccountIds: ReadonlyMap<string, string>;
  registrationIds: ReadonlyMap<string, string>;
}>;

type SeededJournalToPost = Readonly<{
  fixtureKey: string;
  journalId: string;
  ownerModule: SubledgerOwnerModule | "ledger";
  journalTypeKey: "receivables.sales-invoice" | "payables.supplier-bill" | "ledger.manual";
}>;

type SandboxSlot = Readonly<{
  slot: number;
  organization_id: string;
  user_id: string | null;
}>;

type SandboxCandidate = Readonly<{
  slot: number;
  organization_id: string;
  baseline_version: number;
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
      id: deterministicUuid(DEMO_ORGANIZATION_ID, `tax-pack:${washingtonSalesUsePack.key}:${washingtonSalesUsePack.version}`),
      key: washingtonSalesUsePack.key,
      version: washingtonSalesUsePack.version,
      jurisdiction: "US-WA-1726",
      effectiveFrom: WASHINGTON_SALES_USE_EFFECTIVE_FROM,
      effectiveTo: WASHINGTON_SALES_USE_EFFECTIVE_TO,
      source: WASHINGTON_SALES_USE_SOURCE,
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

  const periodIds = new Map<number, string>();
  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const periodNumber = monthIndex + 1;
    const startsOn = monthDate(DEMO_FISCAL_YEAR, monthIndex, 1);
    const endsOn = monthIndex === 11
      ? monthDate(DEMO_FISCAL_YEAR, 11, 31)
      : monthDate(DEMO_FISCAL_YEAR, monthIndex + 1, 0);
    const state = demoPeriodState(periodNumber, DEMO_CURRENT_PERIOD);
    const period = await client.query<{ id: string }>(
      `INSERT INTO fiscal_periods (
         id, organization_id, ledger_id, fiscal_year, period_number,
         label, starts_on, ends_on, state, version, closed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10)
       ON CONFLICT (ledger_id, fiscal_year, period_number) DO UPDATE SET
         label = EXCLUDED.label,
         starts_on = EXCLUDED.starts_on,
         ends_on = EXCLUDED.ends_on
       RETURNING id`,
      [
        fixtureId(identity, `period:${foundation.entityCode}:${DEMO_FISCAL_YEAR}:${periodNumber}`),
        identity.organizationId,
        ledgerId,
        DEMO_FISCAL_YEAR,
        periodNumber,
        `${MONTH_NAMES[monthIndex]} ${DEMO_FISCAL_YEAR}`,
        startsOn,
        endsOn,
        state,
        state === "OPEN" ? null : BASELINE_TIMESTAMP,
      ],
    );
    const periodId = period.rows[0]?.id;
    if (!periodId) throw new Error(`Unable to seed ${foundation.entityCode} period ${periodNumber}`);
    periodIds.set(periodNumber, periodId);
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
        `${DEMO_BASELINE_DATE.slice(0, 4)}-01-01`,
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
    periodIds,
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

async function seedPublishedAccountHierarchies(
  client: PoolClient,
  identity: SeedIdentity,
  foundations: ReadonlyMap<string, SeededFoundation>,
): Promise<void> {
  const roots = [
    ["ASSETS", "Assets", "ASSET"],
    ["LIABILITIES", "Liabilities", "LIABILITY"],
    ["EQUITY", "Equity", "EQUITY"],
    ["REVENUE", "Revenue", "REVENUE"],
    ["EXPENSES", "Expenses", "EXPENSE"],
  ] as const;
  for (const foundation of FOUNDATIONS) {
    const seeded = foundations.get(foundation.entityCode);
    if (!seeded) throw new Error(`Missing ${foundation.entityCode} hierarchy foundation`);
    const hierarchyId = fixtureId(identity, `hierarchy:${foundation.entityCode}:primary-reporting:v1`);
    const existing = await client.query<{ status: string }>(
      `SELECT status FROM accounting_hierarchies
       WHERE organization_id = $1 AND ledger_id = $2
         AND dimension_key = 'account' AND code = 'PRIMARY_REPORTING'
         AND version = 1`,
      [identity.organizationId, seeded.ledgerId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "PUBLISHED") {
        throw new Error(`${foundation.entityCode} demo hierarchy is not published`);
      }
      continue;
    }
    await client.query(
      `INSERT INTO accounting_hierarchies(
         id, organization_id, ledger_id, dimension_key, code, display_name,
         version, revision, status, created_by, created_at
       ) VALUES ($1,$2,$3,'account','PRIMARY_REPORTING',$4,1,1,'DRAFT',$5,$6)`,
      [hierarchyId, identity.organizationId, seeded.ledgerId,
        `${foundation.entityCode} primary financial statements`, identity.userId, BASELINE_TIMESTAMP],
    );
    const rootIds = new Map<string, string>();
    for (const [index, [code, displayName, statementClass]] of roots.entries()) {
      const rootId = fixtureId(identity, `hierarchy-node:${foundation.entityCode}:${code}`);
      rootIds.set(statementClass, rootId);
      await client.query(
        `INSERT INTO accounting_hierarchy_nodes(
           id, organization_id, hierarchy_id, parent_id, code, display_name,
           sort_order, statement_class, member_type
         ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,NULL)`,
        [rootId, identity.organizationId, hierarchyId, code, displayName,
          (index + 1) * 100, statementClass],
      );
    }
    const groupIds = new Map<string, string>();
    for (const [index, group] of defaultFinancialStatementGroups.entries()) {
      const groupId = fixtureId(identity, `hierarchy-node:${foundation.entityCode}:${group.code}`);
      const parentId = rootIds.get(group.statementClass);
      if (!parentId) throw new Error(`Missing ${group.statementClass} demo hierarchy root`);
      groupIds.set(group.code, groupId);
      await client.query(
        `INSERT INTO accounting_hierarchy_nodes(
           id, organization_id, hierarchy_id, parent_id, code, display_name,
           sort_order, statement_class, member_type
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)`,
        [groupId, identity.organizationId, hierarchyId, parentId, group.code,
          group.displayName, (index + 1) * 100],
      );
    }
    for (const [index, [code, displayName, accountClass]] of BASE_ACCOUNTS.entries()) {
      const accountId = seeded.accountIds.get(code);
      const parentId = groupIds.get(defaultFinancialStatementGroupCode(accountClass, code));
      if (!accountId || !parentId) throw new Error(`Missing demo hierarchy account ${foundation.entityCode}.${code}`);
      await client.query(
        `INSERT INTO accounting_hierarchy_nodes(
           id, organization_id, hierarchy_id, parent_id, code, display_name,
           sort_order, statement_class, member_type, gl_account_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'ACCOUNT',$8)`,
        [fixtureId(identity, `hierarchy-node:${foundation.entityCode}:account:${code}`),
          identity.organizationId, hierarchyId, parentId, `A_${code}`, displayName,
          (index + 1) * 10, accountId],
      );
    }
    await client.query(
      `UPDATE accounting_hierarchies SET
         status = 'PUBLISHED', revision = 2, effective_from = $4,
         published_by = $5, published_at = $6
       WHERE organization_id = $1 AND id = $2 AND ledger_id = $3 AND status = 'DRAFT'`,
      [identity.organizationId, hierarchyId, seeded.ledgerId,
        `${DEMO_BASELINE_DATE.slice(0, 4)}-01-01`, identity.userId, BASELINE_TIMESTAMP],
    );
  }
}

async function seedEncryptedPartyData(
  client: PoolClient,
  identity: SeedIdentity,
  foundations: ReadonlyMap<string, SeededFoundation>,
): Promise<SeededPartyData> {
  const partyAccountIds = new Map<string, string>();
  const registrationIds = new Map<string, string>();
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
        const seededAccount = await client.query<{ id: string }>(
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
             active = true
           RETURNING id`,
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
        const partyAccountId = seededAccount.rows[0]?.id;
        if (!partyAccountId) throw new Error(`Unable to seed demo party account ${party.key}`);
        partyAccountIds.set(party.key, partyAccountId);
      }
    }

    for (const foundation of FOUNDATIONS) {
      const selectedFoundation = foundations.get(foundation.entityCode);
      if (!selectedFoundation) throw new Error(`Missing ${foundation.entityCode} demo tax foundation`);
      const regimeKey = foundation.countryCode === "CA" ? "ca.on.hst" : "us.wa.sales-use";
      // The public template is intentionally not purged. Reuse its semantic
      // registration row across baseline versions instead of letting a changed
      // deterministic fixture id create duplicates.
      const existingRegistration = await client.query<{ id: string }>(
        `SELECT id FROM entity_tax_registrations
         WHERE organization_id = $1 AND legal_entity_id = $2
           AND regime_key = $3 AND valid_to IS NULL
         ORDER BY valid_from DESC, id
         LIMIT 1`,
        [identity.organizationId, selectedFoundation.legalEntityId, regimeKey],
      );
      const registrationId = existingRegistration.rows[0]?.id ??
        fixtureId(identity, `tax-registration:${foundation.entityCode}`);
      const registrationValue = foundation.countryCode === "CA"
        ? "SYNTHETIC-DEMO-GST-HST-000001"
        : "SYNTHETIC-DEMO-WA-1726-000001";
      const destinationCountry = foundation.countryCode;
      const destinationRegion = foundation.regionCode;
      const destinationCity = foundation.countryCode === "CA" ? "Toronto" : "Seattle";
      const locationCode = foundation.countryCode === "CA" ? null : "1726";
      const configurationEvidence = foundation.countryCode === "CA"
        ? "Synthetic demo setup: explicit CA-ON place-of-supply facts"
        : "Synthetic demo setup: explicit Washington DOR Seattle location 1726";
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
           destination_country, destination_region, destination_city, location_code,
           configuration_evidence, registration_ciphertext, key_version,
           valid_from, valid_to
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '2026-01-01', NULL)
         ON CONFLICT (id) DO UPDATE SET
           destination_country = EXCLUDED.destination_country,
           destination_region = EXCLUDED.destination_region,
           destination_city = EXCLUDED.destination_city,
           location_code = EXCLUDED.location_code,
           configuration_evidence = EXCLUDED.configuration_evidence,
           registration_ciphertext = EXCLUDED.registration_ciphertext,
           key_version = EXCLUDED.key_version,
           valid_from = EXCLUDED.valid_from,
           valid_to = NULL`,
        [
          registrationId,
          identity.organizationId,
          selectedFoundation.legalEntityId,
          regimeKey,
          destinationCountry,
          destinationRegion,
          destinationCity,
          locationCode,
          configurationEvidence,
          serializeEncryptedField(encryptedRegistration),
          String(activeKey.keyVersion),
        ],
      );
      registrationIds.set(foundation.entityCode, registrationId);
    }
  } finally {
    activeKey.dek.fill(0);
  }
  return { partyAccountIds, registrationIds };
}

async function seedIssuedDemoDocument(
  client: PoolClient,
  identity: SeedIdentity,
  foundations: ReadonlyMap<string, SeededFoundation>,
  partyData: SeededPartyData,
  fixture: (typeof DEMO_ISSUED_DOCUMENTS)[number],
): Promise<SeededJournalToPost> {
  const foundation = foundations.get(fixture.entityCode);
  const partyAccountId = partyData.partyAccountIds.get(fixture.partyKey);
  const registrationId = partyData.registrationIds.get(fixture.entityCode);
  const periodId = foundation?.periodIds.get(DEMO_CURRENT_PERIOD);
  const sourceAccountCombinationId = foundation?.combinationIds.get(fixture.sourceAccountCode);
  const controlAccountCombinationId = foundation?.combinationIds.get(fixture.controlAccountCode);
  const taxAccountCombinationId = foundation?.combinationIds.get(fixture.taxAccountCode);
  const fxRoundingAccountCombinationId = foundation?.combinationIds.get("7190");
  if (
    !foundation || !partyAccountId || !registrationId || !periodId ||
    !sourceAccountCombinationId || !controlAccountCombinationId ||
    !taxAccountCombinationId || !fxRoundingAccountCombinationId
  ) {
    throw new Error(`Demo issued-document foundation is incomplete for ${fixture.fixtureKey}`);
  }

  const snapshot = buildBusinessDocumentSnapshot({
    kind: fixture.kind,
    sourceNumber: fixture.sourceNumber,
    ledgerId: foundation.ledgerId,
    legalEntityId: foundation.legalEntityId,
    partyAccountId,
    controlAccountCombinationId,
    taxAccountCombinationId,
    fxRoundingAccountCombinationId,
    documentDate: fixture.documentDate,
    accountingDate: fixture.documentDate,
    periodId,
    dueOn: fixture.dueOn,
    currency: fixture.currency,
    fx: {
      rate: fixture.fxRate,
      source: fixture.fxSource,
      effectiveAt: `${fixture.documentDate}T16:00:00.000Z`,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    },
    description: fixture.description,
    lines: [{
      description: fixture.lineDescription,
      accountCombinationId: sourceAccountCombinationId,
      netAmount: fixture.netAmount,
      tax: {
        ...fixture.tax,
        registrationId,
      },
    }],
  }, foundation.currency);
  assertSnapshotTaxDecisionsCurrent(snapshot);

  const draftSourceId = fixtureId(identity, `source-document:${fixture.fixtureKey}:draft`);
  const postedSourceId = fixtureId(identity, `source-document:${fixture.fixtureKey}:posted`);
  const draftIdempotencyKey = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:${fixture.fixtureKey}:draft`;
  const issueIdempotencyKey = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:${fixture.fixtureKey}:issue`;
  const contentHash = sourceContentHash(snapshot);
  const draftCommandHash = canonicalHash({
    operation: "create",
    fixtureKey: fixture.fixtureKey,
    snapshot,
  });
  const issueCommandHash = canonicalHash({
    operation: "issue",
    fixtureKey: fixture.fixtureKey,
    sourceNumber: fixture.sourceNumber,
    expectedVersion: 1,
  });

  await client.query(
    `INSERT INTO source_documents (
       id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash,
       idempotency_key, command_hash, supersedes_source_document_id,
       created_by, void_reason, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 1, 'DRAFT', $7::jsonb, $8,
       $9, $10, NULL, $11, NULL, $12
     )`,
    [
      draftSourceId,
      identity.organizationId,
      foundation.legalEntityId,
      snapshot.ownerModule,
      snapshot.sourceType,
      snapshot.sourceNumber,
      JSON.stringify(snapshot),
      contentHash,
      draftIdempotencyKey,
      draftCommandHash,
      identity.userId,
      BASELINE_TIMESTAMP,
    ],
  );
  await client.query(
    `INSERT INTO source_documents (
       id, organization_id, legal_entity_id, owner_module, source_type,
       source_number, version, status, snapshot, content_hash,
       idempotency_key, command_hash, supersedes_source_document_id,
       created_by, void_reason, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 2, 'POSTED', $7::jsonb, $8,
       $9, $10, $11, $12, NULL, $13
     )`,
    [
      postedSourceId,
      identity.organizationId,
      foundation.legalEntityId,
      snapshot.ownerModule,
      snapshot.sourceType,
      snapshot.sourceNumber,
      JSON.stringify(snapshot),
      contentHash,
      issueIdempotencyKey,
      issueCommandHash,
      draftSourceId,
      identity.userId,
      BASELINE_TIMESTAMP,
    ],
  );

  const taxSnapshotIds = new Map<number, string>();
  for (const line of snapshot.lines) {
    const decision = line.taxDecision;
    const taxPack = await client.query<{ id: string }>(
      `SELECT id FROM tax_pack_versions
       WHERE pack_key = $1 AND version = $2
       LIMIT 1`,
      [decision.packKey, decision.packVersion],
    );
    const taxPackVersionId = taxPack.rows[0]?.id;
    if (!taxPackVersionId) {
      throw new Error(`Approved tax pack is missing for ${fixture.fixtureKey}`);
    }
    const taxSnapshotId = fixtureId(
      identity,
      `tax-determination:${fixture.fixtureKey}:${line.lineNumber}`,
    );
    await client.query(
      `INSERT INTO tax_determination_snapshots (
         id, organization_id, ledger_id, legal_entity_id, tax_pack_version_id,
         source_document_id, status, rule_key, jurisdiction, currency,
         taxable_basis, total_tax, fact_snapshot, evidence_snapshot,
         component_snapshot, rounding_snapshot, gl_mapping_snapshot,
         decision_hash, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
         $17::jsonb, $18, $19
       )`,
      [
        taxSnapshotId,
        identity.organizationId,
        foundation.ledgerId,
        foundation.legalEntityId,
        taxPackVersionId,
        postedSourceId,
        decision.status,
        decision.ruleKey,
        decision.jurisdiction,
        snapshot.currency,
        line.netAmount,
        decision.totalTax,
        JSON.stringify(decision.facts),
        JSON.stringify({
          registrationReference: line.tax.registrationId ?? null,
          evidenceReference: line.tax.evidenceReference ?? null,
          locationCode: line.tax.locationCode ?? null,
        }),
        JSON.stringify(decision.components),
        JSON.stringify({ method: decision.rounding, lineNumber: line.lineNumber }),
        JSON.stringify({
          sourceAccountCombinationId: line.accountCombinationId,
          taxAccountCombinationId: snapshot.taxAccountCombinationId,
        }),
        line.taxDecisionHash,
        BASELINE_TIMESTAMP,
      ],
    );
    taxSnapshotIds.set(line.lineNumber, taxSnapshotId);
  }

  const subledgerEventId = fixtureId(identity, `subledger-event:${fixture.fixtureKey}:issued`);
  await client.query(
    `INSERT INTO subledger_events (
       id, organization_id, ledger_id, party_account_id,
       source_document_id, event_type, event_version, event_at
     ) VALUES ($1, $2, $3, $4, $5, $6, '2', $7)`,
    [
      subledgerEventId,
      identity.organizationId,
      foundation.ledgerId,
      partyAccountId,
      postedSourceId,
      snapshot.kind === "SALES_INVOICE" ? "SALES_INVOICE_ISSUED" : "SUPPLIER_BILL_ISSUED",
      BASELINE_TIMESTAMP,
    ],
  );

  await client.query(
    `INSERT INTO open_items (
       id, organization_id, ledger_id, party_account_id, source_event_id,
       status, transaction_currency, original_transaction_amount,
       open_transaction_amount, original_functional_amount,
       carrying_functional_amount, due_on, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $7, $8, $8, $9, $10)`,
    [
      fixtureId(identity, `open-item:${fixture.fixtureKey}`),
      identity.organizationId,
      foundation.ledgerId,
      partyAccountId,
      subledgerEventId,
      snapshot.currency,
      snapshot.grossTotal,
      snapshot.grossFunctional,
      snapshot.dueOn,
      BASELINE_TIMESTAMP,
    ],
  );

  const journalTypeKey = snapshot.sourceType;
  const journalType = await client.query<{ id: string; version: number }>(
    `SELECT id, version FROM journal_type_definitions
     WHERE key = $1 AND owner_module = $2
     ORDER BY version DESC LIMIT 1`,
    [journalTypeKey, snapshot.ownerModule],
  );
  const selectedJournalType = journalType.rows[0];
  if (!selectedJournalType) {
    throw new Error(`Journal type is missing for ${fixture.fixtureKey}`);
  }
  const journalId = fixtureId(identity, `journal:${fixture.fixtureKey}:issued`);
  const sourceEventKey = `${snapshot.sourceType}:${postedSourceId}:issued`;
  await client.query(
    `INSERT INTO journal_entries (
       id, organization_id, ledger_id, legal_entity_id, period_id,
       journal_type_key, journal_type_definition_id, journal_type_version,
       source_document_id, source_event_key, idempotency_key, command_hash,
       origin, purpose, status, accounting_date, functional_currency,
       description, created_by, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, 'SYSTEM', 'ROUTINE', 'DRAFT', $13, $14,
       $15, $16, $17
     )`,
    [
      journalId,
      identity.organizationId,
      foundation.ledgerId,
      foundation.legalEntityId,
      periodId,
      journalTypeKey,
      selectedJournalType.id,
      selectedJournalType.version,
      postedSourceId,
      sourceEventKey,
      issueIdempotencyKey,
      issueCommandHash,
      snapshot.accountingDate,
      snapshot.functionalCurrency,
      snapshot.description,
      identity.userId,
      BASELINE_TIMESTAMP,
    ],
  );

  const journalLines = buildIssueJournalLines(snapshot, subledgerEventId, taxSnapshotIds);
  for (const [index, line] of journalLines.entries()) {
    await client.query(
      `INSERT INTO journal_lines (
         id, organization_id, ledger_id, journal_entry_id, line_number,
         account_combination_id, debit_functional, credit_functional,
         transaction_currency, debit_transaction, credit_transaction,
         fx_rate, fx_rate_source, fx_rate_effective_at,
         party_account_id, subledger_event_id, tax_snapshot_id, memo
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        fixtureId(identity, `journal-line:${fixture.fixtureKey}:issued:${index + 1}`),
        identity.organizationId,
        foundation.ledgerId,
        journalId,
        index + 1,
        line.accountCombinationId,
        line.debitFunctional,
        line.creditFunctional,
        line.transactionCurrency,
        line.debitTransaction,
        line.creditTransaction,
        line.fxRate,
        line.fxRateSource,
        line.fxRateEffectiveAt,
        line.partyAccountId ?? null,
        line.subledgerEventId ?? null,
        line.taxSnapshotId ?? null,
        line.memo,
      ],
    );
  }

  return {
    fixtureKey: fixture.fixtureKey,
    journalId,
    ownerModule: snapshot.ownerModule,
    journalTypeKey,
  };
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
): Promise<string> {
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
       AND period.fiscal_year = $3 AND period.period_number = $4`,
    [identity.organizationId, input.foundation.ledgerId, DEMO_FISCAL_YEAR, DEMO_CURRENT_PERIOD],
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
         $8, $8, $9, 'USER', 'ROUTINE', 'DRAFT', $10, $11, $12, $13, $14
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
        DEMO_CALENDAR.accountingDate,
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
  return journalId;
}

function encryptDemoBankField(input: Readonly<{
  plaintext: string;
  organizationId: string;
  table: string;
  column: string;
  recordId: string;
  keyVersion: number;
  dek: Buffer;
}>): string {
  return serializeEncryptedField(encryptField(input.plaintext, input.dek, {
    organizationId: input.organizationId,
    table: input.table,
    column: input.column,
    recordId: input.recordId,
    keyVersion: input.keyVersion,
  }));
}

async function seedDemoBankingData(
  client: PoolClient,
  identity: SeedIdentity,
  foundations: ReadonlyMap<string, SeededFoundation>,
): Promise<void> {
  const ca = foundations.get("CA01");
  const us = foundations.get("US01");
  const usCashCombinationId = us?.combinationIds.get("1000");
  if (!ca || !us || !usCashCombinationId) throw new Error("Demo banking foundation is incomplete");

  await client.query("SELECT set_config('app.organization_id', $1, true)", [identity.organizationId]);
  await client.query("SELECT set_config('app.actor_id', $1, true)", [identity.userId]);
  await client.query("SELECT set_config('app.session_id', '', true)");
  await client.query("SELECT set_config('app.session_mode', 'real', true)");
  await client.query("SELECT set_config('app.request_id', $1, true)", [`demo-baseline-v${DEMO_BASELINE_VERSION}:banking`]);
  await client.query("SELECT set_config('app.auth_method', 'DEMO_BASELINE', true)");
  await client.query("SELECT set_config('app.source_surface', 'WORKER', true)");
  await client.query("SELECT set_config('app.reason', 'Restore synthetic banking evidence', true)");

  const key = await loadActiveOrganizationKey(client, identity.organizationId);
  try {
    const connectionId = fixtureId(identity, "bank-connection:synthetic-simplefin");
    const credentialCiphertext = encryptDemoBankField({
      plaintext: JSON.stringify({ synthetic: true, outboundProviderCallsAllowed: false }),
      organizationId: identity.organizationId,
      table: "bank_connections",
      column: "credentials_ciphertext",
      recordId: connectionId,
      keyVersion: key.keyVersion,
      dek: key.dek,
    });
    const connectionIdempotency = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:bank-connection`;
    const connectionCommandHash = createHash("sha256").update(connectionIdempotency).digest("hex");
    await client.query(
      `INSERT INTO bank_connections(
         id, organization_id, provider, display_name, credentials_ciphertext,
         credentials_key_version, status, idempotency_key, command_hash,
         last_synced_at, created_by, created_at, updated_at
      ) VALUES ($1,$2,'SIMPLEFIN','Synthetic nightly-reset feed',$3,$4,'DISABLED',$5,$6,$7,$8,$7,$7)`,
      [connectionId, identity.organizationId, credentialCiphertext, key.keyVersion,
        connectionIdempotency, connectionCommandHash,
        BASELINE_TIMESTAMP, identity.userId],
    );
    await client.query(
      `INSERT INTO bank_connection_credential_events(
         id, organization_id, connection_id, credential_version, event_type,
         credential_ciphertext_hash, credential_key_version, idempotency_key,
         command_hash, created_by, created_at
       ) VALUES ($1,$2,$3,1,'CREATED',$4,$5,$6,$7,$8,$9)`,
      [fixtureId(identity, "bank-connection-credential-event:synthetic-simplefin"),
        identity.organizationId, connectionId,
        createHash("sha256").update(credentialCiphertext).digest("hex"), key.keyVersion,
        connectionIdempotency, connectionCommandHash, identity.userId, BASELINE_TIMESTAMP],
    );

    const syncRunId = fixtureId(identity, "bank-sync:synthetic-baseline");
    const transactionDate = DEMO_CALENDAR.accountingDate;
    const earlierDate = demoDateOffset(transactionDate, -3);
    await client.query(
      `INSERT INTO bank_sync_runs(
         id, organization_id, connection_id, status, requested_start_on,
         requested_end_on, account_count, observation_count, version_count,
         provider_warning_count, created_by, started_at, credential_version
       ) VALUES ($1,$2,$3,'RUNNING',$4,$5,0,0,0,0,$6,$7,1)`,
      [syncRunId, identity.organizationId, connectionId, earlierDate, transactionDate,
        identity.userId, BASELINE_TIMESTAMP],
    );

    const accounts = [
      {
        key: "us-operating",
        providerId: "demo-us-operating-001",
        displayName: "USA Operating · 0042",
        currency: "USD",
        foundation: us,
        mapped: true,
        balance: "47600.000000000",
        availableBalance: "47100.000000000",
      },
      {
        key: "ca-reserve",
        providerId: "demo-ca-reserve-009",
        displayName: "Canada Reserve · 0917",
        currency: "CAD",
        foundation: ca,
        mapped: false,
        balance: "18750.000000000",
        availableBalance: "18750.000000000",
      },
    ] as const;
    const accountIds = new Map<string, string>();
    for (const account of accounts) {
      const accountId = fixtureId(identity, `bank-account:${account.key}`);
      accountIds.set(account.key, accountId);
      const providerHash = createBlindIndex(account.providerId, key.dek, identity.organizationId, "bank.provider-account-id.SIMPLEFIN");
      const providerCiphertext = encryptDemoBankField({
        plaintext: account.providerId, organizationId: identity.organizationId,
        table: "bank_external_accounts", column: "provider_account_id_ciphertext",
        recordId: accountId, keyVersion: key.keyVersion, dek: key.dek,
      });
      const displayCiphertext = encryptDemoBankField({
        plaintext: account.displayName, organizationId: identity.organizationId,
        table: "bank_external_accounts", column: "display_name_ciphertext",
        recordId: accountId, keyVersion: key.keyVersion, dek: key.dek,
      });
      await client.query(
        `INSERT INTO bank_external_accounts(
           id, organization_id, connection_id, provider_account_id_hash,
           provider_account_id_ciphertext, display_name_ciphertext, key_version,
           currency_code, legal_entity_id, ledger_id, cash_account_combination_id,
           active, last_reported_balance, last_balance_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$13,$13)`,
        [accountId, identity.organizationId, connectionId, providerHash,
          providerCiphertext, displayCiphertext, key.keyVersion, account.currency,
          account.mapped ? account.foundation.legalEntityId : null,
          account.mapped ? account.foundation.ledgerId : null,
          account.mapped ? usCashCombinationId : null,
          account.balance, BASELINE_TIMESTAMP],
      );
      await client.query(
        `INSERT INTO bank_balance_anchors(
           id, organization_id, external_account_id, sync_run_id, balance,
           available_balance, currency_code, balance_at, observed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [fixtureId(identity, `bank-balance:${account.key}`), identity.organizationId,
          accountId, syncRunId, account.balance, account.availableBalance,
          account.currency, BASELINE_TIMESTAMP],
      );
    }

    const observations = [
      {
        key: "us-prepaid",
        accountKey: "us-operating",
        providerId: "demo-bank-txn-us-prepaid-001",
        date: transactionDate,
        amount: "-2400.000000000",
        currency: "USD",
        details: { payee: "Workspace Services", description: "Prepaid workspace expense", memo: "Matches the posted US prepaid cash line" },
      },
      {
        key: "us-client-receipt",
        accountKey: "us-operating",
        providerId: "demo-bank-txn-us-receipt-002",
        date: earlierDate,
        amount: "975.000000000",
        currency: "USD",
        details: { payee: "Rainier Creative Studio", description: "Client receipt", memo: "Outside the seeded statement-day reconciliation" },
      },
      {
        key: "ca-bank-fee",
        accountKey: "ca-reserve",
        providerId: "demo-bank-txn-ca-fee-003",
        date: earlierDate,
        amount: "-38.550000000",
        currency: "CAD",
        details: { payee: "Northstar Bank", description: "Monthly account fee", memo: "Unmapped account demonstration" },
      },
    ] as const;
    const versionIds = new Map<string, string>();
    for (const observation of observations) {
      const accountId = accountIds.get(observation.accountKey);
      if (!accountId) throw new Error("Demo bank observation account is missing");
      const observationId = fixtureId(identity, `bank-observation:${observation.key}`);
      const versionId = fixtureId(identity, `bank-observation-version:${observation.key}:1`);
      versionIds.set(observation.key, versionId);
      const providerHash = createBlindIndex(observation.providerId, key.dek, identity.organizationId, `bank.transaction-id.${accountId}`);
      const providerCiphertext = encryptDemoBankField({
        plaintext: observation.providerId, organizationId: identity.organizationId,
        table: "bank_observations", column: "provider_transaction_id_ciphertext",
        recordId: observationId, keyVersion: key.keyVersion, dek: key.dek,
      });
      await client.query(
        `INSERT INTO bank_observations(
           id, organization_id, external_account_id, provider_transaction_id_hash,
           provider_transaction_id_ciphertext, key_version, first_seen_run_id, first_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [observationId, identity.organizationId, accountId, providerHash,
          providerCiphertext, key.keyVersion, syncRunId, BASELINE_TIMESTAMP],
      );
      const detailsText = JSON.stringify(observation.details);
      const canonicalContent = JSON.stringify({
        status: "POSTED", postedOn: observation.date, transactedAt: null,
        amount: observation.amount, currencyCode: observation.currency,
        details: observation.details,
      });
      const detailsCiphertext = encryptDemoBankField({
        plaintext: detailsText, organizationId: identity.organizationId,
        table: "bank_observation_versions", column: "details_ciphertext",
        recordId: versionId, keyVersion: key.keyVersion, dek: key.dek,
      });
      await client.query(
        `INSERT INTO bank_observation_versions(
           id, organization_id, observation_id, sync_run_id, version_number,
           content_hash, status, posted_on, amount, currency_code,
           details_ciphertext, key_version, observed_at
         ) VALUES ($1,$2,$3,$4,1,$5,'POSTED',$6,$7,$8,$9,$10,$11)`,
        [versionId, identity.organizationId, observationId, syncRunId,
          createBlindIndex(canonicalContent, key.dek, identity.organizationId, "bank.observation-content"),
          observation.date, observation.amount, observation.currency,
          detailsCiphertext, key.keyVersion, BASELINE_TIMESTAMP],
      );
    }

    const reconciliationId = fixtureId(identity, "bank-reconciliation:us-prepaid-day");
    const reconciliationIdempotency = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:bank-reconciliation`;
    await client.query(
      `INSERT INTO bank_reconciliation_sessions(
         id, organization_id, external_account_id, legal_entity_id, ledger_id,
         cash_account_combination_id, statement_start_on, statement_end_on,
         opening_balance, closing_balance, currency_code, status, version,
         idempotency_key, command_hash, created_by, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'50000.000000000','47600.000000000',
         'USD','DRAFT',1,$8,$9,$10,$11)`,
      [reconciliationId, identity.organizationId, accountIds.get("us-operating"),
        us.legalEntityId, us.ledgerId, usCashCombinationId, transactionDate,
        reconciliationIdempotency, createHash("sha256").update(reconciliationIdempotency).digest("hex"),
        identity.userId, BASELINE_TIMESTAMP],
    );

    const ruleId = fixtureId(identity, "bank-rule:fees:1");
    const condition = JSON.stringify({ descriptionContains: "fee", direction: "OUTFLOW" });
    const action = JSON.stringify({ kind: "MANUAL_REVIEW", memo: "Review bank fees and select an expense account" });
    const ruleIdempotency = `demo-baseline-v${DEMO_BASELINE_VERSION}:${identity.organizationId}:bank-rule-fees`;
    await client.query(
      `INSERT INTO bank_rules(
         id, organization_id, name, priority, state, condition_ciphertext,
         action_ciphertext, key_version, version, supersedes_rule_id,
         idempotency_key, command_hash, created_by, created_at
       ) VALUES ($1,$2,'Review bank fees',10,'ACTIVE',$3,$4,$5,1,NULL,$6,$7,$8,$9)`,
      [ruleId, identity.organizationId,
        encryptDemoBankField({ plaintext: condition, organizationId: identity.organizationId,
          table: "bank_rules", column: "condition_ciphertext", recordId: ruleId,
          keyVersion: key.keyVersion, dek: key.dek }),
        encryptDemoBankField({ plaintext: action, organizationId: identity.organizationId,
          table: "bank_rules", column: "action_ciphertext", recordId: ruleId,
          keyVersion: key.keyVersion, dek: key.dek }),
        key.keyVersion, ruleIdempotency,
        createHash("sha256").update(ruleIdempotency).digest("hex"), identity.userId,
        BASELINE_TIMESTAMP],
    );
    const feeVersionId = versionIds.get("ca-bank-fee");
    if (!feeVersionId) throw new Error("Demo bank fee observation version is missing");
    await client.query(
      `INSERT INTO bank_rule_runs(
         id, organization_id, sync_run_id, observation_version_id, rule_id, matched, evaluated_at
       ) VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [fixtureId(identity, "bank-rule-run:fees"), identity.organizationId,
        syncRunId, feeVersionId, ruleId, BASELINE_TIMESTAMP],
    );
    const proposalId = fixtureId(identity, "bank-proposal:fees");
    const proposalPayload = JSON.stringify({
      action: JSON.parse(action),
      source: { externalAccountId: accountIds.get("ca-reserve"), observationVersionId: feeVersionId },
    });
    await client.query(
      `INSERT INTO bank_draft_proposals(
         id, organization_id, observation_version_id, rule_id, kind,
         payload_ciphertext, payload_hash, key_version, created_at
       ) VALUES ($1,$2,$3,$4,'MANUAL_REVIEW',$5,$6,$7,$8)`,
      [proposalId, identity.organizationId, feeVersionId, ruleId,
        encryptDemoBankField({ plaintext: proposalPayload, organizationId: identity.organizationId,
          table: "bank_draft_proposals", column: "payload_ciphertext", recordId: proposalId,
          keyVersion: key.keyVersion, dek: key.dek }),
        createBlindIndex(proposalPayload, key.dek, identity.organizationId, "bank.proposal-payload"),
        key.keyVersion, BASELINE_TIMESTAMP],
    );
    await client.query(
      `UPDATE bank_sync_runs SET
         status = 'SUCCEEDED', account_count = 2, observation_count = 3,
         version_count = 3, provider_warning_count = 0, completed_at = $3
       WHERE organization_id = $1 AND id = $2 AND status = 'RUNNING'`,
      [identity.organizationId, syncRunId, BASELINE_TIMESTAMP],
    );
  } finally {
    key.dek.fill(0);
  }
}

async function clearDemoSeedApplicationContext(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.organization_id', '', true),
       set_config('app.actor_id', '', true),
       set_config('app.session_id', '', true),
       set_config('app.session_mode', '', true),
       set_config('app.request_id', '', true),
       set_config('app.auth_method', '', true),
       set_config('app.source_surface', '', true),
       set_config('app.reason', '', true),
       set_config('app.demo_write_authorized', 'false', true)`,
  );
}

async function seedOrganizationBaseline(
  client: PoolClient,
  identity: SeedIdentity,
): Promise<readonly SeededJournalToPost[]> {
  await ensureOperatorOrganizationKey(client, identity.organizationId);
  const foundations = new Map<string, SeededFoundation>();
  for (const foundation of FOUNDATIONS) {
    foundations.set(foundation.entityCode, await seedLedgerFoundation(client, identity, foundation));
  }
  await seedSegmentDefinitions(client, identity);
  await seedPublishedAccountHierarchies(client, identity, foundations);
  const partyData = await seedEncryptedPartyData(client, identity, foundations);

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
  const usPrepaidJournalId = await seedDraftJournal(client, identity, {
    fixtureKey: "us-prepaid-expense",
    publicId: "10000000-0000-4000-8000-000000000202",
    entityCode: "US01",
    foundation: us,
    description: "Synthetic US prepaid expense entry",
    debitAccount: "1400",
    creditAccount: "1000",
    amount: "2400.00",
  });
  // The fixed PUBLIC_DEMO organization is an operator-owned, draft-only
  // template and is intentionally never handed to a visitor. Synthetic bank
  // evidence belongs only in the isolated SANDBOX organizations that are
  // purged and reconstructed by the nightly reset. Keeping the public template
  // bank-free also makes ordinary additive bootstrap safe to repeat without
  // weakening the append-only banking tables with conflict updates.
  if (!identity.publicTemplate) {
    await seedDemoBankingData(client, identity, foundations);
    // Banking inserts exercise the ordinary permission guards and therefore
    // install a transaction-local actor context. Clear it before the remaining
    // database-owner fixture inserts so they are not misclassified as live
    // demo-session mutations.
    await clearDemoSeedApplicationContext(client);
  }

  const journalsToPost: SeededJournalToPost[] = [];
  if (!identity.publicTemplate) {
    for (const fixture of DEMO_ISSUED_DOCUMENTS) {
      journalsToPost.push(
        await seedIssuedDemoDocument(client, identity, foundations, partyData, fixture),
      );
    }
    journalsToPost.push({
      fixtureKey: "us-prepaid-expense",
      journalId: usPrepaidJournalId,
      ownerModule: "ledger",
      journalTypeKey: "ledger.manual",
    });
  }
  if (identity.publicTemplate && journalsToPost.length !== 0) {
    throw new Error("The fixed public demo template must remain draft-only");
  }
  return journalsToPost;
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
  mode: DemoSandboxResetMode,
): Promise<readonly SandboxCandidate[]> {
  const result = await client.query<SandboxCandidate>(
    `SELECT slot.slot, slot.organization_id, slot.baseline_version
     FROM demo_sandbox_slots slot
     WHERE $1::boolean
       OR slot.state IN ('DIRTY', 'RESETTING')
       OR (slot.state = 'READY' AND slot.baseline_version < $2)
     ORDER BY slot.slot`,
    [mode === "nightly", DEMO_BASELINE_VERSION],
  );
  return result.rows;
}

async function resolveDemoSandboxResetMode(
  client: PoolClient,
  requestedMode: DemoSandboxResetMode,
): Promise<DemoSandboxResetMode> {
  if (requestedMode === "nightly") return requestedMode;

  const schedule = await client.query<{ overdue: boolean }>(
    `SELECT reset_after <= statement_timestamp() AS overdue
     FROM demo_sandbox_pool
     WHERE singleton
     FOR SHARE`,
  );
  if (!schedule.rows[0]) throw new Error("Demo sandbox pool state is missing");
  return schedule.rows[0].overdue ? "nightly" : requestedMode;
}

async function claimSandboxForReset(
  client: PoolClient,
  candidate: SandboxCandidate,
  mode: DemoSandboxResetMode,
): Promise<SandboxSlot | null> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '45s'");

    // Tenant transactions lock their live auth row, daily claim, and slot in
    // this order. The nightly reset takes the same locks exclusively before
    // invalidating access; bootstrap may claim only never-assigned dirty slots.
    await client.query(
      `SELECT id FROM auth_sessions
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL
       ORDER BY id
       FOR UPDATE`,
      [candidate.organization_id],
    );
    await client.query(
      `SELECT id FROM demo_daily_claims
       WHERE organization_id = $1 AND invalidated_at IS NULL
       ORDER BY id
       FOR UPDATE`,
      [candidate.organization_id],
    );
    const selected = await client.query<{ state: string; baseline_version: number }>(
      `SELECT slot.state, slot.baseline_version
       FROM demo_sandbox_slots slot
       WHERE slot.slot = $1 AND slot.organization_id = $2
       FOR UPDATE OF slot`,
      [candidate.slot, candidate.organization_id],
    );
    const slot = selected.rows[0];
    const eligible = mode === "nightly" || slot?.state === "DIRTY" || slot?.state === "RESETTING" || (
      slot?.state === "READY" && slot.baseline_version < DEMO_BASELINE_VERSION
    );
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
      `UPDATE demo_daily_claims
       SET invalidated_at = coalesce(invalidated_at, now())
       WHERE organization_id = $1 AND invalidated_at IS NULL`,
      [candidate.organization_id],
    );
    await client.query(
      `UPDATE demo_sandbox_slots
       SET state = 'RESETTING'
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

export async function registeredDemoSandboxResetTables(client: PoolClient): Promise<readonly string[]> {
  const result = await client.query<{ table_name: string; valid: boolean }>(
    `SELECT registry.table_name,
       class.oid IS NOT NULL AND attribute.attname IS NOT NULL AS valid
     FROM demo_sandbox_reset_tables registry
     LEFT JOIN pg_class class
       ON class.relnamespace = 'public'::regnamespace
      AND class.relname = registry.table_name
      AND class.relkind IN ('r', 'p')
     LEFT JOIN pg_attribute attribute
       ON attribute.attrelid = class.oid
      AND attribute.attname = 'organization_id'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
     ORDER BY registry.purge_order`,
  );
  if (result.rows.length === 0 || result.rows.some((row) => !row.valid || !SAFE_RESET_TABLE_NAME.test(row.table_name))) {
    throw new Error("Demo sandbox reset registry contains an invalid organization-owned table");
  }
  return result.rows.map((row) => row.table_name);
}

async function purgeSandboxBusinessData(client: PoolClient, organizationId: string): Promise<void> {
  const resetTables = await registeredDemoSandboxResetTables(client);
  await client.query("SET LOCAL session_replication_role = replica");
  try {
    for (const table of resetTables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      await client.query(`DELETE FROM ${quotedTable} WHERE organization_id = $1`, [organizationId]);
    }
  } finally {
    await client.query("SET LOCAL session_replication_role = origin");
  }
}

async function verifySandboxBaseline(client: PoolClient, organizationId: string): Promise<void> {
  const sealedPeriodsPerLedger = Math.max(DEMO_CURRENT_PERIOD - 2, 0);
  const hardClosedPeriodsPerLedger = DEMO_CURRENT_PERIOD > 1 ? 1 : 0;
  const openPeriodsPerLedger = 12 - sealedPeriodsPerLedger - hardClosedPeriodsPerLedger;
  const result = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM legal_entities WHERE organization_id = $1)::text AS entities,
       (SELECT count(*) FROM ledgers WHERE organization_id = $1)::text AS ledgers,
       (SELECT count(*) FROM fiscal_periods WHERE organization_id = $1)::text AS periods,
       (SELECT count(*) FROM fiscal_periods
          WHERE organization_id = $1 AND state = 'SEALED')::text AS sealed_periods,
       (SELECT count(*) FROM fiscal_periods
          WHERE organization_id = $1 AND state = 'HARD_CLOSED')::text AS hard_closed_periods,
       (SELECT count(*) FROM fiscal_periods
          WHERE organization_id = $1 AND state = 'OPEN')::text AS open_periods,
       (SELECT count(*) FROM gl_accounts WHERE organization_id = $1)::text AS accounts,
       (SELECT count(*) FROM account_combinations WHERE organization_id = $1)::text AS combinations,
       (SELECT count(*) FROM segment_definitions WHERE organization_id = $1)::text AS segments,
       (SELECT count(*) FROM accounting_hierarchies
          WHERE organization_id = $1 AND status = 'PUBLISHED')::text AS published_hierarchies,
       (SELECT count(*) FROM accounting_hierarchy_nodes
          WHERE organization_id = $1)::text AS hierarchy_nodes,
       (SELECT count(*) FROM parties WHERE organization_id = $1)::text AS parties,
       (SELECT count(*) FROM party_addresses WHERE organization_id = $1)::text AS addresses,
       (SELECT count(*) FROM party_accounts WHERE organization_id = $1)::text AS party_accounts,
       (SELECT count(*) FROM party_accounts
          WHERE organization_id = $1 AND transaction_currency IS NOT NULL)::text
         AS currency_restricted_party_accounts,
       (SELECT count(*) FROM entity_tax_registrations WHERE organization_id = $1)::text AS registrations,
       (SELECT count(*) FROM ledger_posting_policies WHERE organization_id = $1)::text AS posting_policies,
       (SELECT count(*) FROM journal_entries WHERE organization_id = $1)::text AS journals,
       (SELECT count(*) FROM journal_entries
          WHERE organization_id = $1 AND status = 'POSTED')::text AS posted_journals,
       (SELECT count(*) FROM journal_entries
          WHERE organization_id = $1 AND status = 'DRAFT')::text AS draft_journals,
       (SELECT count(*) FROM journal_lines WHERE organization_id = $1)::text AS lines,
       (SELECT count(*) FROM source_documents WHERE organization_id = $1)::text AS source_documents,
       (SELECT count(*) FROM source_documents
          WHERE organization_id = $1 AND status = 'DRAFT' AND version = 1)::text AS draft_sources,
       (SELECT count(*) FROM source_documents
          WHERE organization_id = $1 AND status = 'POSTED' AND version = 2)::text AS posted_sources,
       (SELECT count(*) FROM tax_determination_snapshots
          WHERE organization_id = $1)::text AS tax_snapshots,
       (SELECT count(*) FROM tax_determination_snapshots
          WHERE organization_id = $1 AND status = 'APPLIED')::text AS applied_tax_snapshots,
       (SELECT count(*) FROM subledger_events WHERE organization_id = $1)::text AS subledger_events,
       (SELECT count(*) FROM open_items WHERE organization_id = $1)::text AS open_items,
       (SELECT count(*) FROM open_item_void_events WHERE organization_id = $1)::text AS open_item_void_events,
       (SELECT count(*) FROM document_settlement_allocations WHERE organization_id = $1)::text AS allocations,
       (SELECT count(*) FROM journal_entry_relations WHERE organization_id = $1)::text AS journal_relations,
       (SELECT count(*) FROM ledger_number_sequences WHERE organization_id = $1)::text AS number_sequences,
       (SELECT count(*) FROM audit_events WHERE organization_id = $1)::text AS audit_events,
       (SELECT count(*) FROM outbox_events WHERE organization_id = $1)::text AS outbox_events,
       (SELECT count(*) FROM bank_connections WHERE organization_id = $1)::text AS bank_connections,
       (SELECT count(*) FROM bank_connection_credential_events WHERE organization_id = $1)::text AS bank_credential_events,
       (SELECT count(*) FROM bank_external_accounts WHERE organization_id = $1)::text AS bank_accounts,
       (SELECT count(*) FROM bank_sync_runs WHERE organization_id = $1)::text AS bank_sync_runs,
       (SELECT count(*) FROM bank_observations WHERE organization_id = $1)::text AS bank_observations,
       (SELECT count(*) FROM bank_observation_versions WHERE organization_id = $1)::text AS bank_observation_versions,
       (SELECT count(*) FROM bank_balance_anchors WHERE organization_id = $1)::text AS bank_balance_anchors,
       (SELECT count(*) FROM bank_reconciliation_sessions WHERE organization_id = $1)::text AS bank_reconciliations,
       (SELECT count(*) FROM bank_reconciliation_voids WHERE organization_id = $1)::text AS bank_reconciliation_voids,
       (SELECT count(*) FROM bank_rules WHERE organization_id = $1)::text AS bank_rules,
       (SELECT count(*) FROM bank_draft_proposals WHERE organization_id = $1)::text AS bank_proposals`,
    [organizationId],
  );
  const counts = result.rows[0];
  const expected: Readonly<Record<string, string>> = {
    entities: "2",
    ledgers: "2",
    periods: "24",
    sealed_periods: String(sealedPeriodsPerLedger * 2),
    hard_closed_periods: String(hardClosedPeriodsPerLedger * 2),
    open_periods: String(openPeriodsPerLedger * 2),
    accounts: "26",
    combinations: "26",
    segments: "10",
    published_hierarchies: "2",
    hierarchy_nodes: "50",
    parties: "4",
    addresses: "4",
    party_accounts: "4",
    currency_restricted_party_accounts: "0",
    registrations: "2",
    posting_policies: "2",
    journals: "6",
    posted_journals: "5",
    draft_journals: "1",
    lines: "16",
    source_documents: "8",
    draft_sources: "4",
    posted_sources: "4",
    tax_snapshots: "4",
    applied_tax_snapshots: "4",
    subledger_events: "4",
    open_items: "4",
    open_item_void_events: "0",
    allocations: "0",
    journal_relations: "0",
    number_sequences: "2",
    audit_events: "9",
    outbox_events: "5",
    bank_connections: "1",
    bank_credential_events: "1",
    bank_accounts: "2",
    bank_sync_runs: "1",
    bank_observations: "3",
    bank_observation_versions: "3",
    bank_balance_anchors: "2",
    bank_reconciliations: "1",
    bank_reconciliation_voids: "0",
    bank_rules: "1",
    bank_proposals: "1",
  };
  if (!counts || Object.entries(expected).some(([key, value]) => counts[key] !== value)) {
    throw new Error(`Demo sandbox baseline verification failed for ${organizationId}`);
  }

  const integrity = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM fiscal_periods period
          WHERE period.organization_id = $1 AND (
            period.state <> CASE
              WHEN period.period_number < $2 - 1 THEN 'SEALED'::period_state
              WHEN period.period_number = $2 - 1 THEN 'HARD_CLOSED'::period_state
              ELSE 'OPEN'::period_state
            END
            OR (period.state = 'OPEN' AND period.closed_at IS NOT NULL)
            OR (period.state <> 'OPEN' AND period.closed_at IS NULL)
          ))::text AS period_layout_errors,
       (SELECT count(DISTINCT (source_type, source_number))
          FROM source_documents WHERE organization_id = $1)::text AS logical_documents,
       (SELECT count(*) FROM source_documents posted
          WHERE posted.organization_id = $1
            AND posted.status = 'POSTED' AND posted.version = 2
            AND NOT EXISTS (
              SELECT 1 FROM source_documents draft
              WHERE draft.organization_id = posted.organization_id
                AND draft.id = posted.supersedes_source_document_id
                AND draft.source_type = posted.source_type
                AND draft.source_number = posted.source_number
                AND draft.status = 'DRAFT' AND draft.version = 1
            ))::text AS source_lineage_errors,
       (SELECT count(*) FROM journal_entries journal
          WHERE journal.organization_id = $1 AND journal.status = 'POSTED'
            AND (
              journal.journal_number IS NULL OR journal.content_hash IS NULL
              OR journal.content_hash !~ '^[0-9a-f]{64}$'
              OR journal.posted_by IS NULL OR journal.posted_at IS NULL
              OR journal.total_debit_functional <= 0
              OR journal.total_debit_functional <> journal.total_credit_functional
            ))::text AS posted_journal_errors,
       (SELECT count(*) FROM open_item_balances balance
          WHERE balance.organization_id = $1 AND (
            balance.derived_status <> 'OPEN'
            OR balance.open_transaction_amount <> balance.original_transaction_amount
            OR balance.carrying_functional_amount <> balance.original_functional_amount
          ))::text AS open_balance_errors,
       (SELECT count(*) FROM open_item_balances balance
          JOIN ledgers ledger
            ON ledger.organization_id = balance.organization_id
           AND ledger.id = balance.ledger_id
          WHERE balance.organization_id = $1
            AND balance.transaction_currency <> ledger.functional_currency)::text AS cross_currency_items,
       (SELECT count(*) FROM audit_events
          WHERE organization_id = $1 AND action = 'journal.posted')::text AS posting_audits,
       (SELECT count(*) FROM outbox_events
          WHERE organization_id = $1 AND topic = 'ledger.journal-posted')::text AS posting_outbox_events`,
    [organizationId, DEMO_CURRENT_PERIOD],
  );
  const integrityExpected: Readonly<Record<string, string>> = {
    period_layout_errors: "0",
    logical_documents: "4",
    source_lineage_errors: "0",
    posted_journal_errors: "0",
    open_balance_errors: "0",
    cross_currency_items: "2",
    posting_audits: "5",
    posting_outbox_events: "5",
  };
  const integrityResult = integrity.rows[0];
  if (
    !integrityResult ||
    Object.entries(integrityExpected).some(([key, value]) => integrityResult[key] !== value)
  ) {
    throw new Error(`Demo sandbox integrity verification failed for ${organizationId}`);
  }

  const journalTotals = await client.query<{
    source_number: string;
    line_count: number;
    debit: string;
    credit: string;
  }>(
    `SELECT source.source_number, count(line.id)::int AS line_count,
       round(journal.total_debit_functional, 2)::text AS debit,
       round(journal.total_credit_functional, 2)::text AS credit
     FROM journal_entries journal
     JOIN source_documents source
       ON source.organization_id = journal.organization_id
      AND source.id = journal.source_document_id
     JOIN journal_lines line
       ON line.organization_id = journal.organization_id
      AND line.journal_entry_id = journal.id
     WHERE journal.organization_id = $1 AND journal.status = 'POSTED'
     GROUP BY journal.id, source.source_number,
       journal.total_debit_functional, journal.total_credit_functional
     ORDER BY source.source_number`,
    [organizationId],
  );
  const expectedJournalTotals = [
    { source_number: "BILL-CA-FX-3001", line_count: 3, debit: "4542.60", credit: "4542.60" },
    { source_number: "BILL-US-FX-4001", line_count: 3, debit: "3272.28", credit: "3272.28" },
    { source_number: "INV-CA-1001", line_count: 3, debit: "11300.00", credit: "11300.00" },
    { source_number: "INV-US-2001", line_count: 3, debit: "15477.00", credit: "15477.00" },
  ];
  if (JSON.stringify(journalTotals.rows) !== JSON.stringify(expectedJournalTotals)) {
    throw new Error(`Demo sandbox journal totals verification failed for ${organizationId}`);
  }

  const openBalances = await client.query<{
    source_number: string;
    transaction_currency: string;
    open_transaction_amount: string;
    carrying_functional_amount: string;
  }>(
    `SELECT source.source_number, balance.transaction_currency,
       round(balance.open_transaction_amount, 2)::text AS open_transaction_amount,
       round(balance.carrying_functional_amount, 2)::text AS carrying_functional_amount
     FROM open_item_balances balance
     JOIN subledger_events event
       ON event.organization_id = balance.organization_id
      AND event.id = balance.source_event_id
     JOIN source_documents source
       ON source.organization_id = event.organization_id
      AND source.id = event.source_document_id
     WHERE balance.organization_id = $1
     ORDER BY source.source_number`,
    [organizationId],
  );
  const expectedOpenBalances = [
    {
      source_number: "BILL-CA-FX-3001",
      transaction_currency: "USD",
      open_transaction_amount: "3390.00",
      carrying_functional_amount: "4542.60",
    },
    {
      source_number: "BILL-US-FX-4001",
      transaction_currency: "CAD",
      open_transaction_amount: "4000.00",
      carrying_functional_amount: "2960.00",
    },
    {
      source_number: "INV-CA-1001",
      transaction_currency: "CAD",
      open_transaction_amount: "11300.00",
      carrying_functional_amount: "11300.00",
    },
    {
      source_number: "INV-US-2001",
      transaction_currency: "USD",
      open_transaction_amount: "15477.00",
      carrying_functional_amount: "15477.00",
    },
  ];
  if (JSON.stringify(openBalances.rows) !== JSON.stringify(expectedOpenBalances)) {
    throw new Error(`Demo sandbox open-balance verification failed for ${organizationId}`);
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
      `SELECT id FROM demo_daily_claims
       WHERE organization_id = $1 AND invalidated_at IS NULL
       ORDER BY id FOR UPDATE`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE demo_daily_claims SET invalidated_at = coalesce(invalidated_at, now())
       WHERE organization_id = $1 AND invalidated_at IS NULL`,
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
       SET state = 'QUARANTINED'
       WHERE slot = $1 AND organization_id = $2 AND state = 'RESETTING'`,
      [slot.slot, slot.organization_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function postSeededJournal(
  client: PoolClient,
  identity: SeedIdentity,
  journal: SeededJournalToPost,
): Promise<void> {
  const context: TenantTransactionContext = {
    organizationId: identity.organizationId,
    actorId: identity.userId,
    sessionMode: "real",
    requestId: `demo-baseline-v${DEMO_BASELINE_VERSION}:${journal.fixtureKey}:post`,
    authMethod: "DEMO_BASELINE",
    sourceSurface: "WORKER",
    reason: "Restore the deterministic nightly demo baseline",
  };

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '45s'");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
    await client.query("SELECT set_config('app.actor_id', $1, true)", [context.actorId]);
    await client.query("SELECT set_config('app.session_id', '', true)");
    await client.query("SELECT set_config('app.session_mode', 'real', true)");
    await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);
    await client.query("SELECT set_config('app.auth_method', $1, true)", [context.authMethod]);
    await client.query("SELECT set_config('app.source_surface', $1, true)", [context.sourceSurface]);
    await client.query("SELECT set_config('app.reason', $1, true)", [context.reason]);
    await client.query("SELECT set_config('app.demo_write_authorized', 'false', true)");
    const posted = await postJournalInTransaction(client, {
      context,
      journalId: journal.journalId,
      requiredOwnerModule: journal.ownerModule,
      requiredJournalType: journal.journalTypeKey,
    });
    if (posted.idempotentReplay || posted.status !== "POSTED") {
      throw new Error(`Demo fixture ${journal.fixtureKey} did not perform a fresh post`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function resetClaimedSandbox(client: PoolClient, slot: SandboxSlot): Promise<void> {
  if (!slot.user_id) {
    throw new Error(`Demo sandbox slot ${slot.slot} has no active demo accountant`);
  }
  const suffix = String(slot.slot).padStart(3, "0");
  const identity: SeedIdentity = {
    organizationId: slot.organization_id,
    userId: slot.user_id,
    slug: `northstar-sandbox-${suffix}`,
    organizationName: `Northstar Demo Sandbox ${suffix}`,
  };
  let journalsToPost: readonly SeededJournalToPost[] = [];

  // Purge and reconstruct all immutable source data as database-owner
  // fixtures, then commit before crossing the ordinary posting boundary.
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
      `SELECT id FROM demo_daily_claims
       WHERE organization_id = $1 AND invalidated_at IS NULL
       ORDER BY id FOR UPDATE`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE organization_id = $1 AND session_mode = 'DEMO' AND revoked_at IS NULL`,
      [slot.organization_id],
    );
    await client.query(
      `UPDATE demo_daily_claims SET invalidated_at = coalesce(invalidated_at, now())
       WHERE organization_id = $1 AND invalidated_at IS NULL`,
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

    await client.query(
      `UPDATE organizations SET
         slug = $2, display_name = $3, active = true,
         is_demo = true, organization_mode = 'SANDBOX'
       WHERE id = $1`,
      [slot.organization_id, `northstar-sandbox-${suffix}`, `Northstar Demo Sandbox ${suffix}`],
    );
    await purgeSandboxBusinessData(client, slot.organization_id);
    await client.query("SELECT app.reset_demo_sandbox_extensions($1, $2)", [slot.organization_id, slot.user_id]);
    journalsToPost = await seedOrganizationBaseline(client, identity);
    if (journalsToPost.length !== DEMO_ISSUED_DOCUMENTS.length + 1) {
      throw new Error(`Demo sandbox slot ${slot.slot} did not seed every issued fixture`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  // Each journal posts through the production permission, validation,
  // numbering, audit, and outbox controls. Separate transactions also keep
  // the append-only audit chain strictly ordered.
  for (const journal of journalsToPost) {
    await postSeededJournal(client, identity, journal);
  }

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '45s'");
    const selected = await client.query<{ organization_mode: string; state: string }>(
      `SELECT organization.organization_mode, sandbox.state
       FROM demo_sandbox_slots sandbox
       JOIN organizations organization ON organization.id = sandbox.organization_id
       WHERE sandbox.slot = $1 AND sandbox.organization_id = $2
       FOR UPDATE OF sandbox`,
      [slot.slot, slot.organization_id],
    );
    if (selected.rows[0]?.organization_mode !== "SANDBOX" || selected.rows[0]?.state !== "RESETTING") {
      throw new Error(`Demo sandbox slot ${slot.slot} lost its reset claim before verification`);
    }
    await verifySandboxBaseline(client, slot.organization_id);
    const released = await client.query(
      `UPDATE demo_sandbox_slots SET
         state = 'READY',
         generation = generation + 1,
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
  options: Readonly<{ mode: DemoSandboxResetMode }>,
): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await assertOperatorDatabaseOwner(client);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [RESET_ADVISORY_LOCK_KEY]);
    lockHeld = true;
    // A deploy can legitimately span the Toronto reset boundary while the
    // scheduler is paused. Promote that overdue bootstrap to the same complete
    // reconciliation used by the nightly job so browser acceptance never sees
    // healthy slots behind an expired pool cycle.
    const effectiveMode = await resolveDemoSandboxResetMode(client, options.mode);
    const candidates = await listSandboxCandidates(client, effectiveMode);
    const failures: string[] = [];
    for (const candidate of candidates) {
      const claimed = await claimSandboxForReset(client, candidate, effectiveMode);
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
    if (effectiveMode === "nightly") {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '45s'");
        await client.query("SELECT singleton FROM demo_sandbox_pool WHERE singleton FOR UPDATE");
        const completed = await client.query(
          `UPDATE demo_sandbox_pool SET
             cycle = cycle + 1,
             reset_after = app.next_demo_reset_after(statement_timestamp()),
             last_completed_reset_at = statement_timestamp()
           WHERE singleton
           RETURNING cycle`,
        );
        if (completed.rowCount !== 1) throw new Error("Demo sandbox pool state is missing");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
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
    const publicJournalsToPost = await seedOrganizationBaseline(client, {
      organizationId: DEMO_ORGANIZATION_ID,
      userId: DEMO_USER_ID,
      slug: "northstar-demo",
      organizationName: "Northstar Demo Group",
      publicTemplate: true,
    });
    if (publicJournalsToPost.length !== 0) {
      throw new Error("The fixed public demo template cannot contain posted baseline fixtures");
    }
    const publicTemplateInvariant = await client.query<{
      registrations: string;
      source_documents: string;
      posted_journals: string;
      bank_connections: string;
    }>(
      `SELECT
         (SELECT count(*) FROM entity_tax_registrations
            WHERE organization_id = $1)::text AS registrations,
         (SELECT count(*) FROM source_documents
            WHERE organization_id = $1)::text AS source_documents,
         (SELECT count(*) FROM journal_entries
            WHERE organization_id = $1 AND status = 'POSTED')::text AS posted_journals,
         (SELECT count(*) FROM bank_connections
            WHERE organization_id = $1)::text AS bank_connections`,
      [DEMO_ORGANIZATION_ID],
    );
    if (
      publicTemplateInvariant.rows[0]?.registrations !== "2" ||
      publicTemplateInvariant.rows[0]?.source_documents !== "0" ||
      publicTemplateInvariant.rows[0]?.posted_journals !== "0" ||
      publicTemplateInvariant.rows[0]?.bank_connections !== "0"
    ) {
      throw new Error("The fixed public demo template violated its draft-only, bank-free baseline invariant");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Ordinary deploys prepare additive DIRTY slots and unclaimed READY slots
  // whose baseline is obsolete. Assigned browser claims and their data survive
  // bootstrap, logout, and session expiry until the nightly boundary. If that
  // boundary passed while deployment schedulers were paused, bootstrap safely
  // completes the overdue nightly cycle before release acceptance.
  await resetDemoSandboxes(pool, { mode: "bootstrap" });
}
