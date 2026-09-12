import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { consumeRateLimit } from "@/modules/identity/auth-store";
import {
  createOidcAuthorization,
  loadOidcConfiguration,
  type OidcIntent,
  oidcSignupEnabled,
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

function oidcError(code: string, intent: OidcIntent): NextResponse {
  const location = new URL(
    intent === "signup" ? "/signup" : intent === "signup-accept" ? "/complete-signup" : "/login",
    configuredAppOrigin(),
  );
  if (intent === "signup-accept") location.searchParams.set("method", "microsoft");
  location.searchParams.set(intent === "login" ? "ssoError" : "microsoftError", code);
  const response = NextResponse.redirect(location, 303);
  for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
  return response;
}

async function get(request: NextRequest) {
  if (isSpeculativeNavigation(request)) return new NextResponse(null, { status: 204, headers: noStoreHeaders });
  const intentValue = request.nextUrl.searchParams.get("intent");
  const intent: OidcIntent = intentValue === "signup" || intentValue === "signup-accept"
    ? intentValue
    : "login";
  if (intentValue !== null && !["login", "signup", "signup-accept"].includes(intentValue)) {
    return oidcError("rejected", "login");
  }
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true" || process.env.AUTH_OIDC_ENABLED !== "true") {
    return oidcError("disabled", intent);
  }
  if (intent !== "login" && !oidcSignupEnabled()) return oidcError("disabled", intent);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return oidcError("unavailable", intent);
  const requestId = requestIdFor(request);
  try {
    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real" && intent !== "signup-accept") {
      return NextResponse.redirect(new URL("/app", configuredAppOrigin()), 303);
    }
    const { ipHash } = requestFingerprints(request);
    const rate = await consumeRateLimit(`oidc-${intent}-ip-minute`, ipHash, 10, 60);
    if (!rate.allowed) {
      const response = oidcError("rate-limited", intent);
      response.headers.set("Retry-After", String(rate.retry_after_seconds));
      return response;
    }
    const configuration = loadOidcConfiguration();
    const authorization = createOidcAuthorization(
      configuration,
      safeAppPath(request.nextUrl.searchParams.get("next")),
      { intent },
    );
    const response = NextResponse.redirect(authorization.location, 303);
    for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
    setOidcLoginCookie(response, authorization.loginCookie);
    return response;
  } catch (error) {
    logRouteFailure("oidc-login", requestId, error);
    return oidcError("unavailable", intent);
  }
}

export const GET = observeRouteHandler("oidc-login", get);
