import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function contentSecurityPolicy(nonce: string): string {
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
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ") + productionUpgrade;
}

function withContentSecurityPolicy(response: NextResponse, policy: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() ||
    (process.env.NODE_ENV === "production" ? "__Host-business_finlynq_session" : "business_finlynq_session");
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const workspaceRequest = request.nextUrl.pathname === "/app" ||
    request.nextUrl.pathname.startsWith("/app/");
  if (!workspaceRequest || request.cookies.has(cookieName())) {
    if (workspaceRequest) {
      requestHeaders.set("x-business-finlynq-request-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    }
    return withContentSecurityPolicy(
      NextResponse.next({ request: { headers: requestHeaders } }),
      policy,
    );
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return withContentSecurityPolicy(NextResponse.redirect(login, 307), policy);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)"],
};
