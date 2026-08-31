import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  consumeMfaEnrollmentLimits,
  consumeRateLimit,
  skipMfaEnrollment,
} from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";

const schema = z.object({ setupToken: z.string().min(32).max(200) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function post(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") {
      return NextResponse.json({ error: "Account activation is not enabled." }, { status: 403, headers });
    }

    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("mfa-enrollment-skip-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      return NextResponse.json({ error: "This account setup has expired. Request a new link." }, { status: 400, headers });
    }
    const setupTokenHash = hashOpaqueToken(parsed.data.setupToken);
    const tokenLimit = await consumeMfaEnrollmentLimits(setupTokenHash);
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Request a new account setup link." },
        { status: 429, headers: { ...headers, "Retry-After": String(tokenLimit.retry_after_seconds) } },
      );
    }
    const skipped = await skipMfaEnrollment(setupTokenHash, requestId);
    if (!skipped) {
      return NextResponse.json({ error: "This account setup is invalid, expired, or already complete." }, { status: 400, headers });
    }
    return NextResponse.json({ success: true, authentication: "PASSWORD_ONLY" }, { headers });
  } catch (error) {
    logRouteFailure("optional-mfa-activation", requestId, error);
    return NextResponse.json({ error: "Account activation is temporarily unavailable." }, { status: 503, headers });
  }
}

export const POST = observeRouteHandler("optional-mfa-activation", post);
