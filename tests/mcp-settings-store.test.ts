import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  hasRecentStepUp: vi.fn(() => true),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/session", () => ({
  hasRecentStepUp: mocks.hasRecentStepUp,
  transactionAuthMethod: vi.fn(() => "password+mfa"),
}));

import {
  decideMcpApproval,
  updateMcpConnectionSettings,
} from "@/modules/mcp/settings-store";
import { authorizeMcpWrite, type McpAuthorizationSnapshot } from "@/modules/mcp/connection-policy";

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
  expiresAt: new Date("2026-09-04T12:00:00Z"),
  mfaVerifiedAt: new Date("2026-09-03T12:00:00Z"),
  stepUpExpiresAt: new Date("2026-09-03T12:10:00Z"),
  organizationWritesEnabled: true,
};

const connectionId = "20000000-0000-4000-8000-000000000001";
const approvalId = "30000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasRecentStepUp.mockReturnValue(true);
  const client = { query: mocks.query } as unknown as PoolClient;
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work(client));
});

describe("MCP settings authorization persistence", () => {
  it("consumes an exact approved retry once and requires a new approval for a duplicate retry", async () => {
    const mfaSessionId = principal.sessionId;
    const mfaExpiry = new Date(Date.now() + 60_000);
    let status: "APPROVED" | "CONSUMED" = "APPROVED";
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT id, mfa_session_id")) {
        return { rows: status === "APPROVED" ? [{
          id: approvalId,
          mfa_session_id: mfaSessionId,
          mfa_step_up_expires_at: mfaExpiry,
        }] : [] };
      }
      if (statement.includes("UPDATE mcp_approvals SET status = 'CONSUMED'")) {
        status = "CONSUMED";
        return { rows: [{ id: approvalId }] };
      }
      if (statement.includes("AND status = 'PENDING'")) return { rows: [] };
      if (statement.includes("INSERT INTO mcp_approvals")) return { rows: [] };
      throw new Error("Unexpected approval SQL: " + statement);
    });
    const snapshot: McpAuthorizationSnapshot = {
      principal: {
        connectionId,
        organizationId: principal.organizationId,
        userId: principal.userId,
        membershipId: principal.membershipId,
        organizationName: principal.organizationName,
        roleLabel: principal.roleLabel,
        clientId: "finlynq_test_client",
        clientName: "Test client",
        scopes: ["mcp:setup:write"],
        resource: "https://business.example.test/mcp",
        dailyMode: "OFF",
        setupMode: "CONFIRM_WRITES",
        toolOverrides: {},
        tokenExpiresAt: new Date(Date.now() + 60_000),
        organizationWritesEnabled: true,
      },
      permissions: new Set(),
      dailyMode: "OFF",
      setupMode: "CONFIRM_WRITES",
      toolOverrides: {},
      directWriteSessionId: null,
      directWriteStepUpExpiresAt: null,
      connectionVersion: 1,
    };
    const tool = { name: "finlynq_setup_create_gl_account", group: "SETUP" as const, access: "WRITE" as const };
    const args = { ledgerId: "ledger-1", idempotencyKey: "approved-retry-1" };

    await expect(authorizeMcpWrite(snapshot, tool, args, "https://business.example.test/mcp")).resolves.toEqual({
      allowed: true,
      approvalId,
      delegatedSessionId: mfaSessionId,
      stepUpExpiresAt: mfaExpiry.toISOString(),
    });
    await expect(authorizeMcpWrite(snapshot, tool, args, "https://business.example.test/mcp")).resolves.toMatchObject({
      allowed: false,
      approvalUrl: expect.stringContaining("/app/settings/mcp?approval="),
    });
  });

  it("captures the verified browser session when Allow writes is saved", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        id: connectionId,
        daily_mode: "ALLOW_WRITES",
        setup_mode: "ALLOW_WRITES",
        tool_overrides: {},
        version: 2,
      }],
    });

    await expect(updateMcpConnectionSettings(principal, {
      connectionId,
      expectedVersion: 1,
      dailyMode: "ALLOW_WRITES",
      setupMode: "ALLOW_WRITES",
      toolOverrides: {},
    })).resolves.toMatchObject({
      connectionId,
      dailyMode: "ALLOW_WRITES",
      setupMode: "ALLOW_WRITES",
      version: 2,
    });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("direct_write_session_id = $4"),
      [
        "ALLOW_WRITES",
        "ALLOW_WRITES",
        "{}",
        principal.sessionId,
        principal.stepUpExpiresAt,
        principal.organizationId,
        principal.userId,
        connectionId,
        1,
      ],
    );
  });

  it("binds an approved high-assurance action to the approving browser session", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ tool_name: "finlynq_setup_configure_currency" }] })
      .mockResolvedValueOnce({ rows: [{ id: approvalId }] });

    await expect(decideMcpApproval(principal, {
      approvalId,
      decision: "APPROVED",
    })).resolves.toBe(true);

    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("mfa_session_id = $5"),
      [
        "APPROVED",
        principal.organizationId,
        principal.userId,
        approvalId,
        principal.sessionId,
        principal.stepUpExpiresAt,
      ],
    );
  });

  it("approves ordinary supplier creation without attaching browser MFA delegation", async () => {
    mocks.hasRecentStepUp.mockReturnValue(false);
    mocks.query
      .mockResolvedValueOnce({ rows: [{ tool_name: "finlynq_setup_create_party" }] })
      .mockResolvedValueOnce({ rows: [{ id: approvalId }] });

    await expect(decideMcpApproval(principal, {
      approvalId,
      decision: "APPROVED",
    })).resolves.toBe(true);

    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("mfa_session_id = $5"),
      [
        "APPROVED",
        principal.organizationId,
        principal.userId,
        approvalId,
        null,
        null,
      ],
    );
  });

  it("never attaches MFA delegation to rejection and refuses missing or expired approvals", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ tool_name: "finlynq_setup_configure_currency" }] })
      .mockResolvedValueOnce({ rows: [{ id: approvalId }] });

    await expect(decideMcpApproval(principal, {
      approvalId,
      decision: "REJECTED",
    })).resolves.toBe(true);
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.any(String),
      ["REJECTED", principal.organizationId, principal.userId, approvalId, null, null],
    );

    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(decideMcpApproval(principal, {
      approvalId,
      decision: "APPROVED",
    })).resolves.toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
