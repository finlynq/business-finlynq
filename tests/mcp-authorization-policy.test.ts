import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  effectiveToolMode,
  isMcpToolVisible,
  intersectMcpScopes,
  mcpToolNameRequiresStepUp,
  mcpArgumentsHash,
  safeArgumentsSummary,
  type McpAuthorizationSnapshot,
  type McpToolPolicy,
} from "@/modules/mcp/connection-policy";

function snapshot(overrides: Partial<McpAuthorizationSnapshot> = {}): McpAuthorizationSnapshot {
  return {
    principal: {
      connectionId: "33333333-3333-4333-8333-333333333333",
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      membershipId: "44444444-4444-4444-8444-444444444444",
      organizationName: "Example",
      roleLabel: "Accountant",
      clientId: "finlynq_55555555-5555-4555-8555-555555555555",
      clientName: "Test client",
      scopes: [MCP_DAILY_READ, MCP_DAILY_WRITE],
      resource: "https://example.test/mcp",
      dailyMode: "CONFIRM_WRITES",
      setupMode: "OFF",
      toolOverrides: {},
      tokenExpiresAt: new Date(Date.now() + 60_000),
      organizationWritesEnabled: true,
    },
    permissions: new Set([PERMISSIONS.readMcpLedger, PERMISSIONS.draftJournal]),
    dailyMode: "CONFIRM_WRITES",
    setupMode: "OFF",
    toolOverrides: {},
    connectionVersion: 1,
    ...overrides,
  };
}

const MCP_DAILY_READ = "mcp:daily:read";
const MCP_DAILY_WRITE = "mcp:daily:write";

describe("remote MCP live authorization", () => {
  const readTool: McpToolPolicy = { name: "finlynq_daily_read", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger };
  const writeTool: McpToolPolicy = { name: "finlynq_daily_write", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal };

  it("uses only the intersection of token scopes and the current connection grant", () => {
    expect(intersectMcpScopes([MCP_DAILY_READ], [MCP_DAILY_READ, MCP_DAILY_WRITE])).toEqual([MCP_DAILY_READ]);
    expect(intersectMcpScopes([MCP_DAILY_READ, MCP_DAILY_WRITE], [MCP_DAILY_READ])).toEqual([MCP_DAILY_READ]);
  });

  it("classifies Setup writes and reconciliation transitions as high assurance", () => {
    expect(mcpToolNameRequiresStepUp("finlynq_setup_update_party")).toBe(true);
    expect(mcpToolNameRequiresStepUp("finlynq_daily_transition_bank_reconciliation")).toBe(true);
    expect(mcpToolNameRequiresStepUp("finlynq_daily_create_journal")).toBe(false);
  });

  it("intersects OAuth scope, group mode, and live role permissions", () => {
    expect(isMcpToolVisible(snapshot(), readTool)).toBe(true);
    expect(isMcpToolVisible(snapshot(), writeTool)).toBe(true);
    expect(isMcpToolVisible(snapshot({ permissions: new Set() }), readTool)).toBe(false);
    expect(isMcpToolVisible(snapshot({ principal: { ...snapshot().principal, scopes: [MCP_DAILY_READ] } }), writeTool)).toBe(false);
    expect(isMcpToolVisible(snapshot({ dailyMode: "READ_ONLY" }), writeTool)).toBe(false);
  });

  it("supports any-of permissions without exposing tools to unrelated roles", () => {
    const tool: McpToolPolicy = {
      name: "finlynq_daily_documents",
      group: "DAILY",
      access: "READ",
      permissionsAny: [PERMISSIONS.readReceivables, PERMISSIONS.readPayables],
    };
    expect(isMcpToolVisible(snapshot({ permissions: new Set([PERMISSIONS.readPayables]) }), tool)).toBe(true);
    expect(isMcpToolVisible(snapshot({ permissions: new Set([PERMISSIONS.readMcpLedger]) }), tool)).toBe(false);
  });

  it("applies exact per-tool overrides over inherited group settings", () => {
    const selected = snapshot({ toolOverrides: { [writeTool.name]: "ALLOW_WRITES" } });
    expect(effectiveToolMode(selected, writeTool)).toBe("ALLOW_WRITES");
    expect(effectiveToolMode(snapshot({ dailyMode: "READ_ONLY" }), writeTool)).toBe("READ_ONLY");
  });

  it("hashes canonical arguments and redacts sensitive approval summaries", () => {
    expect(mcpArgumentsHash({ b: 2, a: 1 })).toBe(mcpArgumentsHash({ a: 1, b: 2 }));
    expect(safeArgumentsSummary({ taxRegistration: "123", accessToken: "abc", description: "Invoice" })).toEqual({
      taxRegistration: "[redacted]",
      accessToken: "[redacted]",
      description: "Invoice",
    });
  });
});
