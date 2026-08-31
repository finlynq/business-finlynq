import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
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
import { supportedCurrencies } from "@/kernel/money";
import { emailLookupHash, identityLookupHash, normalizeEmail } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const genericMessage = "If this email can start an account, a verification link will be sent shortly.";
const schema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(2).max(120),
  organizationName: z.string().trim().min(2).max(200),
  entityCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/).refine((value) => value !== "0000"),
  entityName: z.string().trim().min(2).max(200),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  regionCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/),
  functionalCurrency: z.string().trim().toUpperCase().refine(
    (value) => supportedCurrencies.includes(value),
    "Choose a supported functional currency",
  ),
  accountingProfile: z.enum(["CAN_ASPE", "US_GAAP_NONPUBLIC"]),
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
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    if (process.env.ACCOUNT_SIGNUP_ENABLED !== "true") {
      return NextResponse.json({ error: "New account signup is not enabled." }, { status: 403, headers });
    }

    assertAccountAuthenticationConfigured();
    const { ipHash } = requestFingerprints(request);
    // Spend only the caller's coarse IP budget before bot proof. Otherwise an
    // attacker could exhaust a victim email's daily budget with invalid
    // challenge tokens.
    const ipLimit = await consumeRateLimit("organization-signup-ip-hour", ipHash, 6, 3600);
    if (!ipLimit.allowed) {
      await settleSensitiveResponse(startedAt);
      return NextResponse.json(
        { message: genericMessage },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Review the account details, accept the terms, and try again." },
        { status: 400, headers },
      );
    }
    const email = normalizeEmail(parsed.data.email);
    const emailHash = emailLookupHash(email);

    assertSignupChallengeConfigured();
    await assertEmailDeliveryReady();
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

    const emailLimit = await consumeRateLimit(
      "organization-signup-email-day",
      identityLookupHash(`organization-signup|${emailHash}`),
      4,
      86400,
    );
    if (!emailLimit.allowed) {
      // Keep per-principal exhaustion indistinguishable from an accepted or
      // already-existing identity. The coarse IP response above can expose a
      // retry delay because it carries no victim-specific state.
      await settleSensitiveResponse(startedAt);
      return NextResponse.json({ message: genericMessage }, { status: 202, headers });
    }

    await requestOwnerSignup({
      email,
      displayName: parsed.data.displayName,
      organizationName: parsed.data.organizationName,
      entityCode: parsed.data.entityCode,
      entityName: parsed.data.entityName,
      countryCode: parsed.data.countryCode,
      regionCode: parsed.data.regionCode,
      functionalCurrency: parsed.data.functionalCurrency,
      accountingProfile: parsed.data.accountingProfile,
      fiscalYear: parsed.data.fiscalYear,
      manualPostingMode: parsed.data.manualPostingMode,
      ipHash,
      requestId,
    });
    await settleSensitiveResponse(startedAt);
    return NextResponse.json({ message: genericMessage }, { status: 202, headers });
  } catch (error) {
    logRouteFailure("account-signup-request", requestId, error);
    await settleSensitiveResponse(startedAt);
    return NextResponse.json(
      { error: "Account signup is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}
