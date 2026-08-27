import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Account recovery is not enabled." }, { status: 403, headers });
  try {
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "This reset link is incomplete." }, { status: 400, headers });
    const { ipHash } = requestFingerprints(request);
    const tokenHash = hashOpaqueToken(parsed.data.token);
    const [ipLimit, tokenLimit] = await Promise.all([
      consumeRateLimit("password-reset-escalation-ip-day", ipHash, 5, 86400),
      consumePasswordResetEscalationLimits(tokenHash),
    ]);
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      return NextResponse.json(
        { error: "Too many recovery changes. Try again later." },
        { status: 429, headers: { ...headers, "Retry-After": String(Math.max(ipLimit.retry_after_seconds, tokenLimit.retry_after_seconds)) } },
      );
    }
    const result = await escalatePasswordReset(tokenHash, randomUUID());
    if (!result) return NextResponse.json({ error: "This reset link cannot be changed." }, { status: 400, headers });
    return NextResponse.json({
      recoveryPolicy: result.recovery_policy,
      availableAt: new Date(result.available_at).toISOString(),
    }, { headers });
  } catch (error) {
    console.error("Business Finlynq password-reset escalation failed", { error: error instanceof Error ? error.message : "unknown error" });
    return NextResponse.json({ error: "Recovery protection is temporarily unavailable." }, { status: 503, headers });
  }
}
