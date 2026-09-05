import "server-only";

import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import type { McpAuthorizationSnapshot, McpToolPolicy } from "./connection-policy";
import { mcpArgumentsHash, safeArgumentsSummary } from "./connection-policy";
import { isRetryableDatabaseError, McpRetryableError } from "./retryable";

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

const auditRetryDelays = [25, 75] as const;
async function retryAuditTransaction<T>(
  phase: "begin" | "finish",
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isRetryableDatabaseError(error)) throw error;
      const delay = auditRetryDelays[attempt];
      if (delay === undefined) {
        console.warn(JSON.stringify({
          event: "mcp.execution.retryable",
          phase,
          requestId,
          errorCode: "MCP_RETRYABLE",
          retryAfterSeconds: 1,
        }));
        throw new McpRetryableError("MCP execution auditing is temporarily busy. Retry after 1 second.", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export type McpExecution = Readonly<{ id: string; requestId: string }>;

export async function beginMcpExecution(
  snapshot: McpAuthorizationSnapshot,
  tool: McpToolPolicy,
  args: unknown,
): Promise<McpExecution> {
  const id = randomUUID();
  const requestId = `mcp-tool:${id}`;
  const argumentsHash = mcpArgumentsHash(args);
  const resultSummary = JSON.stringify({ input: safeArgumentsSummary(args) });
  await retryAuditTransaction("begin", requestId, () => withTenantTransaction(
    context(snapshot, requestId, `Execute ${tool.name}`),
    async (client) => {
      await client.query("SET LOCAL lock_timeout = '500ms'");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mcp_tool_executions (
           id, organization_id, user_id, connection_id, request_id,
           tool_name, tool_group, write_action, arguments_hash, status,
           result_summary
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STARTED',$10::jsonb)
         ON CONFLICT (organization_id, connection_id, request_id) DO NOTHING
         RETURNING id`,
        [
          id,
          snapshot.principal.organizationId,
          snapshot.principal.userId,
          snapshot.principal.connectionId,
          requestId,
          tool.name,
          tool.group,
          tool.access === "WRITE",
          argumentsHash,
          resultSummary,
        ],
      );
      if (inserted.rows[0]?.id === id) return;
      const replay = await client.query<{ id: string }>(
        `SELECT id FROM mcp_tool_executions
         WHERE organization_id = $1 AND connection_id = $2 AND request_id = $3
           AND id = $4 AND user_id = $5 AND tool_name = $6 AND tool_group = $7
           AND write_action = $8 AND arguments_hash = $9 AND status = 'STARTED'
           AND result_summary = $10::jsonb`,
        [
          snapshot.principal.organizationId,
          snapshot.principal.connectionId,
          requestId,
          id,
          snapshot.principal.userId,
          tool.name,
          tool.group,
          tool.access === "WRITE",
          argumentsHash,
          resultSummary,
        ],
      );
      if (replay.rows[0]?.id !== id) {
        throw Object.assign(new Error("MCP execution audit identifier collision"), { code: "MCP_AUDIT_INTEGRITY" });
      }
    },
  ));
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
  const resultSummary = JSON.stringify(input.result === undefined ? {} : safeArgumentsSummary({ result: input.result }));
  await retryAuditTransaction("finish", execution.requestId, () => withTenantTransaction(
    context(snapshot, `${execution.requestId}:finish`, `Finish MCP execution ${execution.id}`),
    async (client) => {
      await client.query("SET LOCAL lock_timeout = '500ms'");
      const updated = await client.query(
        `UPDATE mcp_tool_executions
         SET status = $1, approval_id = $2, result_summary = $3::jsonb,
           error_code = $4, completed_at = now()
         WHERE organization_id = $5 AND id = $6 AND status = 'STARTED'`,
        [
          input.status,
          input.approvalId ?? null,
          resultSummary,
          input.errorCode ?? null,
          snapshot.principal.organizationId,
          execution.id,
        ],
      );
      if (updated.rowCount === 1) return;
      const replay = await client.query<{ id: string }>(
        `SELECT id FROM mcp_tool_executions
         WHERE organization_id = $1 AND id = $2 AND status = $3
           AND approval_id IS NOT DISTINCT FROM $4::uuid
           AND result_summary = $5::jsonb
           AND error_code IS NOT DISTINCT FROM $6::text
           AND completed_at IS NOT NULL`,
        [
          snapshot.principal.organizationId,
          execution.id,
          input.status,
          input.approvalId ?? null,
          resultSummary,
          input.errorCode ?? null,
        ],
      );
      if (replay.rows[0]?.id !== execution.id) {
        throw Object.assign(new Error("MCP execution audit record could not be finalized consistently"), { code: "MCP_AUDIT_INTEGRITY" });
      }
    },
  ));
}
