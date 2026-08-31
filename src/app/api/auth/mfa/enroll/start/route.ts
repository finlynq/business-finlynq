import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  beginSessionMfaEnrollment,
  consumeRateLimit,
  passwordForSession,
  recordSessionReauthenticationFailure,
} from "@/modules/identity/auth-store";
import { authenticatorQrCodeDataUrl } from "@/modules/identity/authenticator-qr";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { verifyPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { createOpaqueToken, requestPrincipal } from "@/modules/identity/session";
import { createTotpSecret, totpEnrollmentUri } from "@/modules/identity/totp";
import { encryptAuthPayload, identityLookupHash } from "@/security/identity-secret";

const schema = z.object({ currentPassword: z.string().min(1).max(128) });
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

    assertAccountAuthenticationConfigured();
    const { ipHash } = requestFingerprints(request);
    const [ipLimit, sessionLimit] = await Promise.all([
      consumeRateLimit("mfa-session-enrollment-ip-hour", ipHash, 10, 3600),
      consumeRateLimit(
        "mfa-session-enrollment-session-hour",
        identityLookupHash(`mfa-enrollment|${principal.sessionId}`),
        5,
        3600,
      ),
    ]);
    if (!ipLimit.allowed || !sessionLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.max(ipLimit.retry_after_seconds, sessionLimit.retry_after_seconds)) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter your current password to add an authenticator." }, { status: 400, headers });
    }
    const credentials = await passwordForSession(principal.sessionId);
    if (!credentials) {
      return NextResponse.json({ error: "An authenticator is already enabled, or this session is no longer active." }, { status: 409, headers });
    }
    if (!(await verifyPassword(parsed.data.currentPassword, credentials.password_hash))) {
      await recordSessionReauthenticationFailure(principal.sessionId, requestId);
      return NextResponse.json({ error: "The current password is incorrect." }, { status: 401, headers });
    }

    const factorId = randomUUID();
    const secret = createTotpSecret();
    const setupToken = createOpaqueToken();
    const started = await beginSessionMfaEnrollment({
      sessionId: principal.sessionId,
      factorId,
      factorSecretCiphertext: encryptAuthPayload(secret, "totp-secret", factorId),
      setupTokenHash: setupToken.hash,
      requestId,
    });
    if (!started) {
      return NextResponse.json({ error: "An authenticator is already enabled, or this session is no longer active." }, { status: 409, headers });
    }
    const enrollmentUri = totpEnrollmentUri({
      secret,
      account: `${principal.displayName} — ${principal.organizationName}`,
    });
    return NextResponse.json({
      setupToken: setupToken.raw,
      secret,
      enrollmentUri,
      qrCodeDataUrl: await authenticatorQrCodeDataUrl(enrollmentUri),
      organizationName: principal.organizationName,
    }, { headers });
  } catch (error) {
    logRouteFailure("session-mfa-enrollment-start", requestId, error);
    return NextResponse.json({ error: "Authenticator enrollment is temporarily unavailable." }, { status: 503, headers });
  }
}

export const POST = observeRouteHandler("session-mfa-enrollment-start", post);
