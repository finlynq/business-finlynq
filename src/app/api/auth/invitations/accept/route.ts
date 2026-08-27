import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvitation, assertEmailDeliveryReady, consumeRateLimit } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { hashPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/identity/session";
import { createTotpSecret, totpEnrollmentUri } from "@/modules/identity/totp";
import { decryptIdentityField, encryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({ token: z.string().min(32).max(200), password: z.string().min(14).max(128) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Account invitations are not enabled." }, { status: 403, headers });
  try {
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Use a valid invitation and a password with at least 14 characters." }, { status: 400, headers });
    const { ipHash } = requestFingerprints(request);
    const limit = await consumeRateLimit("invitation-accept-ip-hour", ipHash, 10, 3600);
    if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retry_after_seconds) } });

    const factorId = randomUUID();
    const secret = createTotpSecret();
    const setupToken = createOpaqueToken();
    const passwordHash = await hashPassword(parsed.data.password);
    const result = await acceptInvitation({
      tokenHash: hashOpaqueToken(parsed.data.token), passwordHash, factorId,
      factorSecretCiphertext: encryptAuthPayload(secret, "totp-secret", factorId),
      setupTokenHash: setupToken.hash, requestId,
    });
    if (!result) return NextResponse.json({ error: "This invitation is invalid, expired, or has already been used." }, { status: 400, headers });
    const email = decryptIdentityField(result.email_ciphertext, "email", result.user_id);
    return NextResponse.json({
      setupToken: setupToken.raw,
      secret,
      enrollmentUri: totpEnrollmentUri({ secret, account: email }),
      organizationName: result.organization_name,
    }, { headers });
  } catch (error) {
    console.error("Business Finlynq invitation acceptance failed", { requestId, error: error instanceof Error ? error.message : "unknown error" });
    return NextResponse.json({ error: "Invitation acceptance is temporarily unavailable." }, { status: 503, headers });
  }
}
