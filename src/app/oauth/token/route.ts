import { exchangeAuthorizationCode, exchangeRefreshToken } from "@/modules/mcp/oauth-store";
import { readFormBody } from "@/modules/mcp/oauth-http";
import { McpOAuthError, noStoreJson, oauthErrorResponse, parseRequestedScopes } from "@/modules/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readFormBody(request);
    const grantType = form.get("grant_type");
    const clientId = form.get("client_id")?.trim();
    const resource = form.get("resource")?.trim();
    if (!clientId || !resource) throw new McpOAuthError("invalid_request", "client_id and resource are required");
    let tokens;
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const codeVerifier = form.get("code_verifier");
      if (!code || !redirectUri || !codeVerifier) throw new McpOAuthError("invalid_request", "code, redirect_uri, and code_verifier are required");
      tokens = await exchangeAuthorizationCode({ code, clientId, redirectUri, resource, codeVerifier });
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) throw new McpOAuthError("invalid_request", "refresh_token is required");
      const requestedScopes = form.has("scope") ? parseRequestedScopes(form.get("scope")) : undefined;
      tokens = await exchangeRefreshToken({ refreshToken, clientId, resource, requestedScopes });
    } else {
      throw new McpOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported");
    }
    return noStoreJson({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    });
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
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}
