import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { actorHasActiveOrganizationRole } from "@/modules/identity/authorization";
import { hasRecentStepUp, transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";

export const agentApprovalPolicyChangeSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type AgentApprovalPolicy = Readonly<{
  enabled: boolean;
  version: number;
  enabledBy: string | null;
  enabledAt: string | null;
  ownerCanChange: boolean;
  scope: "ALL_MCP_CONNECTIONS";
}>;

function context(principal: SessionPrincipal, reason: string) {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `agent-approval-policy:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI" as const,
    reason,
  };
}

export async function readAgentApprovalPolicy(principal: SessionPrincipal): Promise<AgentApprovalPolicy> {
  if (principal.sessionMode !== "real") return {
    enabled: false, version: 0, enabledBy: null, enabledAt: null,
    ownerCanChange: false, scope: "ALL_MCP_CONNECTIONS",
  };
  return withTenantTransaction(context(principal, "Read agent approval policy"), async (client) => {
    const [result, ownerCanChange] = await Promise.all([
      client.query<{ enabled: boolean; version: number; enabled_by: string | null; enabled_at: Date | null }>(
        "SELECT enabled,version,enabled_by,enabled_at FROM mcp_agent_self_approval_policy WHERE organization_id=$1",
        [principal.organizationId],
      ),
      actorHasActiveOrganizationRole(client, {
        organizationId: principal.organizationId, actorId: principal.userId, roleKeys: ["OWNER"],
      }),
    ]);
    const row = result.rows[0];
    return {
      enabled: row?.enabled ?? false,
      version: row?.version ?? 0,
      enabledBy: row?.enabled_by ?? null,
      enabledAt: row?.enabled_at?.toISOString() ?? null,
      ownerCanChange,
      scope: "ALL_MCP_CONNECTIONS" as const,
    };
  });
}

export async function changeAgentApprovalPolicy(
  principal: SessionPrincipal,
  unparsed: z.input<typeof agentApprovalPolicyChangeSchema>,
): Promise<AgentApprovalPolicy> {
  if (principal.sessionMode !== "real") throw new Error("Agent approval policy is unavailable in demo sessions");
  const command = agentApprovalPolicyChangeSchema.parse(unparsed);
  if (command.enabled && !hasRecentStepUp(principal)) {
    throw new Error("Recent MFA verification is required to enable agent self-approval");
  }
  return withTenantTransaction(context(principal, command.enabled ? "Enable agent self-approval" : "Revoke agent self-approval"), async (client) => {
    const result = await client.query<{ policy: {
      enabled: boolean; version: number; enabledBy: string | null; enabledAt: string | null;
    } }>("SELECT app.set_mcp_agent_self_approval($1,$2) AS policy", [command.enabled, command.expectedVersion]);
    const row = result.rows[0]?.policy;
    if (!row) throw new Error("Agent approval policy could not be saved");
    return { ...row, ownerCanChange: true, scope: "ALL_MCP_CONNECTIONS" as const };
  });
}
