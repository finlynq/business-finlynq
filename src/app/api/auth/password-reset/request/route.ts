import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertEmailDeliveryReady, consumeRateLimit, queuePasswordReset } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { settleSensitiveResponse } from "@/modules/identity/response-timing";
import { createOpaqueToken } from "@/modules/identity/session";
import { emailLookupHash, encryptAuthPayload, identityLookupHash } from "@/security/identity-secret";

const schema = z.object({ email: z.email().max(254) });
const genericMessage = "If an eligible account matches that email, a reset link will be sent shortly.";

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ message: genericMessage }, { headers });

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const parsed = contentType.toLowerCase().startsWith("application/json")
      ? schema.safeParse(await request.json())
      : { success: false as const };
    if (!parsed.success) {
      await settleSensitiveResponse(startedAt);
      return NextResponse.json({ message: genericMessage }, { headers });
    }
    const { ipHash } = requestFingerprints(request);
    const identifierHash = emailLookupHash(parsed.data.email);
    const [ipLimit, identifierLimit] = await Promise.all([
      consumeRateLimit("password-reset-ip-hour", ipHash, 8, 3600),
      consumeRateLimit("password-reset-identifier-hour", identityLookupHash(`reset|${identifierHash}`), 3, 3600),
    ]);
    if (!ipLimit.allowed || !identifierLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retry_after_seconds, identifierLimit.retry_after_seconds);
      await settleSensitiveResponse(startedAt);
      return NextResponse.json({ message: genericMessage }, { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } });
    }

    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const token = createOpaqueToken();
    const outboxId = randomUUID();
    const payloadCiphertext = encryptAuthPayload(JSON.stringify({ token: token.raw }), "email-payload", outboxId);
    await queuePasswordReset({ emailHash: identifierHash, tokenHash: token.hash, payloadCiphertext, outboxId, ipHash, requestId });
    await settleSensitiveResponse(startedAt);
    return NextResponse.json({ message: genericMessage }, { headers });
  } catch (error) {
    console.error("Business Finlynq password-reset request failed", {
      requestId,
      error: error instanceof Error ? error.message : "unknown recovery error",
    });
    await settleSensitiveResponse(startedAt);
    return NextResponse.json({ message: genericMessage }, { headers });
  }
}
