import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  assertEmailDeliveryReady,
  issueOidcUserSession,
} from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import {
  clearOidcLoginCookie,
  consumeOidcLoginAttempt,
  exchangeOidcAuthorizationCode,
  loadOidcConfiguration,
  OidcAuthenticationError,
  oidcLoginCookieName,
  verifyOidcIdToken,
} from "@/modules/identity/oidc";
import { configuredAppOrigin, requestFingerprints } from "@/modules/identity/request-security";
import {
  createOpaqueToken,
  hashOpaqueToken,
  requestPrincipal,
  sessionCookieName,
  setSessionCookie,
} from "@/modules/identity/session";

const noStoreHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const allowedCallbackParameters = new Set([
  "code", "state", "iss", "session_state", "error", "error_description", "error_uri",
]);

function callbackQuery(request: NextRequest): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of request.nextUrl.searchParams.keys()) {
    if (!allowedCallbackParameters.has(name)) throw new OidcAuthenticationError("query_invalid");
    const selected = request.nextUrl.searchParams.getAll(name);
    if (selected.length !== 1 || selected[0]!.length > 4_096) {
      throw new OidcAuthenticationError("query_invalid");
    }
    values[name] = selected[0]!;
  }
  return values;
}

function loginError(code: string): NextResponse {
  const location = new URL("/login", configuredAppOrigin());
  location.searchParams.set("ssoError", code);
  const response = NextResponse.redirect(location, 303);
  for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
  clearOidcLoginCookie(response);
  return response;
}

function publicErrorCode(error: unknown): string {
  if (!(error instanceof OidcAuthenticationError)) return "unavailable";
  if (error.code === "identity_unassigned") return "unassigned";
  if (error.code === "state_expired") return "expired";
  if (["token_unavailable"].includes(error.code)) return "unavailable";
  return "rejected";
}

async function get(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true" || process.env.AUTH_OIDC_ENABLED !== "true") {
      return loginError("disabled");
    }
    const configuration = loadOidcConfiguration();
    const query = callbackQuery(request);
    const attempt = consumeOidcLoginAttempt(
      request.cookies.get(oidcLoginCookieName())?.value,
      query.state ?? null,
      configuration,
    );
    if (query.iss !== undefined && query.iss !== configuration.issuer) {
      throw new OidcAuthenticationError("issuer_mismatch");
    }
    if (query.error !== undefined) throw new OidcAuthenticationError("authorization_rejected");
    if (!query.code) throw new OidcAuthenticationError("code_invalid");

    const idToken = await exchangeOidcAuthorizationCode(configuration, query.code, attempt.verifier);
    const identity = await verifyOidcIdToken(configuration, idToken, attempt.nonce);
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();

    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real") {
      const response = NextResponse.redirect(new URL("/app", configuredAppOrigin()), 303);
      for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
      clearOidcLoginCookie(response);
      return response;
    }
    const existingSessionToken = request.cookies.get(sessionCookieName())?.value;
    const replacedDemoSessionTokenHash = existing?.sessionMode === "demo" && existingSessionToken
      ? hashOpaqueToken(existingSessionToken)
      : null;
    const { ipHash, userAgentHash } = requestFingerprints(request);
    const sessionToken = createOpaqueToken();
    const sessionId = await issueOidcUserSession({
      userId: identity.userId,
      organizationId: identity.organizationId,
      membershipId: identity.membershipId,
      tokenHash: sessionToken.hash,
      ipHash,
      userAgentHash,
      requestId,
      credentialHash: identity.credentialHash,
      replacedDemoSessionTokenHash,
    });
    if (!sessionId) throw new OidcAuthenticationError("identity_unassigned");

    const response = NextResponse.redirect(new URL(attempt.next, configuredAppOrigin()), 303);
    for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
    clearOidcLoginCookie(response);
    setSessionCookie(response, sessionToken.raw, 24 * 60 * 60);
    return response;
  } catch (error) {
    logRouteFailure("oidc-login", requestId, error);
    return loginError(publicErrorCode(error));
  }
}

export const GET = observeRouteHandler("oidc-login", get);
