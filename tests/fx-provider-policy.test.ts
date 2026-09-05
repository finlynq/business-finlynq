import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  hasRecentStepUp: vi.fn(() => true),
  assertPermission: vi.fn(async () => undefined),
  assertWrites: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
  demoWritesEnabled: vi.fn(() => true),
  mutationContext: vi.fn((
    principal: SessionPrincipal,
    requestId: string,
    options: { reason: string; sourceSurface: "API" | "MCP" },
  ) => ({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId,
    authMethod: "password+mfa",
    sourceSurface: options.sourceSurface,
    reason: options.reason,
  })),
}));

vi.mock("@/db/transaction", () => ({ withTenantTransaction: mocks.withTenantTransaction }));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.assertPermission,
}));
vi.mock("@/modules/identity/session", async (importOriginal) => ({
  ...await importOriginal<object>(),
  hasRecentStepUp: mocks.hasRecentStepUp,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertWrites,
  assertWritableOrganization: mocks.assertWritableOrganization,
  demoWritesEnabled: mocks.demoWritesEnabled,
  mutationContext: mocks.mutationContext,
}));

import {
  configureOrganizationFxProviderPolicy,
  DEFAULT_ORGANIZATION_FX_PROVIDER_POLICY,
  organizationFxProviderPolicyConfigurationSchema,
  readOrganizationFxProviderPolicy,
} from "@/modules/fx/provider-policy";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-05T23:00:00Z"),
  mfaVerifiedAt: new Date("2026-09-05T22:00:00Z"),
  stepUpExpiresAt: new Date("2026-09-05T23:00:00Z"),
};

const configuredRow = {
  id: "20000000-0000-4000-8000-000000000001",
  version: 1,
  provider_mode: "YAHOO_FINANCE_EXPERIMENTAL",
  max_lookback_days: 5,
  licensed_and_authorized_use_acknowledged: true,
  configured_at: "2026-09-05 22:15:00+00",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasRecentStepUp.mockReturnValue(true);
  mocks.assertPermission.mockResolvedValue(undefined);
  mocks.assertWritableOrganization.mockResolvedValue({ isDemo: false });
});

describe("organization FX provider policy", () => {
  it("shows source-specific suitability disclosures before a central-bank policy is saved", () => {
    const settingsSource = readFileSync(
      join(process.cwd(), "src/app/_components/accounting-settings.client.tsx"),
      "utf8",
    );
    expect(settingsSource).toContain("Bank of Canada daily exchange rates are indicative");
    expect(settingsSource).toContain("not a benchmark or transaction quote");
    expect(settingsSource).toContain("ECB foreign-exchange reference rates are published for information");
    expect(settingsSource).toContain("discourages their use for transactions");
    expect(settingsSource).toContain("Use an explicit client-approved rate");
  });

  it("keeps organizations without a policy row on the stored-only default", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(readOrganizationFxProviderPolicy(
      { query } as unknown as PoolClient,
      principal.organizationId,
    )).resolves.toEqual(DEFAULT_ORGANIZATION_FX_PROVIDER_POLICY);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE organization_id = $1"),
      [principal.organizationId],
    );
    expect(DEFAULT_ORGANIZATION_FX_PROVIDER_POLICY).toMatchObject({
      id: null,
      version: 0,
      providerMode: "STORED_ONLY",
      maxLookbackDays: 7,
      licensedAndAuthorizedUseAcknowledged: false,
    });
  });

  it("requires Yahoo acknowledgement, rejects it for central-bank modes, and enforces lookback", () => {
    const base = {
      expectedVersion: 0,
      maxLookbackDays: 5,
      reason: "Approve the controlled FX source",
    };
    expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
      ...base,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      licensedAndAuthorizedUseAcknowledged: true,
    }).success).toBe(true);
    expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
      ...base,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      licensedAndAuthorizedUseAcknowledged: false,
    }).success).toBe(false);
    expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
      ...base,
      providerMode: "STORED_ONLY",
      licensedAndAuthorizedUseAcknowledged: true,
    }).success).toBe(false);
    for (const providerMode of ["BANK_OF_CANADA", "EUROPEAN_CENTRAL_BANK"] as const) {
      expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
        ...base,
        providerMode,
        licensedAndAuthorizedUseAcknowledged: false,
      }).success).toBe(true);
      expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
        ...base,
        providerMode,
        licensedAndAuthorizedUseAcknowledged: true,
      }).success).toBe(false);
    }
    for (const maxLookbackDays of [0, 8]) {
      expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
        ...base,
        maxLookbackDays,
        providerMode: "STORED_ONLY",
        licensedAndAuthorizedUseAcknowledged: false,
      }).success).toBe(false);
    }
    expect(organizationFxProviderPolicyConfigurationSchema.safeParse({
      ...base,
      providerMode: "STORED_ONLY",
      licensedAndAuthorizedUseAcknowledged: false,
      organizationId: "another-tenant",
    }).success).toBe(false);
  });

  it("binds writes to the principal tenant and rechecks settings permission in the transaction", async () => {
    const query = vi.fn(async () => ({ rows: [configuredRow] }));
    mocks.withTenantTransaction.mockImplementation(async (
      context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(configureOrganizationFxProviderPolicy({
      principal,
      requestId: "fx-policy-write",
      sourceSurface: "MCP",
      expectedVersion: 0,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      maxLookbackDays: 5,
      licensedAndAuthorizedUseAcknowledged: true,
      reason: "Approve the controlled FX source",
    })).resolves.toEqual({
      id: configuredRow.id,
      version: 1,
      providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
      maxLookbackDays: 5,
      licensedAndAuthorizedUseAcknowledged: true,
      configuredAt: configuredRow.configured_at,
    });

    expect(mocks.withTenantTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: principal.organizationId,
        actorId: principal.userId,
        requestId: "fx-policy-write",
        sourceSurface: "MCP",
        reason: "Approve the controlled FX source",
      }),
      expect.any(Function),
    );
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: "organization.settings.manage",
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("app.accounting_set_fx_provider_policy($1,$2,$3,$4)"),
      [0, "YAHOO_FINANCE_EXPERIMENTAL", 5, true],
    );
  });

  it("rejects missing assurance or permission before the controlled database mutation", async () => {
    mocks.hasRecentStepUp.mockReturnValue(false);
    await expect(configureOrganizationFxProviderPolicy({
      principal,
      requestId: "fx-policy-no-mfa",
      expectedVersion: 0,
      providerMode: "STORED_ONLY",
      maxLookbackDays: 7,
      licensedAndAuthorizedUseAcknowledged: false,
      reason: "Retain stored rate resolution",
    })).rejects.toMatchObject({ status: 428, code: "MFA_STEP_UP_REQUIRED" });
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();

    mocks.hasRecentStepUp.mockReturnValue(true);
    mocks.assertPermission.mockRejectedValueOnce(new Error("permission denied"));
    const query = vi.fn();
    mocks.withTenantTransaction.mockImplementationOnce(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));
    await expect(configureOrganizationFxProviderPolicy({
      principal,
      requestId: "fx-policy-no-permission",
      expectedVersion: 0,
      providerMode: "STORED_ONLY",
      maxLookbackDays: 7,
      licensedAndAuthorizedUseAcknowledged: false,
      reason: "Retain stored rate resolution",
    })).rejects.toThrow(/permission denied/);
    expect(query).not.toHaveBeenCalled();
  });

  it("installs tenant RLS, append-only versions, database authorization, and audit evidence", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations/drizzle/0045_organization_fx_provider_policy.sql"),
      "utf8",
    );
    const centralBankMigration = readFileSync(
      join(process.cwd(), "migrations/drizzle/0046_central_bank_fx_providers.sql"),
      "utf8",
    );
    const runtimeRole = readFileSync(
      join(process.cwd(), "deploy/postgres/010-runtime-role.sh"),
      "utf8",
    );
    const settingsUi = readFileSync(
      join(process.cwd(), "src/app/_components/accounting-settings.client.tsx"),
      "utf8",
    );

    expect(migration).toContain("ALTER TABLE organization_fx_provider_policy_versions FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("organization_id = app.current_organization_id()");
    expect(migration).toContain("app.organization_admin_authorize('organization.settings.manage', true)");
    expect(migration).toContain("organization_fx_provider_policy_versions_append_only");
    expect(migration).toContain("EXECUTE FUNCTION app.guard_append_only()");
    expect(migration).toContain("'accounting.fx_provider_policy.changed'");
    expect(migration).toContain("selected_expected_version <> current_version");
    expect(migration).not.toMatch(/INSERT INTO organization_fx_provider_policy_versions[\s\S]*SELECT[\s\S]*FROM organizations/);
    expect(centralBankMigration).toContain("'BANK_OF_CANADA'");
    expect(centralBankMigration).toContain("'EUROPEAN_CENTRAL_BANK'");
    expect(centralBankMigration).toContain("CREATE OR REPLACE FUNCTION app.accounting_set_fx_provider_policy");
    expect(centralBankMigration).toContain("normalized_provider_mode <> 'YAHOO_FINANCE_EXPERIMENTAL'");
    expect(centralBankMigration).not.toMatch(/INSERT INTO organization_fx_provider_policy_versions[\s\S]*SELECT[\s\S]*FROM organizations/);
    expect(runtimeRole).toContain("'organization_fx_provider_policy_versions'");
    expect(runtimeRole).toContain("app.accounting_set_fx_provider_policy(integer,text,integer,boolean)");
    expect(settingsUi).toContain("Licensed and authorized use");
    expect(settingsUi).toContain("Saving this policy does not fetch market data");
  });
});
