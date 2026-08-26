import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { revokeStoredSession } from "@/modules/identity/auth-store";
import { configuredAppOrigin, validateSameOriginMutation } from "@/modules/identity/request-security";
import { clearSessionCookie, hashOpaqueToken, sessionCookieName } from "@/modules/identity/session";

export async function POST(request: NextRequest) {
  if (!validateSameOriginMutation(request)) {
    return NextResponse.json({ error: "The sign-out request could not be verified." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }

  const rawToken = request.cookies.get(sessionCookieName())?.value;
  if (rawToken) {
    try { await revokeStoredSession(hashOpaqueToken(rawToken), randomUUID()); }
    catch (error) { console.error("Business Finlynq session revocation failed", { error }); }
  }
  const response = NextResponse.redirect(new URL("/", configuredAppOrigin()), 303);
  response.headers.set("Cache-Control", "private, no-store");
  clearSessionCookie(response);
  return response;
}
