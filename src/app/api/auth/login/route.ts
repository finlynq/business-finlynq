import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, issueUserSession, lookupLogin, recordLoginFailure } from "@/modules/identity/auth-store";
import { consumeDummyPasswordCheck, verifyPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { safeAppPath } from "@/modules/identity/safe-redirect";
import { createOpaqueToken, requestPrincipal, setSessionCookie } from "@/modules/identity/session";
import { emailLookupHash, identityLookupHash } from "@/security/identity-secret";

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().max(2000).optional(),
});

const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The sign-in request could not be verified." }, { status: 403, headers: noStoreHeaders });
  }
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") {
    return NextResponse.json({ error: "Account sign-in is not enabled on this preview." }, { status: 403, headers: noStoreHeaders });
  }

  try {
    const existing = await requestPrincipal(request);
    if (existing) return NextResponse.json({ success: true, next: "/app" }, { headers: noStoreHeaders });

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: "Invalid sign-in request." }, { status: 415, headers: noStoreHeaders });
    }
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter a valid email address and password." }, { status: 400, headers: noStoreHeaders });
    }

    const { ipHash, userAgentHash } = requestFingerprints(request);
    const identifierHash = emailLookupHash(parsed.data.email);
    const [ipLimit, hourlyLimit, dailyLimit] = await Promise.all([
      consumeRateLimit("login-ip-minute", ipHash, 5, 60),
      consumeRateLimit("login-identifier-hour", identityLookupHash(`login-hour|${identifierHash}`), 10, 3600),
      consumeRateLimit("login-identifier-day", identityLookupHash(`login-day|${identifierHash}`), 50, 86400),
    ]);
    const blocked = [ipLimit, hourlyLimit, dailyLimit].filter((entry) => !entry.allowed);
    if (blocked.length > 0) {
      const retryAfter = Math.max(...blocked.map((entry) => entry.retry_after_seconds));
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait and try again." },
        { status: 429, headers: { ...noStoreHeaders, "Retry-After": String(retryAfter) } },
      );
    }

    const candidates = await lookupLogin(identifierHash);
    const identity = candidates[0];
    const passwordValid = identity
      ? await verifyPassword(parsed.data.password, identity.password_hash)
      : (await consumeDummyPasswordCheck(parsed.data.password), false);
    if (!identity || !passwordValid || !identity.email_verified_at) {
      await recordLoginFailure(requestId);
      return NextResponse.json({ error: "Invalid email address or password." }, { status: 401, headers: noStoreHeaders });
    }

    const token = createOpaqueToken();
    const sessionId = await issueUserSession({
      userId: identity.user_id,
      organizationId: identity.organization_id,
      membershipId: identity.membership_id,
      tokenHash: token.hash,
      ipHash,
      userAgentHash,
      requestId,
    });
    if (!sessionId) throw new Error("The selected membership is no longer available");

    const response = NextResponse.json({ success: true, next: safeAppPath(parsed.data.next) }, { headers: noStoreHeaders });
    setSessionCookie(response, token.raw, 24 * 60 * 60);
    return response;
  } catch (error) {
    console.error("Business Finlynq login failed", { requestId, error });
    return NextResponse.json({ error: "Sign-in is temporarily unavailable." }, { status: 503, headers: noStoreHeaders });
  }
}
