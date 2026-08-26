import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, preparePasswordReset } from "@/modules/identity/auth-store";
import { sendPasswordResetEmail } from "@/modules/identity/reset-email";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { createOpaqueToken } from "@/modules/identity/session";
import { decryptIdentityField, emailLookupHash, identityLookupHash } from "@/security/identity-secret";

const schema = z.object({ email: z.email().max(254) });
const genericMessage = "If an eligible account matches that email, a reset link will be sent shortly.";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ message: genericMessage }, { headers });

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ message: genericMessage }, { headers });
    const { ipHash } = requestFingerprints(request);
    const identifierHash = emailLookupHash(parsed.data.email);
    const [ipLimit, identifierLimit] = await Promise.all([
      consumeRateLimit("password-reset-ip-hour", ipHash, 8, 3600),
      consumeRateLimit("password-reset-identifier-hour", identityLookupHash(`reset|${identifierHash}`), 3, 3600),
    ]);
    if (!ipLimit.allowed || !identifierLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retry_after_seconds, identifierLimit.retry_after_seconds);
      return NextResponse.json({ message: genericMessage }, { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } });
    }

    const token = createOpaqueToken();
    const prepared = await preparePasswordReset({ emailHash: identifierHash, tokenHash: token.hash, ipHash, requestId });
    if (prepared) {
      try {
        const email = decryptIdentityField(prepared.email_ciphertext, "email", prepared.user_id);
        await sendPasswordResetEmail(email, token.raw);
      } catch (error) {
        console.error("Business Finlynq password-reset delivery failed", { requestId, error });
      }
    }
    return NextResponse.json({ message: genericMessage }, { headers });
  } catch (error) {
    console.error("Business Finlynq password-reset request failed", { requestId, error });
    return NextResponse.json({ message: genericMessage }, { headers });
  }
}
