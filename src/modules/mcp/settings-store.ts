import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { mcpToolNameRequiresStepUp } from "./connection-policy";
import { hasRecentStepUp, transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { parseAccessMode, parseToolOverrides, type McpAccessMode, type McpToolOverride } from "./protocol";

const modeSchema = z.enum(["OFF", "READ_ONLY", "CONFIRM_WRITES", "ALLOW_WRITES"]);
const overrideSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  z.enum(["INHERIT", "OFF", "READ_ONLY", "CONFIRM_WRITES", "ALLOW_WRITES"]),
);

export const updateMcpConnectionSchema = z.object({
  connectionId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  dailyMode: modeSchema,
  setupMode: modeSchema,
  toolOverrides: overrideSchema.default({}),
}).strict();

export type PendingMcpApproval = Readonly<{
  id: string;
  connectionId: string;
  clientName: string;
  toolName: string;
  argumentsSummary: Readonly<Record<string, unknown>>;
  requestedAt: string;
  expiresAt: string;
}>;

function settingsContext(principal: SessionPrincipal, action: string) {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `mcp-settings:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI" as const,
    reason: action,
    ...(principal.sessionMode === "demo" ? { demoWriteAuthorized: false } : {}),
  };
}

function assertRealUser(principal: SessionPrincipal): void {
  if (principal.sessionMode !== "real") throw new Error("MCP connections are unavailable in demo sessions");
}

export async function updateMcpConnectionSettings(
  principal: SessionPrincipal,
  unparsed: z.input<typeof updateMcpConnectionSchema>,
): Promise<Readonly<{
  connectionId: string;
  dailyMode: McpAccessMode;
  setupMode: McpAccessMode;
  toolOverrides: Readonly<Record<string, McpToolOverride>>;
  version: number;
}>> {
  assertRealUser(principal);
  const input = updateMcpConnectionSchema.parse(unparsed);
  const allowsDirectWrites = input.dailyMode === "ALLOW_WRITES" ||
    input.setupMode === "ALLOW_WRITES" ||
    Object.values(input.toolOverrides).some((mode) => mode === "ALLOW_WRITES");
  const elevatesAutonomy = input.dailyMode === "ALLOW_WRITES" ||
    input.setupMode === "CONFIRM_WRITES" || input.setupMode === "ALLOW_WRITES" ||
    Object.values(input.toolOverrides).some((mode) => mode === "ALLOW_WRITES");
  if (elevatesAutonomy && !hasRecentStepUp(principal)) {
    throw new Error("Recent MFA verification is required to enable autonomous daily writes or any setup writes");
  }
  return withTenantTransaction(settingsContext(principal, "Update own MCP connection policy"), async (client) => {
    const result = await client.query<{
      id: string;
      daily_mode: string;
      setup_mode: string;
      tool_overrides: unknown;
      version: number;
    }>(
      `UPDATE mcp_connections
       SET daily_mode = $1, setup_mode = $2, tool_overrides = $3::jsonb,
         direct_write_session_id = $4, direct_write_step_up_expires_at = $5,
         version = version + 1
       WHERE organization_id = $6 AND user_id = $7 AND id = $8
         AND revoked_at IS NULL AND version = $9
       RETURNING id, daily_mode, setup_mode, tool_overrides, version`,
      [
        input.dailyMode,
        input.setupMode,
        JSON.stringify(input.toolOverrides),
        allowsDirectWrites ? principal.sessionId : null,
        allowsDirectWrites ? principal.stepUpExpiresAt : null,
        principal.organizationId,
        principal.userId,
        input.connectionId,
        input.expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("The MCP connection changed or is no longer active; reload before retrying");
    return {
      connectionId: row.id,
      dailyMode: parseAccessMode(row.daily_mode),
      setupMode: parseAccessMode(row.setup_mode),
      toolOverrides: parseToolOverrides(row.tool_overrides),
      version: row.version,
    };
  });
}

export async function revokeMcpConnection(principal: SessionPrincipal, connectionId: string): Promise<boolean> {
  assertRealUser(principal);
  const selectedId = z.uuid().parse(connectionId);
  return withTenantTransaction(settingsContext(principal, "Revoke own MCP connection"), async (client) => {
    const revoked = await client.query<{ id: string }>(
      `UPDATE mcp_connections SET revoked_at = coalesce(revoked_at, now()), version = version + 1
       WHERE organization_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL
       RETURNING id`,
      [principal.organizationId, principal.userId, selectedId],
    );
    if (!revoked.rows[0]) return false;
    await Promise.all([
      client.query(
        `UPDATE mcp_access_tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE organization_id = $1 AND user_id = $2 AND connection_id = $3`,
        [principal.organizationId, principal.userId, selectedId],
      ),
      client.query(
        `UPDATE mcp_refresh_tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE organization_id = $1 AND user_id = $2 AND connection_id = $3`,
        [principal.organizationId, principal.userId, selectedId],
      ),
      client.query(
        `UPDATE mcp_approvals SET status = 'REJECTED', decided_at = now()
         WHERE organization_id = $1 AND user_id = $2 AND connection_id = $3
           AND status IN ('PENDING','APPROVED')`,
        [principal.organizationId, principal.userId, selectedId],
      ),
    ]);
    return true;
  });
}

export async function listPendingMcpApprovals(principal: SessionPrincipal): Promise<readonly PendingMcpApproval[]> {
  assertRealUser(principal);
  return withTenantTransaction(settingsContext(principal, "List own MCP approvals"), async (client) => {
    await client.query(
      `UPDATE mcp_approvals SET status = 'EXPIRED', decided_at = now()
       WHERE organization_id = $1 AND user_id = $2
         AND status IN ('PENDING','APPROVED') AND expires_at <= now()`,
      [principal.organizationId, principal.userId],
    );
    const result = await client.query<{
      id: string;
      connection_id: string;
      client_name: string;
      tool_name: string;
      arguments_summary: unknown;
      requested_at: Date;
      expires_at: Date;
    }>(
      `SELECT approval.id, approval.connection_id, connection.client_name,
         approval.tool_name, approval.arguments_summary,
         approval.requested_at, approval.expires_at
       FROM mcp_approvals approval
       JOIN mcp_connections connection
         ON connection.organization_id = approval.organization_id
        AND connection.id = approval.connection_id
        AND connection.user_id = approval.user_id
        AND connection.revoked_at IS NULL
       WHERE approval.organization_id = $1 AND approval.user_id = $2
         AND approval.status = 'PENDING' AND approval.expires_at > now()
       ORDER BY approval.requested_at DESC`,
      [principal.organizationId, principal.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      clientName: row.client_name,
      toolName: row.tool_name,
      argumentsSummary: row.arguments_summary && typeof row.arguments_summary === "object" && !Array.isArray(row.arguments_summary)
        ? row.arguments_summary as Record<string, unknown>
        : {},
      requestedAt: row.requested_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  });
}

export async function decideMcpApproval(
  principal: SessionPrincipal,
  input: Readonly<{ approvalId: string; decision: "APPROVED" | "REJECTED" }>,
): Promise<boolean> {
  assertRealUser(principal);
  const approvalId = z.uuid().parse(input.approvalId);
  return withTenantTransaction(settingsContext(principal, `${input.decision === "APPROVED" ? "Approve" : "Reject"} MCP write`), async (client) => {
    const current = await client.query<{ tool_name: string }>(
      `SELECT tool_name FROM mcp_approvals
       WHERE organization_id = $1 AND user_id = $2 AND id = $3
         AND status = 'PENDING' AND expires_at > now()
       FOR UPDATE`,
      [principal.organizationId, principal.userId, approvalId],
    );
    const approval = current.rows[0];
    if (!approval) return false;
    const requiresStepUp = mcpToolNameRequiresStepUp(approval.tool_name);
    if (input.decision === "APPROVED" && requiresStepUp && !hasRecentStepUp(principal)) {
      throw new Error("Recent MFA verification is required to approve this high-assurance accounting change");
    }
    const result = await client.query<{ id: string }>(
      `UPDATE mcp_approvals SET status = $1, decided_at = now(),
         mfa_session_id = $5, mfa_step_up_expires_at = $6
       WHERE organization_id = $2 AND user_id = $3 AND id = $4 AND status = 'PENDING'
       RETURNING id`,
      [
        input.decision,
        principal.organizationId,
        principal.userId,
        approvalId,
        input.decision === "APPROVED" && requiresStepUp ? principal.sessionId : null,
        input.decision === "APPROVED" && requiresStepUp ? principal.stepUpExpiresAt : null,
      ],
    );
    return Boolean(result.rows[0]);
  });
}
