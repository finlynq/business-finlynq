import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAuthMutationJson } from "@/app/api/_shared/auth-mutation-route";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import {
  assertEmailDeliveryReady,
  consumePasswordResetEscalationLimits,
  consumeRateLimit,
  escalatePasswordReset,
} from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";

const schema = z.object({ token: z.string().min(32).max(200) });
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Account recovery is not enabled." }, { status: 403, headers });
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const { ipHash } = requestFingerprints(request);
    const ipLimit = await consumeRateLimit("password-reset-escalation-ip-day", ipHash, 5, 86400);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many recovery changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(ipLimit.retry_after_seconds) } },
      );
    }
    const body = await readAuthMutationJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return NextResponse.json({ error: "This reset link is incomplete." }, { status: 400, headers });
    const tokenHash = hashOpaqueToken(parsed.data.token);
    const tokenLimit = await consumePasswordResetEscalationLimits(tokenHash);
    if (!tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many recovery changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(tokenLimit.retry_after_seconds) } },
      );
    }
    const result = await escalatePasswordReset(tokenHash, requestId);
    if (!result) return NextResponse.json({ error: "This reset link cannot be changed." }, { status: 400, headers });
    return NextResponse.json({
      recoveryPolicy: result.recovery_policy,
      availableAt: new Date(result.available_at).toISOString(),
    }, { headers });
  } catch (error) {
    logRouteFailure("password-reset-escalation", requestId, error);
    return NextResponse.json({ error: "Recovery protection is temporarily unavailable." }, { status: 503, headers });
  }
}
