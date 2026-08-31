import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { consumeRateLimit, markDemoStepUp } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { identityLookupHash } from "@/security/identity-secret";

const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function post(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The sandbox confirmation could not be verified." }, { status: 403, headers: noStoreHeaders });
    }
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "demo") {
      return NextResponse.json({ error: "Open the public demo to continue." }, { status: 401, headers: noStoreHeaders });
    }

    const { ipHash } = requestFingerprints(request);
    const [sessionLimit, ipLimit] = await Promise.all([
      consumeRateLimit("demo-privileged-confirm-session", identityLookupHash(principal.sessionId), 6, 600),
      consumeRateLimit("demo-privileged-confirm-ip", ipHash, 20, 3600),
    ]);
    if (!sessionLimit.allowed || !ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many sandbox confirmations. Try again later." },
        {
          status: 429,
          headers: { ...noStoreHeaders, "Retry-After": String(Math.max(sessionLimit.retry_after_seconds, ipLimit.retry_after_seconds)) },
        },
      );
    }
    const marked = await markDemoStepUp(principal.sessionId, requestId);
    if (!marked) {
      return NextResponse.json({ error: "The sandbox confirmation expired. Reopen the demo and try again." }, { status: 409, headers: noStoreHeaders });
    }
    return NextResponse.json({ confirmed: true, sandboxOnly: true }, { headers: noStoreHeaders });
  } catch (error) {
    logRouteFailure("demo-step-up", requestId, error);
    return NextResponse.json({ error: "The sandbox confirmation could not be completed." }, { status: 409, headers: noStoreHeaders });
  }
}

export const POST = observeRouteHandler("demo-step-up", post);
