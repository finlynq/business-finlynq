import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { consumeMfaEnrollmentLimits, consumeRateLimit, finishMfaEnrollment, mfaSetupChallenge } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({ setupToken: z.string().min(32).max(200), otp: z.string().regex(/^\d{6}$/) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Authenticator enrollment is not enabled." }, { status: 403, headers });
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("mfa-enrollment-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Ask the administrator for a new invitation." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return NextResponse.json({ error: "Enter the current six-digit authenticator code." }, { status: 400, headers });
    const setupTokenHash = hashOpaqueToken(parsed.data.setupToken);
    const tokenLimit = await consumeMfaEnrollmentLimits(setupTokenHash);
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Ask the administrator for a new invitation." },
        { status: 429, headers: { ...headers, "Retry-After": String(tokenLimit.retry_after_seconds) } },
      );
    }
    const challenge = await mfaSetupChallenge(setupTokenHash);
    if (!challenge) return NextResponse.json({ error: "This authenticator setup has expired. Ask the administrator for a new invitation." }, { status: 400, headers });
    const secret = decryptAuthPayload(challenge.factor_secret_ciphertext, "totp-secret", challenge.factor_id);
    const counter = verifyTotp(secret, parsed.data.otp);
    if (counter === null || !(await finishMfaEnrollment({ setupTokenHash, factorId: challenge.factor_id, counter, requestId }))) {
      return NextResponse.json({ error: "The authenticator code is invalid or has already been used." }, { status: 401, headers });
    }
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    logRouteFailure("mfa-enrollment-confirmation", requestId, error);
    return NextResponse.json({ error: "Authenticator enrollment is temporarily unavailable." }, { status: 503, headers });
  }
}
