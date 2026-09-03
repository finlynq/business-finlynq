import "server-only";

import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import type { McpAuthorizationSnapshot, McpToolPolicy } from "./connection-policy";
import { mcpArgumentsHash, safeArgumentsSummary } from "./connection-policy";

function context(snapshot: McpAuthorizationSnapshot, requestId: string, reason: string) {
  return {
    organizationId: snapshot.principal.organizationId,
    actorId: snapshot.principal.userId,
    sessionId: snapshot.principal.connectionId,
    sessionMode: "real" as const,
    requestId,
    authMethod: "oauth2.1+pkce",
    sourceSurface: "MCP" as const,
    reason,
  };
}

export type McpExecution = Readonly<{ id: string; requestId: string }>;

export async function beginMcpExecution(
  snapshot: McpAuthorizationSnapshot,
  tool: McpToolPolicy,
  args: unknown,
): Promise<McpExecution> {
  const id = randomUUID();
  const requestId = `mcp-tool:${randomUUID()}`;
  await withTenantTransaction(context(snapshot, requestId, `Execute ${tool.name}`), async (client) => {
    await client.query(
      `INSERT INTO mcp_tool_executions (
         id, organization_id, user_id, connection_id, request_id,
         tool_name, tool_group, write_action, arguments_hash, status,
         result_summary
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STARTED',$10::jsonb)`,
      [
        id,
        snapshot.principal.organizationId,
        snapshot.principal.userId,
        snapshot.principal.connectionId,
        requestId,
        tool.name,
        tool.group,
        tool.access === "WRITE",
        mcpArgumentsHash(args),
        JSON.stringify({ input: safeArgumentsSummary(args) }),
      ],
    );
  });
  return { id, requestId };
}

export async function finishMcpExecution(
  snapshot: McpAuthorizationSnapshot,
  execution: McpExecution,
  input: Readonly<{
    status: "APPROVAL_REQUIRED" | "SUCCEEDED" | "FAILED";
    approvalId?: string;
    result?: unknown;
    errorCode?: string;
  }>,
): Promise<void> {
  await withTenantTransaction(context(snapshot, `${execution.requestId}:finish`, `Finish MCP execution ${execution.id}`), async (client) => {
    const updated = await client.query(
      `UPDATE mcp_tool_executions
       SET status = $1, approval_id = $2, result_summary = $3::jsonb,
         error_code = $4, completed_at = now()
       WHERE organization_id = $5 AND id = $6 AND status = 'STARTED'`,
      [
        input.status,
        input.approvalId ?? null,
        JSON.stringify(input.result === undefined ? {} : safeArgumentsSummary({ result: input.result })),
        input.errorCode ?? null,
        snapshot.principal.organizationId,
        execution.id,
      ],
    );
    if (updated.rowCount !== 1) throw new Error("MCP execution audit record could not be finalized");
  });
}
