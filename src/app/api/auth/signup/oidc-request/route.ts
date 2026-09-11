import { NextRequest, NextResponse } from "next/server";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { assertEmailDeliveryReady, consumeRateLimit } from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import {
  clearOidcSignupCookie,
  consumeOidcSignupProof,
  loadOidcConfiguration,
  oidcSignupCookieName,
  oidcSignupEnabled,
} from "@/modules/identity/oidc";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { settleSensitiveResponse } from "@/modules/identity/response-timing";
import { requestOidcOwnerSignup } from "@/modules/identity/signup-service";
import { ownerSignupDetailsSchema } from "@/modules/identity/signup-validation";
import { emailLookupHash, identityLookupHash, normalizeEmail } from "@/security/identity-secret";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const genericMessage = "Check your contact email for a one-use verification link.";

function jsonWithClearedProof(body: Record<string, unknown>, init: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  clearOidcSignupCookie(response);
  return response;
}

async function post(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    }
    if (!oidcSignupEnabled()) {
      return jsonWithClearedProof(
        { error: "Microsoft account signup is not enabled." },
        { status: 403, headers },
      );
    }

    assertAccountAuthenticationConfigured();
    const configuration = loadOidcConfiguration();
    const proof = consumeOidcSignupProof(
      request.cookies.get(oidcSignupCookieName())?.value,
      configuration,
    );
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("organization-signup-oidc-ip-hour", ipHash, 6, 3600);
    if (!ipLimit.allowed) {
      await settleSensitiveResponse(startedAt);
      return NextResponse.json(
        { error: "Too many signup attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }

    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = ownerSignupDetailsSchema.safeParse(body.value);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Review the account details, accept the terms, and try again." },
        { status: 400, headers },
      );
    }

    await assertEmailDeliveryReady();
    const principalLimit = await consumeRateLimit(
      "organization-signup-oidc-principal-day",
      identityLookupHash([
        "organization-signup-oidc",
        proof.issuer,
        proof.externalTenantId,
        proof.externalPrincipalId,
      ].join("|")),
      4,
      86400,
    );
    const email = normalizeEmail(parsed.data.email);
    const emailLimit = await consumeRateLimit(
      "organization-signup-email-day",
      identityLookupHash(`organization-signup|${emailLookupHash(email)}`),
      4,
      86400,
    );
    if (principalLimit.allowed && emailLimit.allowed) {
      await requestOidcOwnerSignup({
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
        oidcIdentity: proof,
      });
    }
    await settleSensitiveResponse(startedAt);
    return jsonWithClearedProof({ message: genericMessage }, { status: 202, headers });
  } catch (error) {
    logRouteFailure("account-oidc-signup-request", requestId, error);
    await settleSensitiveResponse(startedAt);
    return jsonWithClearedProof(
      { error: "Microsoft account signup is temporarily unavailable. Start again." },
      { status: 503, headers },
    );
  }
}

export const POST = observeRouteHandler("account-oidc-signup-request", post);
