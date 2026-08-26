import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, finishPasswordReset } from "@/modules/identity/auth-store";
import { hashPassword } from "@/modules/identity/passwords";
import { requestFingerprints, validateSameOriginMutation } from "@/modules/identity/request-security";
import { hashOpaqueToken } from "@/modules/identity/session";

const schema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(12).max(128),
});

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!validateSameOriginMutation(request)) return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers });
  if (process.env.ACCOUNT_LOGIN_ENABLED !== "true") return NextResponse.json({ error: "Account recovery is not enabled on this preview." }, { status: 403, headers });

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Use a password with at least 12 characters." }, { status: 400, headers });
    const { ipHash } = requestFingerprints(request);
    const limit = await consumeRateLimit("password-reset-confirm-ip-hour", ipHash, 10, 3600);
    if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Please request a new link later." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retry_after_seconds) } });

    const passwordHash = await hashPassword(parsed.data.password);
    const finished = await finishPasswordReset(hashOpaqueToken(parsed.data.token), passwordHash, randomUUID());
    if (!finished) return NextResponse.json({ error: "This reset link is invalid, expired, or has already been used." }, { status: 400, headers });
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    console.error("Business Finlynq password reset failed", { error });
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 503, headers });
  }
}
