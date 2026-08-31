import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  consumeMfaEnrollmentLimits,
  consumeRateLimit,
  finishSessionMfaEnrollment,
  mfaSetupChallenge,
} from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import {
  createOpaqueToken,
  hashOpaqueToken,
  requestPrincipal,
  setSessionCookie,
} from "@/modules/identity/session";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({
  setupToken: z.string().min(32).max(200),
  otp: z.string().regex(/^\d{6}$/),
});
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function post(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") {
      return NextResponse.json({ error: "Authenticator enrollment is not enabled." }, { status: 403, headers });
    }
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
    }

    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("mfa-session-confirm-ip-hour", ipHash, 10, 3600);
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
      return NextResponse.json({ error: "Enter the current six-digit authenticator code." }, { status: 400, headers });
    }
    const setupTokenHash = hashOpaqueToken(parsed.data.setupToken);
    const tokenLimit = await consumeMfaEnrollmentLimits(setupTokenHash);
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Start authenticator setup again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(tokenLimit.retry_after_seconds) } },
      );
    }
    const challenge = await mfaSetupChallenge(setupTokenHash);
    if (!challenge) {
      return NextResponse.json({ error: "This authenticator setup has expired. Start again." }, { status: 400, headers });
    }
    const secret = decryptAuthPayload(challenge.factor_secret_ciphertext, "totp-secret", challenge.factor_id);
    const counter = verifyTotp(secret, parsed.data.otp);
    const replacementSessionToken = createOpaqueToken();
    if (counter === null || !(await finishSessionMfaEnrollment({
      sessionId: principal.sessionId,
      setupTokenHash,
      factorId: challenge.factor_id,
      counter,
      replacementSessionTokenHash: replacementSessionToken.hash,
      requestId,
    }))) {
      return NextResponse.json({ error: "The authenticator code is invalid or has already been used." }, { status: 401, headers });
    }
    const response = NextResponse.json({ success: true, stepUpExpiresInSeconds: 600 }, { headers });
    const remainingSessionSeconds = Math.max(
      1,
      Math.ceil((principal.expiresAt.getTime() - Date.now()) / 1000),
    );
    setSessionCookie(response, replacementSessionToken.raw, remainingSessionSeconds);
    return response;
  } catch (error) {
    logRouteFailure("session-mfa-enrollment-confirmation", requestId, error);
    return NextResponse.json({ error: "Authenticator enrollment is temporarily unavailable." }, { status: 503, headers });
  }
}

export const POST = observeRouteHandler("session-mfa-enrollment-confirmation", post);
