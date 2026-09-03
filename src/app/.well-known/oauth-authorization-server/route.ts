import { authorizationServerMetadata, noStoreJson } from "@/modules/mcp/protocol";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return noStoreJson(authorizationServerMetadata(request.url));
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
}
