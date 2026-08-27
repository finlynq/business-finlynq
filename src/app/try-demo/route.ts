import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { consumeRateLimit, issueDemoSession } from "@/modules/identity/auth-store";
import { configuredAppOrigin, isSpeculativeNavigation, requestFingerprints } from "@/modules/identity/request-security";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { clearSessionCookie, createOpaqueToken, requestPrincipal, sessionCookieName, setSessionCookie } from "@/modules/identity/session";
import { identityLookupHash } from "@/security/identity-secret";

function loginError(code: string): NextResponse {
  const url = new URL("/login", configuredAppOrigin());
  url.searchParams.set("demoError", code);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: NextRequest) {
  if (isSpeculativeNavigation(request)) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  if (process.env.DEMO_LOGIN_ENABLED !== "true") return loginError("disabled");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return loginError("unavailable");

  try {
    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real") return NextResponse.redirect(new URL("/app", configuredAppOrigin()), 303);
    if (existing?.sessionMode === "demo") return NextResponse.redirect(new URL(safeAppPath(request.nextUrl.searchParams.get("next")), configuredAppOrigin()), 303);
    if (request.cookies.has(sessionCookieName())) {
      const response = loginError("stale-session");
      clearSessionCookie(response);
      return response;
    }

    const { ipHash, userAgentHash } = requestFingerprints(request);
    const [rate, globalRate] = await Promise.all([
      consumeRateLimit("demo-login-ip-minute", ipHash, 10, 60),
      consumeRateLimit("demo-login-global-minute", identityLookupHash("demo-sandbox-global-claim"), 60, 60),
    ]);
    if (!rate.allowed || !globalRate.allowed) {
      const response = loginError("rate-limited");
      response.headers.set("Retry-After", String(Math.max(rate.retry_after_seconds, globalRate.retry_after_seconds)));
      return response;
    }

    const token = createOpaqueToken();
    const issued = await issueDemoSession({ tokenHash: token.hash, ipHash, userAgentHash, requestId: randomUUID() });
    if (!issued) return loginError("unavailable");
    const response = NextResponse.redirect(new URL(safeAppPath(request.nextUrl.searchParams.get("next")), configuredAppOrigin()), 303);
    response.headers.set("Cache-Control", "private, no-store");
    setSessionCookie(response, token.raw, 60 * 60);
    return response;
  } catch (error) {
    console.error("Business Finlynq demo login failed", { error });
    return loginError("unavailable");
  }
}
