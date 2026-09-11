import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { consumeRateLimit } from "@/modules/identity/auth-store";
import {
  createOidcAuthorization,
  loadOidcConfiguration,
  setOidcLoginCookie,
} from "@/modules/identity/oidc";
import {
  configuredAppOrigin,
  isSpeculativeNavigation,
  requestFingerprints,
} from "@/modules/identity/request-security";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { requestPrincipal } from "@/modules/identity/session";

const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

function loginError(code: string): NextResponse {
  const location = new URL("/login", configuredAppOrigin());
  location.searchParams.set("ssoError", code);
  const response = NextResponse.redirect(location, 303);
  for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
  return response;
}

async function get(request: NextRequest) {
  if (isSpeculativeNavigation(request)) return new NextResponse(null, { status: 204, headers: noStoreHeaders });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true" || process.env.AUTH_OIDC_ENABLED !== "true") {
    return loginError("disabled");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return loginError("unavailable");
  const requestId = requestIdFor(request);
  try {
    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real") {
      return NextResponse.redirect(new URL("/app", configuredAppOrigin()), 303);
    }
    const { ipHash } = requestFingerprints(request);
    const rate = await consumeRateLimit("oidc-login-ip-minute", ipHash, 10, 60);
    if (!rate.allowed) {
      const response = loginError("rate-limited");
      response.headers.set("Retry-After", String(rate.retry_after_seconds));
      return response;
    }
    const configuration = loadOidcConfiguration();
    const authorization = createOidcAuthorization(
      configuration,
      safeAppPath(request.nextUrl.searchParams.get("next")),
    );
    const response = NextResponse.redirect(authorization.location, 303);
    for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
    setOidcLoginCookie(response, authorization.loginCookie);
    return response;
  } catch (error) {
    logRouteFailure("oidc-login", requestId, error);
    return loginError("unavailable");
  }
}

export const GET = observeRouteHandler("oidc-login", get);
