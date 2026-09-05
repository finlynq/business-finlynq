import { NextRequest } from "next/server";
import { z } from "zod";
import { consumeRateLimit } from "@/modules/identity/auth-store";
import { requestFingerprints } from "@/modules/identity/request-security";
import { validateRedirectUri } from "@/modules/mcp/oauth-http";
import { registerOAuthClient } from "@/modules/mcp/oauth-store";
import { McpOAuthError, noStoreJson, oauthErrorResponse } from "@/modules/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).passthrough();

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { ipHash } = requestFingerprints(request);
    const rateLimit = await consumeRateLimit("mcp-oauth-registration-minute", ipHash, 20, 60);
    if (!rateLimit.allowed) throw new McpOAuthError("slow_down", "Too many client registrations; try again later", 429);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 32_768) throw new McpOAuthError("invalid_client_metadata", "Registration request is too large", 413);
    const serialized = await request.text();
    if (Buffer.byteLength(serialized, "utf8") > 32_768) throw new McpOAuthError("invalid_client_metadata", "Registration request is too large", 413);
    let metadata: unknown;
    try { metadata = JSON.parse(serialized); } catch { throw new McpOAuthError("invalid_client_metadata", "Registration request must be valid JSON"); }
    const parsed = registrationSchema.safeParse(metadata);
    if (!parsed.success) throw new McpOAuthError("invalid_client_metadata", "OAuth client metadata is invalid");
    const grantTypes = parsed.data.grant_types ?? ["authorization_code", "refresh_token"];
    const responseTypes = parsed.data.response_types ?? ["code"];
    if (grantTypes.some((value) => value !== "authorization_code" && value !== "refresh_token") ||
        responseTypes.length !== 1 || responseTypes[0] !== "code" ||
        (parsed.data.token_endpoint_auth_method ?? "none") !== "none") {
      throw new McpOAuthError("invalid_client_metadata", "Only public authorization-code clients with PKCE are supported");
    }
    const redirectUris = [...new Set(parsed.data.redirect_uris.map(validateRedirectUri))];
    const client = await registerOAuthClient({ clientName: parsed.data.client_name, redirectUris });
    return noStoreJson({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, { status: 201 });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
