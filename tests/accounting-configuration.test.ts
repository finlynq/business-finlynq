import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountCombinationConfigurationSchema,
  currencyRateConfigurationSchema,
  legalEntityConfigurationSchema,
  segmentConfigurationSchema,
  segmentValueConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";
import { organizationAdministrationFailure } from "@/modules/identity/organization-administration";

const accountingMigration = readFileSync(
  join(process.cwd(), "migrations/drizzle/0020_accounting_configuration.sql"),
  "utf8",
);
const signupMigration = readFileSync(
  join(process.cwd(), "migrations/drizzle/0019_global_signup_foundation.sql"),
  "utf8",
);
const restoreSafetyMigration = readFileSync(
  join(process.cwd(), "migrations/drizzle/0029_restore_safe_currency_lookup.sql"),
  "utf8",
);
const runtimeRole = readFileSync(
  join(process.cwd(), "deploy/postgres/010-runtime-role.sh"),
  "utf8",
);
const accountingSettings = readFileSync(
  join(process.cwd(), "src/app/_components/accounting-settings.client.tsx"),
  "utf8",
);

function migrationFunction(name: string): string {
  const body = accountingMigration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION app\\.${name}\\([\\s\\S]*?\\r?\\n\\$\\$;`,
  ))?.[0];
  if (!body) throw new Error(`Missing migration function ${name}`);
  return body;
}

describe("accounting configuration foundation", () => {
  it("accepts an arbitrary ISO-country entity with a supported functional currency", () => {
    expect(legalEntityConfigurationSchema.parse({
      code: "GB01",
      displayName: "Example UK Limited",
      countryCode: "gb",
      regionCode: "eng",
      functionalCurrency: "gbp",
      accountingProfile: "US_GAAP_NONPUBLIC",
      fiscalYear: 2026,
      manualPostingMode: "REVIEW_REQUIRED",
      reason: "Add the UK legal entity",
    })).toMatchObject({
      countryCode: "GB",
      regionCode: "ENG",
      functionalCurrency: "GBP",
    });
  });

  it("requires an exact positive-direction currency pair and protected segment action", () => {
    expect(currencyRateConfigurationSchema.safeParse({
      sourceCurrency: "USD",
      targetCurrency: "USD",
      rate: "1.00",
      effectiveAt: "2026-08-27T12:00:00-04:00",
      source: "Manual rate",
      reason: "Record month end rate",
    }).success).toBe(false);
    expect(currencyRateConfigurationSchema.safeParse({
      sourceCurrency: "USD",
      targetCurrency: "CAD",
      rate: "0.000",
      effectiveAt: "2026-08-27T12:00:00-04:00",
      source: "Manual rate",
      reason: "Record month end rate",
    }).success).toBe(false);
    expect(currencyRateConfigurationSchema.safeParse({
      sourceCurrency: "USD",
      targetCurrency: "CAD",
      rate: `${"9".repeat(21)}.${"9".repeat(18)}`,
      effectiveAt: "2026-08-27T12:00:00-04:00",
      source: "Manual rate",
      reason: "Record month end rate",
    }).success).toBe(false);
    expect(segmentConfigurationSchema.parse({
      key: "custom8",
      displayName: "Grant",
      visible: true,
      required: false,
      action: "CONFIGURE",
      reason: "Configure grant dimension",
    }).key).toBe("custom8");
  });

  it("keeps currency and FX data tenant-isolated, append-only, audited, and resettable", () => {
    expect(accountingMigration).toContain("ALTER TABLE organization_currencies FORCE ROW LEVEL SECURITY");
    expect(accountingMigration).toContain("ALTER TABLE currency_exchange_rates FORCE ROW LEVEL SECURITY");
    expect(accountingMigration).toContain("organization_id = app.current_organization_id()");
    expect(accountingMigration).toContain("accounting.currency_rate.recorded");
    expect(accountingMigration).toContain("CREATE TRIGGER currency_exchange_rates_append_only");
    expect(accountingMigration).toContain("EXECUTE FUNCTION app.guard_append_only()");
    expect(accountingMigration).toContain("('currency_exchange_rates', 29)");
  });

  it("serializes currency disable with every ledger functional-currency ensure/create path", () => {
    const lockIdentity = "|organization-currency|";
    const ledgerTrigger = migrationFunction("ensure_ledger_functional_currency_enabled");
    const currencyMutation = migrationFunction("accounting_set_currency_enabled");
    const entityCreation = migrationFunction("accounting_create_legal_entity");

    expect(ledgerTrigger).toContain(lockIdentity);
    expect(currencyMutation).toContain(lockIdentity);
    expect(entityCreation).toContain(lockIdentity);
    expect(ledgerTrigger.indexOf(lockIdentity)).toBeLessThan(
      ledgerTrigger.indexOf("INSERT INTO organization_currencies"),
    );
    expect(currencyMutation.indexOf(lockIdentity)).toBeLessThan(
      currencyMutation.indexOf("A functional currency cannot be disabled"),
    );
    expect(entityCreation.indexOf(lockIdentity)).toBeLessThan(
      entityCreation.indexOf("INSERT INTO ledgers"),
    );
  });

  it("creates company foundations through a permission-checked database function", () => {
    expect(accountingMigration).toContain("CREATE OR REPLACE FUNCTION app.accounting_create_legal_entity");
    expect(accountingMigration).toContain("app.organization_admin_authorize('organization.settings.manage', true)");
    expect(accountingMigration).toContain("app.organization_admin_authorize('ledger.segments.manage', true)");
    expect(accountingMigration).toContain("'ledger.segments.manage'");
    expect(accountingMigration).toContain("role.key = 'demo_accountant'");
    expect(accountingMigration).toContain("INSERT INTO fiscal_periods");
    expect(accountingMigration).toContain("INSERT INTO gl_accounts");
    expect(accountingMigration).toContain("INSERT INTO ledger_posting_policies");
    expect(accountingMigration).toContain("accounting.legal_entity.created");
  });

  it("validates permanent segment values and typed account combinations at the API boundary", () => {
    expect(segmentValueConfigurationSchema.parse({
      definitionKey: "custom8",
      code: "grant_a",
      displayName: "Grant A",
      validFrom: "2026-08-27",
      validTo: "2027-08-26",
      reason: "Add the approved grant value",
    }).code).toBe("GRANT_A");
    expect(segmentValueConfigurationSchema.safeParse({
      definitionKey: "custom8",
      code: "0000",
      displayName: "Reserved",
      validFrom: "2026-08-27",
      validTo: null,
      reason: "Attempt a reserved identity",
    }).success).toBe(false);
    expect(segmentValueConfigurationSchema.safeParse({
      definitionKey: "department",
      code: "OPS",
      displayName: "Operations",
      validFrom: "2026-08-27",
      validTo: "2026-08-26",
      reason: "Attempt an invalid date range",
    }).success).toBe(false);

    const entityId = "11111111-1111-4111-8111-111111111111";
    expect(accountCombinationConfigurationSchema.safeParse({
      legalEntityId: entityId,
      ledgerId: "22222222-2222-4222-8222-222222222222",
      accountId: "33333333-3333-4333-8333-333333333333",
      subaccountId: null,
      departmentId: "",
      intercompanyEntityId: entityId,
      custom1Id: null,
      custom2Id: null,
      custom3Id: null,
      custom4Id: null,
      custom5Id: null,
      custom6Id: null,
      custom7Id: null,
      custom8Id: null,
      replacesCombinationId: null,
      reason: "Attempt a self intercompany value",
    }).success).toBe(false);
  });

  it("creates segment identities through audited tenant-authorized database functions", () => {
    expect(accountingMigration).toContain("CREATE OR REPLACE FUNCTION app.accounting_add_segment_value");
    expect(accountingMigration).toContain("CREATE OR REPLACE FUNCTION app.accounting_create_account_combination");
    expect(accountingMigration.match(/app\.organization_admin_authorize\('ledger\.segments\.manage', true\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(accountingMigration).toContain("normalized_code = '0000'");
    expect(accountingMigration).toContain("definition.state <> 'ACTIVE_LOCKED'");
    expect(accountingMigration).toContain("Every selected value must belong to its exact active segment definition");
    expect(accountingMigration).toContain("combination.subaccount_id IS NOT DISTINCT FROM selected_subaccount_id");
    expect(accountingMigration).toContain("A used account combination cannot be replaced or changed");
    expect(accountingMigration).toContain("accounting.segment_value.created");
    expect(accountingMigration).toContain("accounting.account_combination.created");
    expect(runtimeRole).toContain("app.accounting_add_segment_value(text,text,text,date,date)");
    expect(runtimeRole).toContain("app.accounting_create_account_combination(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)");
  });

  it("serializes segment definition/value changes with every governed combination creator", () => {
    const lockIdentity = "|account-segments";
    for (const name of [
      "accounting_configure_segment",
      "accounting_add_segment_value",
      "accounting_create_account_combination",
      "accounting_create_legal_entity",
    ]) {
      expect(migrationFunction(name), name).toContain(lockIdentity);
    }
    expect(migrationFunction("accounting_configure_segment").indexOf(lockIdentity)).toBeLessThan(
      migrationFunction("accounting_configure_segment").indexOf("FOR UPDATE"),
    );
    expect(migrationFunction("accounting_add_segment_value").indexOf(lockIdentity)).toBeLessThan(
      migrationFunction("accounting_add_segment_value").indexOf("FOR SHARE"),
    );
    expect(migrationFunction("accounting_create_account_combination").indexOf(lockIdentity)).toBeLessThan(
      migrationFunction("accounting_create_account_combination").indexOf("Every required segment needs a value"),
    );
    expect(migrationFunction("accounting_create_legal_entity")).toContain(
      "Create legal entities before requiring an account segment",
    );
  });

  it("exposes values, combinations, and completeness blockers in accounting settings", () => {
    expect(accountingSettings).toContain("Add a segment value");
    expect(accountingSettings).toContain("Create an account combination");
    expect(accountingSettings).toContain("Incomplete combinations");
    expect(accountingSettings).toContain("segment.missingActiveCombinationCount > 0");
    expect(accountingSettings).toContain("combination.canonicalKey");
    expect(accountingSettings).toContain("Protected after use");
  });

  it("relaxes signup only to ISO countries and configured currency precision", () => {
    expect(signupMigration).toContain("selected_country_code !~ '^[A-Z]{2}$'");
    expect(signupMigration).toContain("app.currency_minor_units(selected_functional_currency) IS NULL");
    expect(signupMigration).toContain("DROP CONSTRAINT auth_organization_signups_country_profile_check");
    expect(signupMigration).toContain("auth_organization_signups_supported_currency_check");
    expect(signupMigration).toContain("validation no longer matches the reviewed predecessor");
    expect(restoreSafetyMigration).toContain(
      'DROP CONSTRAINT "auth_organization_signups_supported_currency_check"',
    );
    expect(restoreSafetyMigration).toContain(
      'ADD CONSTRAINT "auth_organization_signups_functional_currency_fk"',
    );
  });

  it("installs the generic manual-review tax policy used by unsupported jurisdictions", () => {
    expect(accountingMigration).toContain("'generic.unsupported', '2026.08.27'");
    expect(accountingMigration).toContain("GLOBAL-UNSUPPORTED");
  });

  it("allows parallel regimes but rejects overlapping windows within one entity and regime", () => {
    expect(accountingMigration).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(accountingMigration).toContain("entity_tax_registrations_regime_window_exclusion");
    expect(accountingMigration).toContain("regime_key WITH =");
    expect(accountingMigration).toContain("daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&");
    expect(accountingMigration).toContain("registration.regime_key = normalized_regime");
    expect(accountingMigration).toContain("A tax configuration overlaps this validity window");
    expect(accountingMigration).not.toContain("registration.valid_from = selected_valid_from");
  });

  it("returns actionable statuses for deterministic database rejections", () => {
    const invalid = organizationAdministrationFailure(Object.assign(
      new Error("Invalid exchange-rate configuration"),
      { code: "22023" },
    ));
    const duplicate = organizationAdministrationFailure(Object.assign(
      new Error("duplicate key value violates unique constraint"),
      { code: "23505" },
    ));
    expect({ status: invalid.status, code: invalid.code }).toEqual({
      status: 400,
      code: "INVALID_CONFIGURATION",
    });
    expect({ status: duplicate.status, code: duplicate.code }).toEqual({
      status: 409,
      code: "CONFIGURATION_CONFLICT",
    });
  });
});
