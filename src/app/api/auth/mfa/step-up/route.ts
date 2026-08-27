import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeMfaStepUpLimits, consumeRateLimit, markStepUp, totpForSession } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({ otp: z.string().regex(/^\d{6}$/) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  const principal = await requestPrincipal(request);
  if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Enter the current six-digit authenticator code." }, { status: 400, headers });
    const { ipHash } = requestFingerprints(request);
    const [ipLimit, principalLimit] = await Promise.all([
      consumeRateLimit("mfa-step-up-ip-hour", ipHash, 20, 3600),
      consumeMfaStepUpLimits(principal.sessionId),
    ]);
    if (!ipLimit.allowed || !principalLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.max(ipLimit.retry_after_seconds, principalLimit.retry_after_seconds)) } },
      );
    }
    const factor = await totpForSession(principal.sessionId);
    if (!factor) return NextResponse.json({ error: "No active authenticator is available." }, { status: 403, headers });
    const secret = decryptAuthPayload(factor.factor_secret_ciphertext, "totp-secret", factor.factor_id);
    const counter = verifyTotp(secret, parsed.data.otp);
    if (counter === null || !(await markStepUp({ sessionId: principal.sessionId, factorId: factor.factor_id, counter, requestId: randomUUID() }))) {
      return NextResponse.json({ error: "The authenticator code is invalid or has already been used." }, { status: 401, headers });
    }
    return NextResponse.json({ success: true, expiresInSeconds: 600 }, { headers });
  } catch (error) {
    console.error("Business Finlynq MFA step-up failed", { error: error instanceof Error ? error.message : "unknown error" });
    return NextResponse.json({ error: "Authenticator verification is temporarily unavailable." }, { status: 503, headers });
  }
}
