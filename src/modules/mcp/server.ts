import "server-only";
import { createHash } from "node:crypto";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { z } from "zod";

import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { DAILY_MCP_TOOLS } from "./daily-tools";
import { ASSET_MCP_TOOLS } from "./asset-tools";
import { INBOX_MCP_TOOLS } from "./inbox-tools";
import { STATEMENT_MCP_TOOLS } from "./statement-tools";
import { loadMcpAuthorizationSnapshot } from "./connection-policy";
import {
  verifyAccessToken,
  type McpConnectionPrincipal,
} from "./oauth-store";
import { mcpResourceUrl } from "./protocol";
import { SETUP_MCP_TOOLS } from "./setup-tools";
import { SHARED_MCP_TOOLS } from "./shared-tools";
import { EMAIL_MCP_TOOLS } from "./email-tools";
import { registerMcpTools } from "./tool-types";

export const ALL_MCP_TOOLS = [...SHARED_MCP_TOOLS, ...DAILY_MCP_TOOLS, ...ASSET_MCP_TOOLS, ...INBOX_MCP_TOOLS, ...STATEMENT_MCP_TOOLS, ...SETUP_MCP_TOOLS, ...EMAIL_MCP_TOOLS] as const;

export const MCP_TOOL_CATALOG_REVISION = createHash("sha256").update(JSON.stringify(
  [...ALL_MCP_TOOLS]
    .sort((left, right) => left.policy.name.localeCompare(right.policy.name))
    .map((tool) => ({
      name: tool.policy.name,
      group: tool.policy.group,
      access: tool.policy.access,
      permission: tool.policy.permission ?? null,
      permissionsAny: tool.policy.permissionsAny ?? null,
      title: tool.title,
      description: tool.description,
      destructive: tool.destructive,
      idempotent: tool.idempotent,
      openWorld: tool.openWorld,
      // The wire contract is the schema input. Some tools normalize strings
      // with Zod transforms, whose output side is intentionally not JSON
      // Schema-representable.
      inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }),
    })),
)).digest("hex");

function principalFromAuthInfo(authInfo: AuthInfo | undefined): McpConnectionPrincipal {
  const value = authInfo?.extra?.finlynqPrincipal;
  if (!value || typeof value !== "object") throw new Error("Authenticated MCP principal is missing");
  return value as McpConnectionPrincipal;
}

const handler = createMcpHandler(async (context) => {
  const principal = principalFromAuthInfo(context.authInfo);
  const snapshot = await loadMcpAuthorizationSnapshot(principal);
  const server = new McpServer({
    name: "business-finlynq-accounting",
    version: `1.0.0+catalog.${MCP_TOOL_CATALOG_REVISION.slice(0, 12)}`,
  }, {
    capabilities: { tools: { listChanged: true } },
    instructions: "Act only within the visible FinLynQ tools. Start with the connection capabilities tool, then load accounting or setup context. Never invent IDs or retry a write with changed arguments after user approval.",
  });
  registerMcpTools(server, snapshot, ALL_MCP_TOOLS, context.requestInfo?.url);
  return server;
}, {
  legacy: "stateless",
  responseMode: "auto",
  onerror(error) {
    console.error("MCP request failed", { name: error.name, message: error.message.slice(0, 500) });
  },
});

export async function handleMcpRequest(request: Request): Promise<Response> {
  const resource = mcpResourceUrl(request.url);
  const gate = requireBearerAuth({
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    verifier: {
      async verifyAccessToken(rawToken): Promise<AuthInfo> {
        try {
          const principal = await verifyAccessToken(rawToken, resource.href);
          return {
            token: rawToken,
            clientId: principal.clientId,
            scopes: [...principal.scopes],
            expiresAt: Math.floor(principal.tokenExpiresAt.getTime() / 1000),
            resource,
            extra: { finlynqPrincipal: principal },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "The bearer token is invalid";
          throw new OAuthError(OAuthErrorCode.InvalidToken, message);
        }
      },
    },
  });
  const authorization = await gate(request);
  if (authorization instanceof Response) return authorization;
  let boundedRequest = request;
  if (request.method === "POST") {
    try {
      const body = await readBoundedJson(request, 3 * 1024 * 1024);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      boundedRequest = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
    } catch (error) {
      if (!(error instanceof MutationBodyError)) throw error;
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: error.message } },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    }
  }
  const response = await handler.fetch(boundedRequest, { authInfo: authorization });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Authorization, MCP-Protocol-Version");
  headers.set("x-finlynq-mcp-catalog-revision", MCP_TOOL_CATALOG_REVISION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
