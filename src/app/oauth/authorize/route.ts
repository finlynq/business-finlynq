import type { NextRequest } from "next/server";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import {
  appendOAuthResult,
  escapeHtml,
  readFormBody,
  validateAuthorizationRequest,
} from "@/modules/mcp/oauth-http";
import { oauthAuthorizationContentSecurityPolicy } from "@/modules/mcp/oauth-csp";
import { createAuthorizationGrant } from "@/modules/mcp/oauth-store";
import { McpOAuthError, oauthErrorResponse } from "@/modules/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function continuationPath(search: string): string {
  return `/app/mcp/authorize${search}`;
}

function consentPage(input: Readonly<{
  clientName: string;
  organizationName: string;
  redirectUri: string;
  scopes: readonly string[];
  fields: URLSearchParams;
}>): Response {
  const hidden = [...input.fields.entries()].map(([name, value]) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  ).join("");
  const capabilities = input.scopes.map((scope) => {
    const description = scope === "mcp:daily:read" ? "Read daily accounting data and reports"
      : scope === "mcp:daily:write" ? "Create and change daily transactions, subject to your connection settings"
        : scope === "mcp:setup:read" ? "Read chart-of-accounts and accounting setup"
          : scope === "mcp:setup:write" ? "Change accounting setup, subject to your connection settings"
            : "Keep this connection signed in until you revoke it";
    return `<li><code>${escapeHtml(scope)}</code> — ${escapeHtml(description)}</li>`;
  }).join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize accounting connection</title></head>
<body><main><h1>Authorize accounting connection</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> wants to act as your current user in <strong>${escapeHtml(input.organizationName)}</strong>.</p>
<p>FinLynq will still check your live membership and role on every request. This connection never receives organization-administration, user-management, recovery, or banking credentials.</p>
<ul>${capabilities}</ul>
<p>Daily writes default to “confirm each write.” Setup tools default to off. You can change or revoke either group in FinLynq.</p>
<form method="post" action="/oauth/authorize">${hidden}<button type="submit" name="decision" value="allow">Authorize</button> <button type="submit" name="decision" value="deny">Deny</button></form>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      ...pageHeaders,
      "content-security-policy": oauthAuthorizationContentSecurityPolicy(input.redirectUri),
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const authorization = await validateAuthorizationRequest(request.nextUrl.searchParams, request.url);
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      const next = continuationPath(request.nextUrl.search);
      return Response.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, request.url), 302);
    }
    return consentPage({
      clientName: authorization.client.clientName,
      organizationName: principal.organizationName,
      redirectUri: authorization.redirectUri,
      scopes: authorization.scopes,
      fields: request.nextUrl.searchParams,
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!validateSameOriginMutation(request)) {
      throw new McpOAuthError("access_denied", "The authorization decision could not be verified", 403);
    }
    const form = await readFormBody(request);
    const authorization = await validateAuthorizationRequest(form, request.url);
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      throw new McpOAuthError("access_denied", "Sign in again before authorizing this connection", 401);
    }
    if (form.get("decision") !== "allow") {
      return Response.redirect(appendOAuthResult(authorization.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the connection request",
        state: authorization.state,
      }), 302);
    }
    const code = await createAuthorizationGrant({
      principal,
      client: authorization.client,
      redirectUri: authorization.redirectUri,
      resource: authorization.resource,
      scopes: authorization.scopes,
      codeChallenge: authorization.codeChallenge,
    });
    return Response.redirect(appendOAuthResult(authorization.redirectUri, { code, state: authorization.state }), 302);
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
