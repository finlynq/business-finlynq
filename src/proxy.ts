import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  normalizedRequestId,
  REQUEST_ID_HEADER,
  REQUEST_ID_INPUT_HEADER,
} from "@/observability/request-correlation";
import { oauthCallbackFormActionSource } from "@/modules/mcp/oauth-csp";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function contentSecurityPolicy(nonce: string, formActionSource: string | null): string {
  const developmentScriptPolicy = process.env.NODE_ENV === "development"
    ? " 'unsafe-eval'"
    : "";
  const productionUpgrade = process.env.NODE_ENV === "production"
    ? "; upgrade-insecure-requests"
    : "";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${developmentScriptPolicy}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${formActionSource ? ` ${formActionSource}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ") + productionUpgrade;
}

function withResponseHeaders(response: NextResponse, policy: string, requestId: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() ||
    (process.env.NODE_ENV === "production" ? "__Host-business_finlynq_session" : "business_finlynq_session");
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const requestId = normalizedRequestId(request.headers.get(REQUEST_ID_INPUT_HEADER)) ?? randomUUID();
  const formActionSource = request.method === "GET" && request.nextUrl.pathname === "/oauth/authorize"
    ? oauthCallbackFormActionSource(request.nextUrl.searchParams.get("redirect_uri"))
    : null;
  const policy = contentSecurityPolicy(nonce, formActionSource);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  requestHeaders.set(REQUEST_ID_INPUT_HEADER, requestId);

  const workspaceRequest = request.nextUrl.pathname === "/app" ||
    request.nextUrl.pathname.startsWith("/app/");
  if (!workspaceRequest || request.cookies.has(cookieName())) {
    if (workspaceRequest) {
      requestHeaders.set("x-business-finlynq-request-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    }
    return withResponseHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
      policy,
      requestId,
    );
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return withResponseHeaders(NextResponse.redirect(login, 307), policy, requestId);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)"],
};
