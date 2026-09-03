import type { McpServer, CallToolResult, JSONValue } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpAuthorizationSnapshot, McpToolPolicy } from "./connection-policy";
import { authorizeMcpWrite, isMcpToolVisible } from "./connection-policy";
import { beginMcpExecution, finishMcpExecution } from "./execution-store";
import { mcpSessionPrincipal, type McpConnectionPrincipal } from "./oauth-store";

export type McpToolRuntime = Readonly<{
  principal: McpConnectionPrincipal;
  snapshot: McpAuthorizationSnapshot;
  requestId: string;
  requestUrl?: string;
  sessionPrincipal: ReturnType<typeof mcpSessionPrincipal>;
}>;

export type McpToolDefinition = Readonly<{
  policy: McpToolPolicy;
  title: string;
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  destructive: boolean;
  openWorld: boolean;
  invoke: (args: unknown, runtime: McpToolRuntime) => unknown | Promise<unknown>;
}>;

export function defineMcpTool<TSchema extends z.ZodType<Record<string, unknown>>>(input: Readonly<{
  policy: McpToolPolicy;
  title: string;
  description: string;
  inputSchema: TSchema;
  destructive?: boolean;
  openWorld?: boolean;
  invoke: (args: z.output<TSchema>, runtime: McpToolRuntime) => unknown | Promise<unknown>;
}>): McpToolDefinition {
  return {
    policy: input.policy,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    destructive: input.destructive ?? false,
    openWorld: input.openWorld ?? false,
    invoke: (args, runtime) => input.invoke(input.inputSchema.parse(args), runtime),
  };
}

function toJsonValue(value: unknown): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return String(value);
}

function successResult(result: unknown): CallToolResult {
  const envelope = { status: "succeeded", result: toJsonValue(result) };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function approvalResult(approval: Readonly<{
  approvalId?: string;
  approvalUrl?: string;
  expiresAt?: string;
}>): CallToolResult {
  const envelope = {
    status: "approval_required",
    approvalId: approval.approvalId ?? "",
    approvalUrl: approval.approvalUrl ?? "",
    expiresAt: approval.expiresAt ?? "",
    instruction: "Ask the user to open the approval URL, review the exact write, approve it, then retry this tool with identical arguments.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function toolError(error: unknown): Readonly<{ code: string; message: string }> {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  if (typeof candidate?.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
    return { code: "MCP_DATABASE_REJECTED", message: "The accounting operation was rejected by an integrity or concurrency control" };
  }
  const code = typeof candidate?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(candidate.code)
    ? candidate.code
    : "MCP_OPERATION_FAILED";
  const rawMessage = typeof candidate?.message === "string" ? candidate.message : "The accounting operation could not be completed";
  return { code, message: rawMessage.replace(/[\r\n]+/g, " ").slice(0, 700) };
}

function errorResult(error: unknown): CallToolResult {
  const failure = toolError(error);
  const envelope = { status: "failed", error: failure };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

export function registerMcpTools(
  server: McpServer,
  snapshot: McpAuthorizationSnapshot,
  definitions: readonly McpToolDefinition[],
  requestUrl?: string,
): void {
  for (const definition of definitions) {
    if (!isMcpToolVisible(snapshot, definition.policy)) continue;
    server.registerTool(definition.policy.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: {
        readOnlyHint: definition.policy.access === "READ",
        destructiveHint: definition.destructive,
        idempotentHint: definition.policy.access === "READ",
        openWorldHint: definition.openWorld,
      },
      _meta: {
        "finlynq/toolGroup": definition.policy.group,
        "finlynq/access": definition.policy.access,
      },
    }, async (args) => {
      let execution;
      let approvalId: string | undefined;
      let delegatedSessionId: string | undefined;
      let stepUpExpiresAt: string | undefined;
      try {
        execution = await beginMcpExecution(snapshot, definition.policy, args);
        if (definition.policy.access === "WRITE") {
          const authorization = await authorizeMcpWrite(snapshot, definition.policy, args, requestUrl);
          if (!authorization.allowed) {
            await finishMcpExecution(snapshot, execution, {
              status: "APPROVAL_REQUIRED",
              approvalId: authorization.approvalId,
              result: authorization,
            });
            return approvalResult(authorization);
          }
          approvalId = authorization.approvalId;
          delegatedSessionId = authorization.delegatedSessionId;
          stepUpExpiresAt = authorization.stepUpExpiresAt;
        }
        const result = await definition.invoke(args, {
          principal: snapshot.principal,
          snapshot,
          requestId: execution.requestId,
          requestUrl,
          sessionPrincipal: mcpSessionPrincipal(snapshot.principal, stepUpExpiresAt, delegatedSessionId),
        });
        await finishMcpExecution(snapshot, execution, { status: "SUCCEEDED", approvalId, result });
        return successResult(result);
      } catch (error) {
        if (execution) {
          try {
            await finishMcpExecution(snapshot, execution, {
              status: "FAILED",
              errorCode: toolError(error).code,
            });
          } catch {
            // Preserve the domain failure. Accounting writes also carry the
            // repository's immutable business-audit events inside their own transaction.
          }
        }
        return errorResult(error);
      }
    });
  }
}
