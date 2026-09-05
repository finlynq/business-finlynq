import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
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
    reason: options.reason,
    sourceSurface: options.sourceSurface,
  })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
  assertWritableOrganization: mocks.assertWritableOrganization,
  demoWritesEnabled: vi.fn(() => true),
  mutationContext: mocks.mutationContext,
  principalCanWrite: vi.fn(() => true),
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: vi.fn(async () => true),
}));

import { createFiscalPeriods } from "@/modules/ledger/accounting-configuration";

const ledgerId = "20000000-0000-4000-8000-000000000001";
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
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2098-12-31T23:55:00Z"),
  stepUpExpiresAt: new Date("2099-01-01T00:00:00Z"),
  organizationWritesEnabled: true,
};

function successResult() {
  return {
    accepted: true,
    idempotentReplay: false,
    ledgerId,
    fiscalYear: 2026,
    periodPattern: "MONTHLY",
    initialState: "OPEN",
    summary: { created: 12, existing: 0, rejected: 0 },
    periods: Array.from({ length: 12 }, (_, index) => {
      const startsOn = new Date(Date.UTC(2026, index, 1));
      const endsOn = new Date(Date.UTC(2026, index + 1, 0));
      return {
        periodId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        periodNumber: index + 1,
        label: startsOn.toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + " 2026",
        startsOn: startsOn.toISOString().slice(0, 10),
        endsOn: endsOn.toISOString().slice(0, 10),
        state: "OPEN",
        outcome: "CREATED",
        rejectionCode: null,
      };
    }),
    conflicts: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fiscal-period creation service", () => {
  it("uses the business idempotency key, MCP provenance, and a canonical command hash", async () => {
    const query = vi.fn(async (
      _statement: string,
      _parameters?: readonly unknown[],
    ) => {
      void _statement;
      void _parameters;
      return { rows: [{ result: successResult() }] };
    });
    mocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const input = {
      principal,
      requestId: "mcp-execution-one",
      sourceSurface: "MCP" as const,
      ledgerId,
      fiscalYear: 2026,
      periodPattern: "MONTHLY" as const,
      initialState: "OPEN" as const,
      idempotencyKey: "calendar-2026",
      reason: "Create the approved 2026 calendar",
    };
    await expect(createFiscalPeriods(input)).resolves.toMatchObject({
      accepted: true,
      summary: { created: 12, existing: 0, rejected: 0 },
    });

    expect(mocks.mutationContext).toHaveBeenCalledWith(
      principal,
      expect.stringMatching(/^period-create:[0-9a-f]{64}$/),
      {
        reason: input.reason,
        sourceSurface: "MCP",
      },
    );
    const firstBusinessRequestId = mocks.mutationContext.mock.calls[0]?.[1];
    expect(firstBusinessRequestId).not.toContain(input.idempotencyKey);
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain("app.accounting_create_fiscal_periods");
    expect(parameters).toEqual([
      ledgerId,
      2026,
      "MONTHLY",
      "OPEN",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);

    await createFiscalPeriods({ ...input, requestId: "mcp-execution-two" });
    expect(mocks.mutationContext.mock.calls[1]?.[1]).toBe(firstBusinessRequestId);
    expect(query.mock.calls[1]?.[1]?.[4]).toBe(parameters?.[4]);

    await createFiscalPeriods({
      ...input,
      requestId: "mcp-execution-three",
      reason: "Create a materially different calendar request",
    });
    expect(mocks.mutationContext.mock.calls[2]?.[1]).toBe(firstBusinessRequestId);
    expect(query.mock.calls[2]?.[1]?.[4]).not.toBe(parameters?.[4]);
  });

  it("requires recent MFA before opening a real-business transaction", async () => {
    await expect(createFiscalPeriods({
      principal: { ...principal, stepUpExpiresAt: new Date(0) },
      requestId: "mcp-execution-expired",
      sourceSurface: "MCP",
      ledgerId,
      fiscalYear: 2026,
      periodPattern: "MONTHLY",
      initialState: "OPEN",
      idempotencyKey: "calendar-expired",
      reason: "Attempt creation without current MFA",
    })).rejects.toMatchObject({
      status: 428,
      code: "MFA_STEP_UP_REQUIRED",
    });
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});
