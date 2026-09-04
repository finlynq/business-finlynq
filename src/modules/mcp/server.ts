import "server-only";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";

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
import { INBOX_MCP_TOOLS } from "./inbox-tools";
import { loadMcpAuthorizationSnapshot } from "./connection-policy";
import {
  verifyAccessToken,
  type McpConnectionPrincipal,
} from "./oauth-store";
import { mcpResourceUrl } from "./protocol";
import { SETUP_MCP_TOOLS } from "./setup-tools";
import { SHARED_MCP_TOOLS } from "./shared-tools";
import { registerMcpTools } from "./tool-types";

const allTools = [...SHARED_MCP_TOOLS, ...DAILY_MCP_TOOLS, ...INBOX_MCP_TOOLS, ...SETUP_MCP_TOOLS];

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
    version: "1.0.0",
  }, {
    capabilities: { tools: { listChanged: false } },
    instructions: "Act only within the visible FinLynQ tools. Start with the connection capabilities tool, then load accounting or setup context. Never invent IDs or retry a write with changed arguments after user approval.",
  });
  registerMcpTools(server, snapshot, allTools, context.requestInfo?.url);
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
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
