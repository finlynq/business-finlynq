import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  consumeRateLimit,
  revokeAllTrustedBrowsers,
  trustedBrowsersForSession,
} from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { clearTrustedBrowserCookie } from "@/modules/identity/trusted-browser";
import { identityLookupHash } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function get(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
    }
    const browsers = await trustedBrowsersForSession(principal.sessionId, requestId);
    return NextResponse.json({
      browsers: browsers.map((browser) => ({
        id: browser.id,
        label: browser.browser_label,
        createdAt: browser.created_at.toISOString(),
        lastUsedAt: browser.last_used_at?.toISOString() ?? null,
        expiresAt: browser.expires_at.toISOString(),
      })),
    }, { headers });
  } catch (error) {
    logRouteFailure("trusted-browser-management", requestId, error);
    return NextResponse.json(
      { error: "Trusted browsers are temporarily unavailable." },
      { status: 503, headers },
    );
  }
}

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
    const keyHash = identityLookupHash(
      `trusted-browser-revoke-all|${principal.userId}|${principal.organizationId}|${ipHash}`,
    );
    const limit = await consumeRateLimit("trusted-browser-revoke-all-hour", keyHash, 20, 3600);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many security changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(limit.retry_after_seconds) } },
      );
    }
    const revoked = await revokeAllTrustedBrowsers({
      sessionId: principal.sessionId,
      requestId,
    });
    const response = NextResponse.json({ success: true, revoked }, { headers });
    clearTrustedBrowserCookie(response);
    return response;
  } catch (error) {
    logRouteFailure("trusted-browser-management", requestId, error);
    return NextResponse.json(
      { error: "Trusted browsers could not be revoked." },
      { status: 503, headers },
    );
  }
}

export const GET = observeRouteHandler("trusted-browser-management", get);
export const DELETE = observeRouteHandler("trusted-browser-management", removeAll);
