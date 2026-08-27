import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeMfaEnrollmentLimits, consumeRateLimit, finishMfaEnrollment, mfaSetupChallenge } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({ setupToken: z.string().min(32).max(200), otp: z.string().regex(/^\d{6}$/) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Authenticator enrollment is not enabled." }, { status: 403, headers });
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Enter the current six-digit authenticator code." }, { status: 400, headers });
    const { ipHash } = requestFingerprints(request);
    const setupTokenHash = hashOpaqueToken(parsed.data.setupToken);
    const [ipLimit, tokenLimit] = await Promise.all([
      consumeRateLimit("mfa-enrollment-ip-hour", ipHash, 10, 3600),
      consumeMfaEnrollmentLimits(setupTokenHash),
    ]);
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Ask the administrator for a new invitation." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.max(ipLimit.retry_after_seconds, tokenLimit.retry_after_seconds)) } },
      );
    }
    const challenge = await mfaSetupChallenge(setupTokenHash);
    if (!challenge) return NextResponse.json({ error: "This authenticator setup has expired. Ask the administrator for a new invitation." }, { status: 400, headers });
    const secret = decryptAuthPayload(challenge.factor_secret_ciphertext, "totp-secret", challenge.factor_id);
    const counter = verifyTotp(secret, parsed.data.otp);
    if (counter === null || !(await finishMfaEnrollment({ setupTokenHash, factorId: challenge.factor_id, counter, requestId: randomUUID() }))) {
      return NextResponse.json({ error: "The authenticator code is invalid or has already been used." }, { status: 401, headers });
    }
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    console.error("Business Finlynq MFA enrollment failed", { error: error instanceof Error ? error.message : "unknown error" });
    return NextResponse.json({ error: "Authenticator enrollment is temporarily unavailable." }, { status: 503, headers });
  }
}
