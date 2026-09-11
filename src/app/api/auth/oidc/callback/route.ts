import { NextRequest, NextResponse } from "next/server";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import {
  assertEmailDeliveryReady,
  issueOidcUserSession,
  resolveOidcIdentity,
} from "@/modules/identity/auth-store";
import { assertAccountAuthenticationConfigured } from "@/modules/identity/email-provider";
import {
  clearOidcLoginCookie,
  clearOidcSignupCookie,
  consumeOidcLoginAttempt,
  createOidcSignupProof,
  exchangeOidcAuthorizationCode,
  loadOidcConfiguration,
  OidcAuthenticationError,
  type OidcIntent,
  oidcLoginCookieName,
  oidcSignupEnabled,
  setOidcSignupCookie,
  verifyOidcPrincipal,
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

function oidcError(code: string, intent: OidcIntent = "login"): NextResponse {
  const location = new URL(
    intent === "signup" ? "/signup" : intent === "signup-accept" ? "/complete-signup" : "/login",
    configuredAppOrigin(),
  );
  if (intent === "signup-accept") location.searchParams.set("method", "microsoft");
  location.searchParams.set(intent === "login" ? "ssoError" : "microsoftError", code);
  const response = NextResponse.redirect(location, 303);
  for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
  clearOidcLoginCookie(response);
  if (intent !== "login") clearOidcSignupCookie(response);
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
  let intent: OidcIntent = "login";
  try {
    if (process.env.ACCOUNT_LOGIN_ENABLED !== "true" || process.env.AUTH_OIDC_ENABLED !== "true") {
      return oidcError("disabled", intent);
    }
    const configuration = loadOidcConfiguration();
    const query = callbackQuery(request);
    const attempt = consumeOidcLoginAttempt(
      request.cookies.get(oidcLoginCookieName())?.value,
      query.state ?? null,
      configuration,
    );
    intent = attempt.intent;
    if (query.iss !== undefined && query.iss !== configuration.issuer) {
      throw new OidcAuthenticationError("issuer_mismatch");
    }
    if (query.error !== undefined) throw new OidcAuthenticationError("authorization_rejected");
    if (!query.code) throw new OidcAuthenticationError("code_invalid");

    const idToken = await exchangeOidcAuthorizationCode(configuration, query.code, attempt.verifier);
    const principal = await verifyOidcPrincipal(configuration, idToken, attempt.nonce);
    assertAccountAuthenticationConfigured();
    await assertEmailDeliveryReady();

    if (intent === "signup-accept") {
      if (!oidcSignupEnabled()) throw new OidcAuthenticationError("identity_unassigned");
      const location = new URL(attempt.next, configuredAppOrigin());
      location.searchParams.set("method", "microsoft");
      location.searchParams.set("identity", "verified");
      const response = NextResponse.redirect(location, 303);
      for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
      clearOidcLoginCookie(response);
      setOidcSignupCookie(response, createOidcSignupProof(configuration, principal));
      return response;
    }

    const existing = await requestPrincipal(request);
    if (existing?.sessionMode === "real") {
      const response = NextResponse.redirect(new URL("/app", configuredAppOrigin()), 303);
      for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
      clearOidcLoginCookie(response);
      clearOidcSignupCookie(response);
      return response;
    }
    const storedIdentity = await resolveOidcIdentity({
      issuer: principal.issuer,
      externalTenantId: principal.externalTenantId,
      externalPrincipalId: principal.externalPrincipalId,
    });
    const identity = storedIdentity
      ? {
          userId: storedIdentity.user_id,
          organizationId: storedIdentity.organization_id,
          membershipId: storedIdentity.membership_id,
        }
      : principal.mappedIdentity;
    if (!identity) {
      if (intent !== "signup" || !oidcSignupEnabled()) {
        throw new OidcAuthenticationError("identity_unassigned");
      }
      const response = NextResponse.redirect(
        new URL("/signup?method=microsoft", configuredAppOrigin()),
        303,
      );
      for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
      clearOidcLoginCookie(response);
      setOidcSignupCookie(response, createOidcSignupProof(configuration, principal));
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
      credentialHash: principal.credentialHash,
      replacedDemoSessionTokenHash,
    });
    if (!sessionId) throw new OidcAuthenticationError("identity_unassigned");

    const response = NextResponse.redirect(new URL(attempt.next, configuredAppOrigin()), 303);
    for (const [name, value] of Object.entries(noStoreHeaders)) response.headers.set(name, value);
    clearOidcLoginCookie(response);
    clearOidcSignupCookie(response);
    setSessionCookie(response, sessionToken.raw, 24 * 60 * 60);
    return response;
  } catch (error) {
    logRouteFailure("oidc-login", requestId, error);
    return oidcError(publicErrorCode(error), intent);
  }
}

export const GET = observeRouteHandler("oidc-login", get);
