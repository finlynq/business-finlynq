import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { consumeRateLimit, logoutAllSessions } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { clearSessionCookie, requestPrincipal } from "@/modules/identity/session";
import { clearTrustedBrowserCookie } from "@/modules/identity/trusted-browser";
import { identityLookupHash } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function removeAll(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
    }
    const { ipHash } = requestFingerprints(request);
    const limit = await consumeRateLimit(
      "logout-all-hour",
      identityLookupHash(`logout-all|${principal.userId}|${principal.organizationId}|${ipHash}`),
      10,
      3600,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many security changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(limit.retry_after_seconds) } },
      );
    }
    const revoked = await logoutAllSessions({
      sessionId: principal.sessionId,
      requestId,
    });
    const response = NextResponse.json({ success: true, revoked }, { headers });
    clearSessionCookie(response);
    clearTrustedBrowserCookie(response);
    return response;
  } catch (error) {
    logRouteFailure("session-revocation", requestId, error);
    return NextResponse.json(
      { error: "Sessions could not be revoked." },
      { status: 503, headers },
    );
  }
}

export const DELETE = observeRouteHandler("session-revocation", removeAll);
