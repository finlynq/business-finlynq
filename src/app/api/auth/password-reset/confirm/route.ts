import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import {
  authorizePasswordResetTotp,
  assertEmailDeliveryReady,
  consumePasswordResetLimits,
  consumeRateLimit,
  finishPasswordReset,
  finishPasswordResetWithMfa,
  passwordResetChallenge,
  prepareRecoveryMfa,
} from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { hashPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";
import { createTotpSecret, totpEnrollmentUri, verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload, decryptIdentityField, encryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(14).max(128),
  otp: z.string().regex(/^\d{6}$/).optional(),
});

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Account recovery is not enabled on this preview." }, { status: 403, headers });

  try {
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("password-reset-confirm-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please request a new link later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return NextResponse.json({ error: "Use a password with at least 14 characters." }, { status: 400, headers });
    const tokenHash = hashOpaqueToken(parsed.data.token);
    const tokenLimit = await consumePasswordResetLimits(tokenHash);
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please request a new link later." },
        { status: 429, headers: { ...headers, "Retry-After": String(tokenLimit.retry_after_seconds) } },
      );
    }

    const challenge = await passwordResetChallenge(tokenHash);
    if (!challenge) {
      return NextResponse.json({ error: "This reset link is invalid, expired, or has already been used." }, { status: 400, headers });
    }
    if (challenge?.recovery_policy === "DELAYED" && new Date(challenge.available_at).getTime() > Date.now()) {
      return NextResponse.json({
        error: "This privileged recovery is in its security delay. Return after the time shown.",
        availableAt: new Date(challenge.available_at).toISOString(),
      }, { status: 423, headers });
    }
    if (challenge?.recovery_policy === "CO_OWNER" && challenge.recovery_status !== "APPROVED") {
      return NextResponse.json({ error: "A different recovery administrator must approve this request before you continue." }, { status: 423, headers });
    }
    if (challenge?.recovery_policy === "TOTP") {
      if (!parsed.data.otp || !challenge.factor_id || !challenge.factor_secret_ciphertext) {
        return NextResponse.json({ error: "Enter the six-digit code from your authenticator.", mfaRequired: true }, { status: 409, headers });
      }
      const secret = decryptAuthPayload(challenge.factor_secret_ciphertext, "totp-secret", challenge.factor_id);
      const counter = verifyTotp(secret, parsed.data.otp);
      if (counter === null || !(await authorizePasswordResetTotp({ tokenHash, factorId: challenge.factor_id, counter, requestId }))) {
        return NextResponse.json({ error: "The authenticator code is invalid or has already been used.", mfaRequired: true }, { status: 401, headers });
      }
    }

    if (challenge.recovery_policy === "EMAIL_ONLY" || challenge.recovery_policy === "CO_OWNER" || challenge.recovery_policy === "DELAYED") {
      let factorId = challenge.replacement_factor_id;
      let secret: string;
      if (factorId && challenge.replacement_factor_secret_ciphertext) {
        secret = decryptAuthPayload(challenge.replacement_factor_secret_ciphertext, "totp-secret", factorId);
      } else {
        factorId = randomUUID();
        secret = createTotpSecret();
        const prepared = await prepareRecoveryMfa({
          tokenHash,
          factorId,
          factorSecretCiphertext: encryptAuthPayload(secret, "totp-secret", factorId),
          requestId,
        });
        if (!prepared) {
          return NextResponse.json({ error: "This protected recovery is not ready." }, { status: 423, headers });
        }
      }
      const email = decryptIdentityField(challenge.email_ciphertext, "email", challenge.user_id);
      const enrollment = {
        mfaEnrollmentRequired: true,
        secret,
        enrollmentUri: totpEnrollmentUri({ secret, account: email }),
        organizationName: challenge.organization_name,
      };
      if (!parsed.data.otp) {
        return NextResponse.json({
          ...enrollment,
          error: "Set up the replacement authenticator, then enter its current six-digit code.",
        }, { status: 409, headers });
      }
      const counter = verifyTotp(secret, parsed.data.otp);
      if (counter === null) {
        return NextResponse.json({ ...enrollment, error: "The replacement authenticator code is invalid." }, { status: 401, headers });
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const finished = await finishPasswordResetWithMfa({ tokenHash, passwordHash, factorId, counter, requestId });
      if (!finished) {
        return NextResponse.json({ error: "This reset link is invalid, expired, or has already been used." }, { status: 400, headers });
      }
      return NextResponse.json({ success: true }, { headers });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const finished = await finishPasswordReset(tokenHash, passwordHash, requestId);
    if (!finished) return NextResponse.json({ error: "This reset link is invalid, expired, or has already been used." }, { status: 400, headers });
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    console.error("Business Finlynq password reset failed", { requestId, error: error instanceof Error ? error.message : "unknown reset error" });
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 503, headers });
  }
}
