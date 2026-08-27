import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { assertEmailDeliveryReady, consumeRateLimit } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { settleSensitiveResponse } from "@/modules/identity/response-timing";
import { acceptOwnerSignup } from "@/modules/identity/signup-service";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const invalidMessage = "This signup link is invalid, expired, or has already been used.";
const schema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(14).max(128),
});

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  }
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") {
    return NextResponse.json({ error: "Account activation is not enabled." }, { status: 403, headers });
  }

  try {
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("organization-signup-accept-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return body.response;
    }
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return NextResponse.json({ error: invalidMessage }, { status: 400, headers });
    }

    const accepted = await acceptOwnerSignup({
      token: parsed.data.token,
      password: parsed.data.password,
      requestId,
    });
    if (accepted.status === "rate-limited") {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(accepted.retryAfterSeconds) } },
      );
    }
    if (accepted.status === "invalid") {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return NextResponse.json({ error: invalidMessage }, { status: 400, headers });
    }
    return NextResponse.json({
      setupToken: accepted.setupToken,
      secret: accepted.secret,
      enrollmentUri: accepted.enrollmentUri,
      organizationName: accepted.organizationName,
    }, { headers });
  } catch (error) {
    console.error("Business Finlynq account signup acceptance failed", {
      requestId,
      error: error instanceof Error ? error.message : "unknown signup acceptance error",
    });
    await settleSensitiveResponse(startedAt, { minimumMs: 300 });
    return NextResponse.json(
      { error: "Account activation is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}
