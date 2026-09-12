import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { assertEmailDeliveryReady, consumeRateLimit } from "@/modules/identity/auth-store";
import { authenticatorQrCodeDataUrl } from "@/modules/identity/authenticator-qr";
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
import { acceptOidcOwnerSignup } from "@/modules/identity/signup-service";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const invalidMessage = "This Microsoft signup link is invalid, expired, or has already been used.";
const schema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(14).max(128).optional(),
}).strict();

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
    await assertEmailDeliveryReady();
    const configuration = loadOidcConfiguration();
    const proof = consumeOidcSignupProof(
      request.cookies.get(oidcSignupCookieName())?.value,
      configuration,
    );
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("organization-signup-oidc-accept-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return jsonWithClearedProof(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      clearOidcSignupCookie(body.response);
      return body.response;
    }
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return jsonWithClearedProof({ error: invalidMessage }, { status: 400, headers });
    }

    const accepted = await acceptOidcOwnerSignup({
      token: parsed.data.token,
      ...(parsed.data.password ? { password: parsed.data.password } : {}),
      requestId,
      oidcIdentity: proof,
    });
    if (accepted.status === "rate-limited") {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return jsonWithClearedProof(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(accepted.retryAfterSeconds) } },
      );
    }
    if (accepted.status === "invalid") {
      await settleSensitiveResponse(startedAt, { minimumMs: 300 });
      return jsonWithClearedProof({ error: invalidMessage }, { status: 400, headers });
    }
    const qrCodeDataUrl = await authenticatorQrCodeDataUrl(accepted.enrollmentUri);
    return jsonWithClearedProof({
      setupToken: accepted.setupToken,
      secret: accepted.secret,
      enrollmentUri: accepted.enrollmentUri,
      qrCodeDataUrl,
      organizationName: accepted.organizationName,
    }, { headers });
  } catch (error) {
    logRouteFailure("account-oidc-signup-acceptance", requestId, error);
    await settleSensitiveResponse(startedAt, { minimumMs: 300 });
    return jsonWithClearedProof(
      { error: "Microsoft account activation is temporarily unavailable." },
      { status: 503, headers },
    );
  }
}

export const POST = observeRouteHandler("account-oidc-signup-acceptance", post);
