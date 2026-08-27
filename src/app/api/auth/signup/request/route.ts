import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertEmailDeliveryReady, consumeRateLimit } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import {
  clientIp,
  requestFingerprints,
  validateSameOriginMutation,
} from "@/modules/identity/request-security";
import { settleSensitiveResponse } from "@/modules/identity/response-timing";
import {
  assertSignupChallengeConfigured,
  verifySignupChallenge,
} from "@/modules/identity/signup-challenge";
import { isSignupRegion } from "@/modules/identity/signup-policy";
import { requestOwnerSignup } from "@/modules/identity/signup-service";
import { emailLookupHash, identityLookupHash, normalizeEmail } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const genericMessage = "If this email can start an account, a verification link will be sent shortly.";
const schema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(200),
  entityCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/).refine((value) => value !== "0000"),
  entityName: z.string().trim().min(2).max(200),
  countryCode: z.enum(["CA", "US"]),
  regionCode: z.string().trim().toUpperCase(),
  fiscalYear: z.number().int().min(2000).max(2200),
  manualPostingMode: z.enum(["REVIEW_REQUIRED", "AUTO_POST"]),
  termsAccepted: z.literal(true),
  challengeToken: z.string().max(2048).default(""),
}).superRefine((value, context) => {
  if (!isSignupRegion(value.countryCode, value.regionCode)) {
    context.addIssue({ code: "custom", path: ["regionCode"], message: "Choose a valid state or province" });
  }
});

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  }
  if (process.env.ACCOUNT_SIGNUP_ENABLED !== "true") {
    return NextResponse.json({ error: "New account signup is not enabled." }, { status: 403, headers });
  }

  try {
    assertAccountAuthenticationConfigured();
    assertSignupChallengeConfigured();
    await assertEmailDeliveryReady();
    const contentType = request.headers.get("content-type") ?? "";
    const parsed = contentType.toLowerCase().startsWith("application/json")
      ? schema.safeParse(await request.json())
      : { success: false as const };
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Review the account details, accept the terms, and try again." },
        { status: 400, headers },
      );
    }

    const { ipHash } = requestFingerprints(request);
    const email = normalizeEmail(parsed.data.email);
    const emailHash = emailLookupHash(email);
    const [ipLimit, emailLimit] = await Promise.all([
      consumeRateLimit("organization-signup-ip-hour", ipHash, 6, 3600),
      consumeRateLimit(
        "organization-signup-email-day",
        identityLookupHash(`organization-signup|${emailHash}`),
        4,
        86400,
      ),
    ]);
    if (!ipLimit.allowed || !emailLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retry_after_seconds, emailLimit.retry_after_seconds);
      await settleSensitiveResponse(startedAt);
      return NextResponse.json(
        { message: genericMessage },
        { status: 429, headers: { ...headers, "Retry-After": String(retryAfter) } },
      );
    }

    const challengeValid = await verifySignupChallenge({
      token: parsed.data.challengeToken,
      remoteIp: clientIp(request),
    });
    if (!challengeValid) {
      await settleSensitiveResponse(startedAt);
      return NextResponse.json(
        { error: "The signup verification could not be completed. Refresh and try again." },
        { status: 400, headers },
      );
    }

    await requestOwnerSignup({
      email,
      displayName: parsed.data.displayName,
      organizationName: parsed.data.organizationName,
      entityCode: parsed.data.entityCode,
      entityName: parsed.data.entityName,
      countryCode: parsed.data.countryCode,
      regionCode: parsed.data.regionCode,
      fiscalYear: parsed.data.fiscalYear,
      manualPostingMode: parsed.data.manualPostingMode,
      ipHash,
      requestId,
    });
    await settleSensitiveResponse(startedAt);
    return NextResponse.json({ message: genericMessage }, { status: 202, headers });
  } catch (error) {
    console.error("Business Finlynq account signup request failed", {
      requestId,
      error: error instanceof Error ? error.message : "unknown signup error",
    });
    await settleSensitiveResponse(startedAt);
    return NextResponse.json(
      { error: "Account signup is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}
