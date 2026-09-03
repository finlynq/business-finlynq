import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import type { Permission } from "@/modules/identity/permissions";
import type { SessionPrincipal } from "@/modules/identity/session";
import type { McpConnectionPrincipal } from "./oauth-store";
import {
  MCP_OAUTH_SCOPES,
  mcpResourceUrl,
  parseAccessMode,
  parseToolOverrides,
  type McpAccessMode,
  type McpToolGroup,
} from "./protocol";

export type McpToolAccess = "READ" | "WRITE";

export type McpToolPolicy = Readonly<{
  name: string;
  group: McpToolGroup;
  access: McpToolAccess;
  permission?: Permission;
  permissionsAny?: readonly Permission[];
}>;

export type McpAuthorizationSnapshot = Readonly<{
  principal: McpConnectionPrincipal;
  permissions: ReadonlySet<string>;
  dailyMode: McpAccessMode;
  setupMode: McpAccessMode;
  toolOverrides: Readonly<Record<string, McpAccessMode | "INHERIT">>;
  directWriteSessionId: string | null;
  directWriteStepUpExpiresAt: Date | null;
  connectionVersion: number;
}>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function mcpArgumentsHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

export function safeArgumentsSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sensitive = /secret|password|token|credential|private|cipher|content.?base64|filename|setup.?url|registration|tax.?id/i;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitive.test(key)) {
      output[key] = "[redacted]";
    } else if (typeof entry === "string") {
      output[key] = entry.length > 240 ? `${entry.slice(0, 237)}...` : entry;
    } else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      output[key] = entry;
    } else if (Array.isArray(entry)) {
      output[key] = { itemCount: entry.length };
    } else if (entry && typeof entry === "object") {
      output[key] = { fields: Object.keys(entry as object).sort().slice(0, 30) };
    }
  }
  return output;
}

export async function loadMcpAuthorizationSnapshot(
  principal: McpConnectionPrincipal,
): Promise<McpAuthorizationSnapshot> {
  return withTenantTransaction({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.connectionId,
    sessionMode: "real",
    requestId: `mcp-catalog:${randomUUID()}`,
    authMethod: "oauth2.1+pkce",
    sourceSurface: "MCP",
    reason: "Resolve live MCP tool catalog",
  }, async (client) => {
    const connection = await client.query<{
      daily_mode: string;
      setup_mode: string;
      tool_overrides: unknown;
      direct_write_session_id: string | null;
      direct_write_step_up_expires_at: Date | null;
      scopes: string[];
      version: number;
    }>(
      `SELECT daily_mode, setup_mode, tool_overrides,
         direct_write_session_id, direct_write_step_up_expires_at,
         scopes, version
       FROM mcp_connections
       WHERE organization_id = $1 AND id = $2 AND user_id = $3
         AND client_id = $4 AND revoked_at IS NULL
       FOR SHARE`,
      [principal.organizationId, principal.connectionId, principal.userId, principal.clientId],
    );
    const selected = connection.rows[0];
    if (!selected) throw new Error("MCP connection is no longer active");
    const effectiveScopes = intersectMcpScopes(principal.scopes, selected.scopes);
    const permissions = await client.query<{ permission_key: string }>(
      `SELECT DISTINCT role_permission.permission_key
       FROM organization_memberships membership
       JOIN membership_roles membership_role
         ON membership_role.organization_id = membership.organization_id
        AND membership_role.membership_id = membership.id
       JOIN roles role
         ON role.organization_id = membership_role.organization_id
        AND role.id = membership_role.role_id AND role.active
       JOIN role_permissions role_permission
         ON role_permission.organization_id = role.organization_id
        AND role_permission.role_id = role.id
       WHERE membership.organization_id = $1 AND membership.user_id = $2
         AND membership.id = $3 AND membership.active`,
      [principal.organizationId, principal.userId, principal.membershipId],
    );
    return {
      principal: { ...principal, scopes: effectiveScopes },
      permissions: new Set(permissions.rows.map((row) => row.permission_key)),
      dailyMode: parseAccessMode(selected.daily_mode),
      setupMode: parseAccessMode(selected.setup_mode),
      toolOverrides: parseToolOverrides(selected.tool_overrides),
      directWriteSessionId: selected.direct_write_session_id,
      directWriteStepUpExpiresAt: selected.direct_write_step_up_expires_at,
      connectionVersion: selected.version,
    };
  });
}

export function intersectMcpScopes(tokenScopes: readonly string[], connectionScopes: readonly string[]): string[] {
  const granted = new Set(connectionScopes);
  return tokenScopes.filter((scope) => granted.has(scope));
}

export function mcpToolNameRequiresStepUp(toolName: string): boolean {
  return toolName.startsWith("finlynq_setup_") || toolName === "finlynq_daily_transition_bank_reconciliation";
}

export function effectiveToolMode(
  snapshot: McpAuthorizationSnapshot,
  tool: McpToolPolicy,
): McpAccessMode {
  if (tool.group === "SHARED") return "READ_ONLY";
  const inherited = tool.group === "DAILY" ? snapshot.dailyMode : snapshot.setupMode;
  const override = snapshot.toolOverrides[tool.name];
  return override && override !== "INHERIT" ? override : inherited;
}

export function isMcpToolVisible(
  snapshot: McpAuthorizationSnapshot,
  tool: McpToolPolicy,
): boolean {
  if (tool.permission && !snapshot.permissions.has(tool.permission)) return false;
  if (tool.permissionsAny && !tool.permissionsAny.some((permission) => snapshot.permissions.has(permission))) {
    return false;
  }
  if (tool.group === "SHARED") return true;
  const readScope = tool.group === "DAILY" ? MCP_OAUTH_SCOPES.dailyRead : MCP_OAUTH_SCOPES.setupRead;
  const writeScope = tool.group === "DAILY" ? MCP_OAUTH_SCOPES.dailyWrite : MCP_OAUTH_SCOPES.setupWrite;
  if (!snapshot.principal.scopes.includes(tool.access === "READ" ? readScope : writeScope)) return false;
  const mode = effectiveToolMode(snapshot, tool);
  if (mode === "OFF") return false;
  return tool.access === "READ" || mode === "CONFIRM_WRITES" || mode === "ALLOW_WRITES";
}

export type McpWriteAuthorization = Readonly<{
  allowed: boolean;
  approvalId?: string;
  approvalUrl?: string;
  expiresAt?: string;
  delegatedSessionId?: string;
  stepUpExpiresAt?: string;
}>;

function directWriteStepUpError(): Error & Readonly<{ code: "MCP_STEP_UP_REQUIRED" }> {
  return Object.assign(
    new Error("Refresh the direct-write permission with a recent MFA verification before retrying this high-assurance action"),
    { code: "MCP_STEP_UP_REQUIRED" as const },
  );
}

export async function authorizeMcpWrite(
  snapshot: McpAuthorizationSnapshot,
  tool: McpToolPolicy,
  args: unknown,
  requestUrl?: string,
): Promise<McpWriteAuthorization> {
  const mode = effectiveToolMode(snapshot, tool);
  const requiresStepUp = mcpToolNameRequiresStepUp(tool.name);
  if (mode === "ALLOW_WRITES") {
    if (!requiresStepUp) return { allowed: true };
    if (!snapshot.directWriteSessionId || !snapshot.directWriteStepUpExpiresAt ||
        snapshot.directWriteStepUpExpiresAt.getTime() <= Date.now()) {
      throw directWriteStepUpError();
    }
    return {
      allowed: true,
      delegatedSessionId: snapshot.directWriteSessionId,
      stepUpExpiresAt: snapshot.directWriteStepUpExpiresAt.toISOString(),
    };
  }
  if (mode !== "CONFIRM_WRITES") return { allowed: false };
  const argumentsHash = mcpArgumentsHash(args);
  return withTenantTransaction({
    organizationId: snapshot.principal.organizationId,
    actorId: snapshot.principal.userId,
    sessionId: snapshot.principal.connectionId,
    sessionMode: "real",
    requestId: `mcp-approval:${randomUUID()}`,
    authMethod: "oauth2.1+pkce",
    sourceSurface: "MCP",
    reason: `Authorize ${tool.name}`,
  }, async (client) => {
    const approved = await client.query<{ id: string; mfa_session_id: string | null; mfa_step_up_expires_at: Date | null }>(
      `SELECT id, mfa_session_id, mfa_step_up_expires_at FROM mcp_approvals
       WHERE organization_id = $1 AND user_id = $2 AND connection_id = $3
         AND tool_name = $4 AND arguments_hash = $5
         AND status = 'APPROVED' AND expires_at > now()
         AND (NOT $6::boolean OR (mfa_session_id IS NOT NULL AND mfa_step_up_expires_at > now()))
       ORDER BY decided_at DESC NULLS LAST
       LIMIT 1 FOR UPDATE`,
      [
        snapshot.principal.organizationId,
        snapshot.principal.userId,
        snapshot.principal.connectionId,
        tool.name,
        argumentsHash,
        requiresStepUp,
      ],
    );
    if (approved.rows[0]) {
      const consumed = await client.query<{ id: string }>(
        `UPDATE mcp_approvals SET status = 'CONSUMED', consumed_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'APPROVED'
         RETURNING id`,
        [snapshot.principal.organizationId, approved.rows[0].id],
      );
      if (consumed.rows[0]) {
        return {
          allowed: true,
          approvalId: consumed.rows[0].id,
          ...(requiresStepUp && approved.rows[0].mfa_session_id
            ? { delegatedSessionId: approved.rows[0].mfa_session_id }
            : {}),
          ...(requiresStepUp && approved.rows[0].mfa_step_up_expires_at
            ? { stepUpExpiresAt: approved.rows[0].mfa_step_up_expires_at.toISOString() }
            : {}),
        };
      }
    }
    const pending = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM mcp_approvals
       WHERE organization_id = $1 AND user_id = $2 AND connection_id = $3
         AND tool_name = $4 AND arguments_hash = $5
         AND status = 'PENDING' AND expires_at > now()
       ORDER BY requested_at DESC LIMIT 1`,
      [
        snapshot.principal.organizationId,
        snapshot.principal.userId,
        snapshot.principal.connectionId,
        tool.name,
        argumentsHash,
      ],
    );
    const expiresAt = pending.rows[0]?.expires_at ?? new Date(Date.now() + 15 * 60 * 1000);
    const approvalId = pending.rows[0]?.id ?? randomUUID();
    if (!pending.rows[0]) {
      await client.query(
        `INSERT INTO mcp_approvals (
           id, organization_id, user_id, connection_id, tool_name,
           arguments_hash, arguments_summary, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          approvalId,
          snapshot.principal.organizationId,
          snapshot.principal.userId,
          snapshot.principal.connectionId,
          tool.name,
          argumentsHash,
          JSON.stringify(safeArgumentsSummary(args)),
          expiresAt,
        ],
      );
    }
    const origin = mcpResourceUrl(requestUrl).origin;
    return {
      allowed: false,
      approvalId,
      approvalUrl: new URL(`/app/settings/mcp?approval=${encodeURIComponent(approvalId)}`, origin).href,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export type McpConnectionSettings = Readonly<{
  id: string;
  clientName: string;
  scopes: readonly string[];
  dailyMode: McpAccessMode;
  setupMode: McpAccessMode;
  toolOverrides: Readonly<Record<string, McpAccessMode | "INHERIT">>;
  authorizedAt: string;
  lastUsedAt: string | null;
  version: number;
}>;

export async function listUserMcpConnections(principal: SessionPrincipal): Promise<readonly McpConnectionSettings[]> {
  return withTenantTransaction({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `mcp-settings:${randomUUID()}`,
    authMethod: principal.sessionMode === "demo" ? "demo-link" : "password",
    sourceSurface: "UI",
    ...(principal.sessionMode === "demo" ? { demoWriteAuthorized: false } : {}),
  }, async (client) => {
    if (principal.sessionMode !== "real") return [];
    const result = await client.query<{
      id: string;
      client_name: string;
      scopes: string[];
      daily_mode: string;
      setup_mode: string;
      tool_overrides: unknown;
      authorized_at: Date;
      last_used_at: Date | null;
      version: number;
    }>(
      `SELECT id, client_name, scopes, daily_mode, setup_mode, tool_overrides,
         authorized_at, last_used_at, version
       FROM mcp_connections
       WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
       ORDER BY authorized_at DESC`,
      [principal.organizationId, principal.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientName: row.client_name,
      scopes: row.scopes,
      dailyMode: parseAccessMode(row.daily_mode),
      setupMode: parseAccessMode(row.setup_mode),
      toolOverrides: parseToolOverrides(row.tool_overrides),
      authorizedAt: row.authorized_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      version: row.version,
    }));
  });
}
