import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { consumeRateLimit, revokeTrustedBrowser } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { clearTrustedBrowserCookie } from "@/modules/identity/trusted-browser";
import { identityLookupHash } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const idSchema = z.uuid();

async function remove(
  request: NextRequest,
  context: { params: Promise<{ browserId: string }> },
) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
    }
    const parsedId = idSchema.safeParse((await context.params).browserId);
    if (!parsedId.success) {
      return NextResponse.json({ error: "The trusted browser is unavailable." }, { status: 404, headers });
    }
    const { ipHash } = requestFingerprints(request);
    const keyHash = identityLookupHash(
      `trusted-browser-revoke|${principal.userId}|${principal.organizationId}|${ipHash}`,
    );
    const limit = await consumeRateLimit("trusted-browser-revoke-hour", keyHash, 60, 3600);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many security changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(limit.retry_after_seconds) } },
      );
    }
    const revoked = await revokeTrustedBrowser({
      sessionId: principal.sessionId,
      trustedBrowserId: parsedId.data,
      requestId,
    });
    if (!revoked) {
      return NextResponse.json({ error: "The trusted browser is unavailable." }, { status: 404, headers });
    }
    const response = NextResponse.json({ success: true }, { headers });
    // Clearing this browser's trust cookie is conservative. If the user revoked
    // another listed browser, this browser can be trusted again after MFA.
    clearTrustedBrowserCookie(response);
    return response;
  } catch (error) {
    logRouteFailure("trusted-browser-management", requestId, error);
    return NextResponse.json(
      { error: "The trusted browser could not be revoked." },
      { status: 503, headers },
    );
  }
}

export const DELETE = observeRouteHandler("trusted-browser-management", remove);
