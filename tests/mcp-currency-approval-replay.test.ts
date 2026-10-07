import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/workspace/write-policy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/workspace/write-policy")>(),
  assertWritableOrganization: mocks.assertWritableOrganization,
}));

import { configureOrganizationCurrency } from "@/modules/ledger/accounting-configuration";
import { mcpSessionPrincipal } from "@/modules/mcp/oauth-store";
import { mcpToolFailureResult } from "@/modules/mcp/tool-types";

const connectionId = "10000000-0000-4000-8000-000000000001";
const browserSessionId = "10000000-0000-4000-8000-000000000002";
const principal = mcpSessionPrincipal({
  connectionId,
  organizationId: "10000000-0000-4000-8000-000000000003",
  userId: "10000000-0000-4000-8000-000000000004",
  membershipId: "10000000-0000-4000-8000-000000000005",
  organizationName: "Test organization",
  roleLabel: "Owner",
  clientId: "finlynq_test_client",
  clientName: "Test client",
  scopes: ["mcp:setup:write"],
  resource: "https://finlynq.test/mcp",
  dailyMode: "OFF",
  setupMode: "CONFIRM_WRITES",
  toolOverrides: {},
  tokenExpiresAt: new Date(Date.now() + 60_000),
  organizationWritesEnabled: true,
}, new Date(Date.now() + 60_000).toISOString(), browserSessionId);

const command = {
  principal,
  requestId: "mcp-tool:currency-approved-retry",
  currencyCode: "EUR",
  enabled: true,
  reason: "Enable EUR payments",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

afterEach(() => vi.unstubAllEnvs());

describe("approved MCP currency retry", () => {
  it("executes the original business arguments under the approving browser session", async () => {
    mocks.query.mockResolvedValue({ rows: [{ enabled: true }] });

    await expect(configureOrganizationCurrency(command)).resolves.toEqual({ enabled: true });
    expect(mocks.withTenantTransaction).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: browserSessionId,
      mcpConnectionId: connectionId,
      authMethod: "password+mfa",
      sourceSurface: "MCP",
      requestId: command.requestId,
    }), expect.any(Function));
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT app.accounting_set_currency_enabled($1,$2) AS enabled",
      ["EUR", true],
    );
  });

  it("returns an actionable conflict when a ledger still uses the currency", async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error("A functional currency cannot be disabled"), { code: "55000" }));

    await expect(configureOrganizationCurrency({ ...command, enabled: false })).rejects.toMatchObject({
      code: "ORGANIZATION_CURRENCY_IN_USE",
      message: expect.stringContaining("active ledger"),
    });
    try {
      await configureOrganizationCurrency({ ...command, enabled: false });
    } catch (error) {
      expect(mcpToolFailureResult(error).structuredContent).toMatchObject({
        status: "failed",
        error: { code: "ORGANIZATION_CURRENCY_IN_USE" },
      });
    }
  });

  it("preserves unrelated authorization failures rather than presenting them as currency conflicts", async () => {
    const authorizationError = Object.assign(new Error("Authorization context expired"), { code: "28000" });
    mocks.query.mockRejectedValue(authorizationError);

    await expect(configureOrganizationCurrency(command)).rejects.toBe(authorizationError);
  });
});
