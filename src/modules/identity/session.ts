import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { decryptIdentityField } from "@/security/identity-secret";
import { resolveStoredSession, type StoredPrincipal } from "./auth-store";
import { userAgentFingerprint } from "./request-security";

export type SessionPrincipal = Readonly<{
  sessionId: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  organizationName: string;
  roleLabel: string;
  displayName: string;
  initials: string;
  sessionMode: "real" | "demo";
  authMethod: "PASSWORD" | "DEMO_LINK" | "PASSWORD_RESET";
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  stepUpExpiresAt: Date | null;
  /** Omitted state never authorizes real writes; the database transaction rechecks it. */
  organizationWritesEnabled?: boolean;
}>;

export function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() ||
    (process.env.NODE_ENV === "production" ? "__Host-business_finlynq_session" : "business_finlynq_session");
}

export function createOpaqueToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashOpaqueToken(raw) };
}

export function hashOpaqueToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function principalFromStored(stored: StoredPrincipal): SessionPrincipal {
  if (stored.session_mode === "DEMO") {
    return {
      sessionId: stored.session_id, userId: stored.user_id, organizationId: stored.organization_id,
      membershipId: stored.membership_id, organizationName: stored.organization_name,
      roleLabel: stored.role_label, displayName: "Demo owner", initials: "DO", sessionMode: "demo",
      authMethod: stored.auth_method, expiresAt: new Date(stored.expires_at),
      mfaVerifiedAt: stored.mfa_verified_at ? new Date(stored.mfa_verified_at) : null,
      stepUpExpiresAt: stored.step_up_expires_at ? new Date(stored.step_up_expires_at) : null,
      organizationWritesEnabled: stored.organization_writes_enabled,
    };
  }

  let email = "";
  let displayName = "Business user";
  try {
    email = decryptIdentityField(stored.email_ciphertext, "email", stored.user_id);
    if (stored.display_name_ciphertext) displayName = decryptIdentityField(stored.display_name_ciphertext, "display-name", stored.user_id);
    else displayName = email.split("@")[0] || displayName;
  } catch {
    // Identity display failure must not expose ciphertext or weaken session validity.
  }
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "BU";
  return {
    sessionId: stored.session_id, userId: stored.user_id, organizationId: stored.organization_id,
    membershipId: stored.membership_id, organizationName: stored.organization_name,
    roleLabel: stored.role_label, displayName, initials, sessionMode: "real",
    authMethod: stored.auth_method, expiresAt: new Date(stored.expires_at),
    mfaVerifiedAt: stored.mfa_verified_at ? new Date(stored.mfa_verified_at) : null,
    stepUpExpiresAt: stored.step_up_expires_at ? new Date(stored.step_up_expires_at) : null,
    organizationWritesEnabled: stored.organization_writes_enabled,
  };
}

export function hasRecentStepUp(principal: SessionPrincipal, now = Date.now()): boolean {
  return Boolean(principal.stepUpExpiresAt && principal.stepUpExpiresAt.getTime() > now);
}

/**
 * Authentication provenance for database transaction context. A historical
 * MFA verification never counts as current step-up after its ten-minute
 * window has expired.
 */
export function transactionAuthMethod(principal: SessionPrincipal, now = Date.now()): string {
  if (principal.sessionMode === "demo") return hasRecentStepUp(principal, now) ? "demo-link+mfa" : "demo-link";
  return hasRecentStepUp(principal, now) ? "password+mfa" : "password";
}

export async function resolveSession(rawToken: string | undefined, userAgent: string | null): Promise<SessionPrincipal | null> {
  if (!rawToken || rawToken.length < 32 || rawToken.length > 200) return null;
  const userAgentHash = userAgentFingerprint(userAgent);
  const stored = await resolveStoredSession(hashOpaqueToken(rawToken), userAgentHash);
  if (stored?.session_mode === "REAL" && process.env.ACCOUNT_LOGIN_ENABLED !== "true") return null;
  return stored ? principalFromStored(stored) : null;
}

export async function currentPrincipal(): Promise<SessionPrincipal | null> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveSession(cookieStore.get(sessionCookieName())?.value, headerStore.get("user-agent"));
}

export async function requestPrincipal(request: NextRequest): Promise<SessionPrincipal | null> {
  return resolveSession(request.cookies.get(sessionCookieName())?.value, request.headers.get("user-agent"));
}

export function setSessionCookie(response: NextResponse, rawToken: string, maxAgeSeconds: number): void {
  response.cookies.set(sessionCookieName(), rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
    priority: "high",
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    priority: "high",
  });
}
