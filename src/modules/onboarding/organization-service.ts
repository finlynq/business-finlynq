import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ROLE_TEMPLATES } from "@/modules/identity/permissions";
import {
  LocalRootKeyProvider,
  generateOrganizationDek,
  serializeWrappedKey,
} from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";

const onboardingSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  organizationName: z.string().trim().min(2).max(200),
  entityCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/),
  entityName: z.string().trim().min(2).max(200),
  countryCode: z.enum(["CA", "US"]),
  regionCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/),
  functionalCurrency: z.enum(["CAD", "USD"]),
  accountingProfile: z.enum(["CAN_ASPE", "US_GAAP_NONPUBLIC"]),
  fiscalYear: z.number().int().min(2000).max(2200),
});

export type OrganizationOnboardingInput = z.input<typeof onboardingSchema>;
export type OrganizationOnboardingResult = Readonly<{
  organizationId: string;
  legalEntityId: string;
  ledgerId: string;
  ownerRoleId: string;
  created: boolean;
}>;

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

function monthDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

async function ensureRoleTemplates(
  client: PoolClient,
  organizationId: string,
): Promise<Map<string, string>> {
  const roleIds = new Map<string, string>();
  for (const [key, permissions] of Object.entries(ROLE_TEMPLATES)) {
    const displayName = key.split("_").map((part) => part[0] + part.slice(1).toLowerCase()).join(" ");
    const role = await client.query<{ id: string }>(
      `INSERT INTO roles (organization_id, key, display_name, system_template, active)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (organization_id, key) DO UPDATE SET
         display_name = EXCLUDED.display_name, system_template = true, active = true
       RETURNING id`,
      [organizationId, key, displayName],
    );
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error(`Unable to provision ${key} role`);
    roleIds.set(key, roleId);
    for (const permission of permissions) {
      await client.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [organizationId, roleId, permission],
      );
    }
  }
  return roleIds;
}

export async function ensureOperatorOrganizationKey(client: PoolClient, organizationId: string): Promise<void> {
  const existing = await client.query(
    "SELECT 1 FROM organization_key_versions WHERE organization_id = $1 AND active FOR SHARE",
    [organizationId],
  );
  if (existing.rows.length === 1) return;
  if (existing.rows.length > 1) throw new Error("Organization has multiple active encryption keys");

  const rootKey = loadOrganizationRootKek();
  const dek = generateOrganizationDek();
  try {
    const provider = new LocalRootKeyProvider(rootKey);
    const wrapped = provider.wrapOrganizationKey(organizationId, 1, dek);
    await client.query(
      `INSERT INTO organization_key_versions (
         organization_id, version, key_provider, wrapped_dek, active
       ) VALUES ($1, 1, $2, $3, true)`,
      [organizationId, wrapped.provider, serializeWrappedKey(wrapped)],
    );
  } finally {
    dek.fill(0);
    rootKey.fill(0);
  }
}

export async function ensureOperatorLedgerFoundation(
  client: PoolClient,
  organizationId: string,
  input: z.output<typeof onboardingSchema>,
): Promise<Readonly<{ legalEntityId: string; ledgerId: string }>> {
  const entityResult = await client.query<{
    id: string; display_name: string; country_code: string; region_code: string;
  }>(
    `INSERT INTO legal_entities (
       organization_id, code, display_name, country_code, region_code, active
     ) VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (organization_id, code) DO UPDATE SET active = true
     RETURNING id, display_name, country_code, region_code`,
    [organizationId, input.entityCode, input.entityName, input.countryCode, input.regionCode],
  );
  const entity = entityResult.rows[0];
  if (entity && (
    entity.display_name !== input.entityName ||
    entity.country_code !== input.countryCode ||
    entity.region_code !== input.regionCode
  )) {
    throw new Error("Entity code is already bound to different legal-entity settings");
  }
  const legalEntityId = entity?.id;
  if (!legalEntityId) throw new Error("Unable to provision legal entity");

  const ledgerResult = await client.query<{
    id: string; legal_entity_id: string; accounting_profile: string; functional_currency: string;
  }>(
    `INSERT INTO ledgers (
       organization_id, legal_entity_id, code, display_name, kind,
       accounting_profile, functional_currency, active
     ) VALUES ($1, $2, $3, $4, 'PRIMARY', $5, $6, true)
     ON CONFLICT (organization_id, code) DO UPDATE SET active = true
     RETURNING id, legal_entity_id, accounting_profile, functional_currency`,
    [
      organizationId,
      legalEntityId,
      `${input.entityCode}-PRIMARY`,
      `${input.entityName} primary ledger`,
      input.accountingProfile,
      input.functionalCurrency,
    ],
  );
  const ledger = ledgerResult.rows[0];
  if (ledger && (
    ledger.legal_entity_id !== legalEntityId ||
    ledger.accounting_profile !== input.accountingProfile ||
    ledger.functional_currency !== input.functionalCurrency
  )) {
    throw new Error("Ledger code is already bound to different entity, profile, or currency settings");
  }
  const ledgerId = ledger?.id;
  if (!ledgerId) throw new Error("Unable to provision primary ledger");

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const startsOn = monthDate(input.fiscalYear, monthIndex, 1);
    const endsOn = monthIndex === 11
      ? monthDate(input.fiscalYear, 11, 31)
      : monthDate(input.fiscalYear, monthIndex + 1, 0);
    const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${startsOn}T00:00:00.000Z`));
    await client.query(
      `INSERT INTO fiscal_periods (
         organization_id, ledger_id, fiscal_year, period_number,
         label, starts_on, ends_on, state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
       ON CONFLICT (ledger_id, fiscal_year, period_number) DO NOTHING`,
      [organizationId, ledgerId, input.fiscalYear, monthIndex + 1, label, startsOn, endsOn],
    );
  }

  for (const [code, displayName, accountClass, controlKind] of BASE_ACCOUNTS) {
    const account = await client.query<{ id: string; class: string; control_kind: string }>(
      `INSERT INTO gl_accounts (
         organization_id, ledger_id, code, display_name, class,
         control_kind, postable, active, valid_from
       ) VALUES ($1, $2, $3, $4, $5, $6, true, true, $7)
       ON CONFLICT (ledger_id, code) DO UPDATE SET active = true
       RETURNING id, class, control_kind`,
      [organizationId, ledgerId, code, displayName, accountClass, controlKind, `${input.fiscalYear}-01-01`],
    );
    const accountRow = account.rows[0];
    if (accountRow && (accountRow.class !== accountClass || accountRow.control_kind !== controlKind)) {
      throw new Error(`Account ${code} is already bound to a different class or control role`);
    }
    const accountId = accountRow?.id;
    if (!accountId) throw new Error(`Unable to provision account ${code}`);
    const existingCombination = await client.query(
      `SELECT 1 FROM account_combinations
       WHERE organization_id = $1 AND ledger_id = $2
         AND entity_id = $3 AND account_id = $4
         AND subaccount_id IS NULL AND department_id IS NULL
         AND intercompany_entity_id IS NULL AND custom_1_id IS NULL
         AND custom_2_id IS NULL AND custom_3_id IS NULL AND custom_4_id IS NULL
         AND custom_5_id IS NULL AND custom_6_id IS NULL AND custom_7_id IS NULL
         AND custom_8_id IS NULL`,
      [organizationId, ledgerId, legalEntityId, accountId],
    );
    if (!existingCombination.rows[0]) {
      await client.query(
        `INSERT INTO account_combinations (
           organization_id, ledger_id, entity_id, account_id
         ) VALUES ($1, $2, $3, $4)`,
        [organizationId, ledgerId, legalEntityId, accountId],
      );
    }
  }

  const segments = [
    ["subaccount", 3, "Subaccount", "CONFIGURED_UNBOUND", true],
    ["department", 4, "Department", "CONFIGURED_UNBOUND", true],
    ...Array.from({ length: 8 }, (_, index) => [
      `custom${index + 1}`,
      index + 6,
      `Custom ${index + 1}`,
      "EMPTY",
      false,
    ]),
  ] as const;
  for (const [key, ordinal, displayName, state, visible] of segments) {
    await client.query(
      `INSERT INTO segment_definitions (
         organization_id, key, ordinal, display_name, state, required, visible
       ) VALUES ($1, $2, $3, $4, $5, false, $6)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [organizationId, key, ordinal, displayName, state, visible],
    );
  }
  return { legalEntityId, ledgerId };
}

export async function onboardOrganization(
  pool: Pool,
  unparsedInput: OrganizationOnboardingInput,
): Promise<OrganizationOnboardingResult> {
  const input = onboardingSchema.parse(unparsedInput);
  if ((input.countryCode === "CA") !== (input.functionalCurrency === "CAD")) {
    throw new Error("The initial Canadian entity must use CAD and the initial US entity must use USD");
  }
  if ((input.countryCode === "CA") !== (input.accountingProfile === "CAN_ASPE")) {
    throw new Error("The accounting profile must match the initial entity country");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`onboard:${input.slug}`]);
    const existing = await client.query<{ id: string; display_name: string; is_demo: boolean }>(
      "SELECT id, display_name, is_demo FROM organizations WHERE slug = $1 FOR UPDATE",
      [input.slug],
    );
    let organizationId = existing.rows[0]?.id;
    const created = !organizationId;
    if (existing.rows[0]?.is_demo) throw new Error("The public demo organization cannot be repurposed");
    if (existing.rows[0] && existing.rows[0].display_name !== input.organizationName) {
      throw new Error("Organization slug is already bound to a different display name");
    }
    if (!organizationId) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, display_name, active, is_demo)
         VALUES ($1, $2, true, false)
         RETURNING id`,
        [input.slug, input.organizationName],
      );
      organizationId = inserted.rows[0]?.id;
    }
    if (!organizationId) throw new Error("Unable to provision organization");

    await ensureOperatorOrganizationKey(client, organizationId);
    const roles = await ensureRoleTemplates(client, organizationId);
    const foundation = await ensureOperatorLedgerFoundation(client, organizationId, input);
    const ownerRoleId = roles.get("OWNER");
    if (!ownerRoleId) throw new Error("Unable to provision owner role");
    await client.query("COMMIT");
    return { organizationId, ...foundation, ownerRoleId, created };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
