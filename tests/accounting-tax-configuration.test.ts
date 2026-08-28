import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  taxRegistrationAutomationStatus,
  taxRegistrationConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";

const workspaceRoot = process.cwd();
const migration = readFileSync(
  join(workspaceRoot, "migrations/drizzle/0020_accounting_configuration.sql"),
  "utf8",
);
const subledgerWorkspace = readFileSync(
  join(workspaceRoot, "src/modules/subledger/workspace.ts"),
  "utf8",
);
const demoBootstrap = readFileSync(
  join(workspaceRoot, "src/modules/onboarding/demo-bootstrap.ts"),
  "utf8",
);
const settingsClient = readFileSync(
  join(workspaceRoot, "src/app/_components/accounting-settings.client.tsx"),
  "utf8",
);
const runtimeGrants = readFileSync(
  join(workspaceRoot, "deploy/postgres/010-runtime-role.sh"),
  "utf8",
);

function registration(overrides: Record<string, unknown> = {}) {
  return {
    legalEntityId: "10000000-0000-4000-8000-000000000005",
    regimeKey: "us.wa.sales-use",
    registrationReference: "WA-TEST-12345",
    destinationCountry: "us",
    destinationRegion: "wa",
    destinationCity: "Seattle",
    locationCode: "1726",
    configurationEvidence: "Washington DOR lookup confirmation 2026-08-27",
    validFrom: "2026-08-27",
    validTo: null,
    reason: "Configure verified Washington sourcing",
    ...overrides,
  };
}

describe("governed entity tax configuration", () => {
  it("normalizes explicit sourcing facts and recognizes only the reviewed automated combinations", () => {
    const parsed = taxRegistrationConfigurationSchema.parse(registration());
    expect(parsed).toMatchObject({
      destinationCountry: "US",
      destinationRegion: "WA",
      destinationCity: "Seattle",
      locationCode: "1726",
    });
    expect(taxRegistrationAutomationStatus(parsed)).toBe("AUTOMATED");
    expect(taxRegistrationAutomationStatus({
      ...parsed,
      destinationCity: "Bellevue",
      locationCode: "1727",
    })).toBe("MANUAL_REVIEW");
    expect(taxRegistrationConfigurationSchema.safeParse(registration({
      destinationCity: "",
      locationCode: "1726",
    })).success).toBe(false);
    expect(taxRegistrationConfigurationSchema.safeParse(registration({
      destinationCity: "Bellevue",
      locationCode: "1727",
    })).success).toBe(true);
  });

  it("adds explicit nullable legacy columns and exposes an insert-only authorized mutation", () => {
    expect(migration).toContain("ADD COLUMN destination_country text");
    expect(migration).toContain("ADD COLUMN destination_region text");
    expect(migration).toContain("ADD COLUMN destination_city text");
    expect(migration).toContain("ADD COLUMN location_code text");
    expect(migration).toContain("ADD COLUMN configuration_evidence text");
    const mutation = migration.split("CREATE OR REPLACE FUNCTION app.accounting_add_tax_registration")[1]
      ?.split("REVOKE ALL ON FUNCTION app.accounting_add_tax_registration")[0] ?? "";
    expect(mutation).toContain("app.organization_admin_authorize('organization.settings.manage', true)");
    expect(mutation).toContain("INSERT INTO entity_tax_registrations");
    expect(mutation).not.toMatch(/\bUPDATE\s+entity_tax_registrations\b/i);
    expect(mutation).not.toMatch(/\bDELETE\s+FROM\s+entity_tax_registrations\b/i);
    expect(mutation).toContain("city Seattle and DOR location code 1726");
    expect(runtimeGrants).toContain(
      "app.accounting_add_tax_registration(uuid,uuid,text,text,integer,text,text,text,text,text,date,date)",
    );
  });

  it("seeds explicit demo facts and never derives Seattle in the AR/AP workspace", () => {
    expect(demoBootstrap).toContain('const destinationCity = foundation.countryCode === "CA" ? "Toronto" : "Seattle"');
    expect(demoBootstrap).toContain('const locationCode = foundation.countryCode === "CA" ? null : "1726"');
    expect(demoBootstrap).toContain("destination_country = EXCLUDED.destination_country");
    expect(demoBootstrap).toContain("configuration_evidence = EXCLUDED.configuration_evidence");
    expect(subledgerWorkspace).toContain("registration.destination_country");
    expect(subledgerWorkspace).toContain('destinationCountry: configuredTax?.destination_country ?? "ZZ"');
    expect(subledgerWorkspace).not.toContain('destinationCity: washington ? "Seattle"');
    expect(subledgerWorkspace).not.toContain('locationCode: washington ? "1726"');
  });

  it("renders registration history and an explicit evidence-backed settings form", () => {
    expect(settingsClient).toContain("Entity tax registration history");
    expect(settingsClient).toContain("Configuration evidence");
    expect(settingsClient).toContain("/api/accounting/configuration/tax-registrations");
    expect(settingsClient).toContain("The system never fills Seattle or location code 1726");
  });
});
