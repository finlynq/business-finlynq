import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  assertEmailDeliveryReady,
  consumeRateLimit,
  issueMfaUserSession,
  issueMfaUserSessionWithTrust,
  issuePasswordUserSession,
  issueTrustedBrowserUserSession,
  lookupLogin,
  recordLoginFailure,
  type LoginIdentity,
} from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { consumeDummyPasswordCheck, verifyPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import {
  createOpaqueToken,
  hashOpaqueToken,
  requestPrincipal,
  sessionCookieName,
  setSessionCookie,
} from "@/modules/identity/session";
import {
  clearTrustedBrowserCookie,
  isPlausibleTrustedBrowserToken,
  setTrustedBrowserCookie,
  trustedBrowserCookieName,
  trustedBrowserLabel,
} from "@/modules/identity/trusted-browser";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload, emailLookupHash, identityLookupHash } from "@/security/identity-secret";

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  otp: z.string().regex(/^\d{6}$/).optional(),
  trustBrowser: z.boolean().optional().default(false),
  next: z.string().max(2000).optional(),
});

const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

function mfaChallenge(
  identity: LoginIdentity,
  clearTrust: boolean,
  error = "Enter the six-digit code from your authenticator.",
): NextResponse {
  const response = NextResponse.json({
    error,
    mfaRequired: true,
    trustedBrowserAllowed: identity.trusted_browser_enabled === true,
    trustedBrowserDurationDays: identity.trusted_browser_enabled
      ? identity.trusted_browser_duration_days
      : undefined,
  }, { status: 401, headers: noStoreHeaders });
  if (clearTrust) clearTrustedBrowserCookie(response);
  return response;
}

async function post(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The sign-in request could not be verified." }, { status: 403, headers: noStoreHeaders });
    }
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") {
      return NextResponse.json({ error: "Account sign-in is not enabled on this preview." }, { status: 403, headers: noStoreHeaders });
    }

    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real") {
      return NextResponse.json({ success: true, next: "/app" }, { headers: noStoreHeaders });
    }
    const existingSessionToken = request.cookies.get(sessionCookieName())?.value;
    const replacedDemoSessionTokenHash = existing?.sessionMode === "demo" && existingSessionToken
      ? hashOpaqueToken(existingSessionToken)
      : null;

    const { ipHash, userAgentHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("login-ip-minute", ipHash, 5, 60);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait and try again." },
        { status: 429, headers: { ...noStoreHeaders, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }

    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = loginSchema.safeParse(body.value);
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter a valid email address and password." }, { status: 400, headers: noStoreHeaders });
    }

    const identifierHash = emailLookupHash(parsed.data.email);
    const [hourlyLimit, dailyLimit] = await Promise.all([
      consumeRateLimit("login-identifier-hour", identityLookupHash(`login-hour|${identifierHash}`), 10, 3600),
      consumeRateLimit("login-identifier-day", identityLookupHash(`login-day|${identifierHash}`), 50, 86400),
    ]);
    const blocked = [hourlyLimit, dailyLimit].filter((entry) => !entry.allowed);
    if (blocked.length > 0) {
      const retryAfter = Math.max(...blocked.map((entry) => entry.retry_after_seconds));
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait and try again." },
        { status: 429, headers: { ...noStoreHeaders, "Retry-After": String(retryAfter) } },
      );
    }

    const candidates = await lookupLogin(identifierHash);
    // Current identity rules permit one active organization membership. Keep
    // the existing deterministic first-candidate behavior until an explicit
    // organization chooser is introduced.
    const identity = candidates[0];
    const passwordValid = identity
      ? await verifyPassword(parsed.data.password, identity.password_hash)
      : (await consumeDummyPasswordCheck(parsed.data.password), false);
    if (!identity || !passwordValid || !identity.email_verified_at) {
      await recordLoginFailure(requestId);
      return NextResponse.json({ error: "Invalid email address or password." }, { status: 401, headers: noStoreHeaders });
    }

    const token = createOpaqueToken();
    const sessionInput = {
      userId: identity.user_id,
      organizationId: identity.organization_id,
      membershipId: identity.membership_id,
      tokenHash: token.hash,
      ipHash,
      userAgentHash,
      requestId,
      replacedDemoSessionTokenHash,
    };

    if (!identity.mfa_required) {
      const sessionId = await issuePasswordUserSession(sessionInput);
      if (!sessionId) throw new Error("The selected membership is no longer available");
      const response = NextResponse.json({ success: true, next: safeAppPath(parsed.data.next) }, { headers: noStoreHeaders });
      setSessionCookie(response, token.raw, 24 * 60 * 60);
      return response;
    }

    const rawTrustedBrowserToken = request.cookies.get(trustedBrowserCookieName())?.value;
    let clearRejectedTrust = Boolean(rawTrustedBrowserToken);
    if (isPlausibleTrustedBrowserToken(rawTrustedBrowserToken)) {
      const replacementTrustToken = createOpaqueToken();
      const trustedSession = await issueTrustedBrowserUserSession({
        userId: identity.user_id,
        organizationId: identity.organization_id,
        membershipId: identity.membership_id,
        trustedBrowserTokenHash: hashOpaqueToken(rawTrustedBrowserToken),
        replacementTrustedBrowserTokenHash: replacementTrustToken.hash,
        sessionTokenHash: token.hash,
        ipHash,
        userAgentHash,
        requestId,
        replacedDemoSessionTokenHash,
      });
      if (trustedSession) {
        const response = NextResponse.json({
          success: true,
          next: safeAppPath(parsed.data.next),
          authentication: "PASSWORD_TRUSTED_BROWSER",
        }, { headers: noStoreHeaders });
        setSessionCookie(response, token.raw, 24 * 60 * 60);
        setTrustedBrowserCookie(
          response,
          replacementTrustToken.raw,
          trustedSession.trustedBrowserExpiresAt,
        );
        return response;
      }
    }

    if (!identity.mfa_factor_id || !identity.mfa_secret_ciphertext) {
      const response = NextResponse.json(
        { error: "Account security setup is incomplete. Ask an administrator to issue a new invitation." },
        { status: 403, headers: noStoreHeaders },
      );
      if (clearRejectedTrust) clearTrustedBrowserCookie(response);
      return response;
    }
    if (!parsed.data.otp) return mfaChallenge(identity, clearRejectedTrust);

    const secret = decryptAuthPayload(identity.mfa_secret_ciphertext, "totp-secret", identity.mfa_factor_id);
    const mfaCounter = verifyTotp(secret, parsed.data.otp);
    if (mfaCounter === null) {
      await recordLoginFailure(requestId);
      return mfaChallenge(
        identity,
        clearRejectedTrust,
        "Invalid email address, password, or authenticator code.",
      );
    }

    let sessionId: string | null;
    let enrolledTrustedBrowser: { raw: string; expiresAt: Date } | null = null;
    if (parsed.data.trustBrowser && identity.trusted_browser_enabled === true) {
      const trustToken = createOpaqueToken();
      const issuance = await issueMfaUserSessionWithTrust({
        ...sessionInput,
        factorId: identity.mfa_factor_id,
        totpCounter: mfaCounter,
        trustedBrowserTokenHash: trustToken.hash,
        browserLabel: trustedBrowserLabel(request.headers.get("user-agent")),
      });
      sessionId = issuance?.sessionId ?? null;
      if (issuance) {
        enrolledTrustedBrowser = {
          raw: trustToken.raw,
          expiresAt: issuance.trustedBrowserExpiresAt,
        };
      }
    } else {
      sessionId = await issueMfaUserSession({
        ...sessionInput,
        factorId: identity.mfa_factor_id,
        totpCounter: mfaCounter,
      });
    }
    if (!sessionId) throw new Error("The selected membership is no longer available");

    const response = NextResponse.json({ success: true, next: safeAppPath(parsed.data.next) }, { headers: noStoreHeaders });
    setSessionCookie(response, token.raw, 24 * 60 * 60);
    if (enrolledTrustedBrowser) {
      setTrustedBrowserCookie(response, enrolledTrustedBrowser.raw, enrolledTrustedBrowser.expiresAt);
      clearRejectedTrust = false;
    }
    if (clearRejectedTrust) clearTrustedBrowserCookie(response);
    return response;
  } catch (error) {
    logRouteFailure("account-login", requestId, error);
    return NextResponse.json({ error: "Sign-in is temporarily unavailable." }, { status: 503, headers: noStoreHeaders });
  }
}

export const POST = observeRouteHandler("account-login", post);
