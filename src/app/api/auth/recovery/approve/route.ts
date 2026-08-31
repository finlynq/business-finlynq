import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { approveRecovery, consumeRateLimit, consumeRecoveryApprovalLimits, totpForSession } from "@/modules/identity/auth-store";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { verifyTotp } from "@/modules/identity/totp";
import { decryptAuthPayload } from "@/security/identity-secret";

const schema = z.object({ recoveryRequestId: z.uuid(), otp: z.string().regex(/^\d{6}$/) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

async function post(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers });
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("recovery-approval-ip-hour", ipHash, 10, 3600);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return NextResponse.json({ error: "Enter a valid recovery request and authenticator code." }, { status: 400, headers });
    const principalLimit = await consumeRecoveryApprovalLimits(principal.sessionId, parsed.data.recoveryRequestId);
    if (!principalLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(principalLimit.retry_after_seconds) } },
      );
    }
    const factor = await totpForSession(principal.sessionId);
    if (!factor) return NextResponse.json({ error: "An active authenticator is required to approve recovery." }, { status: 403, headers });
    const secret = decryptAuthPayload(factor.factor_secret_ciphertext, "totp-secret", factor.factor_id);
    const counter = verifyTotp(secret, parsed.data.otp);
    const approved = counter !== null && await approveRecovery({
      recoveryRequestId: parsed.data.recoveryRequestId,
      actorSessionId: principal.sessionId,
      factorId: factor.factor_id,
      counter,
      requestId,
    });
    if (!approved) return NextResponse.json({ error: "The request cannot be approved, or the authenticator code was already used." }, { status: 403, headers });
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    logRouteFailure("recovery-approval", requestId, error);
    return NextResponse.json({ error: "Recovery approval is temporarily unavailable." }, { status: 503, headers });
  }
}

export const POST = observeRouteHandler("recovery-approval", post);
