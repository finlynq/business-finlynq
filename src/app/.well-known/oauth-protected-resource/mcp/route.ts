import { mcpResourceUrl, noStoreJson, oauthPublicOrigin, MCP_SUPPORTED_SCOPES } from "@/modules/mcp/protocol";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const origin = oauthPublicOrigin(request.url);
  return noStoreJson({
    resource: mcpResourceUrl(request.url).href,
    authorization_servers: [origin.origin],
    scopes_supported: MCP_SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "FinLynQ Accounting MCP",
    resource_documentation: new URL("/docs/remote-mcp", origin).href,
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
}
