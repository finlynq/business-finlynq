import "server-only";

import { queryDatabase } from "@/db/transaction";
import type { SessionPrincipal } from "./session";
import { PLATFORM_ADMINISTRATOR_ROLE } from "./platform-administrator-provisioning";

export { PLATFORM_ADMINISTRATOR_ROLE } from "./platform-administrator-provisioning";

export type PlatformAdministratorAuthorization = Readonly<{
  grantId: string;
  roleKey: typeof PLATFORM_ADMINISTRATOR_ROLE;
  mfaVerifiedAt: Date;
  stepUpExpiresAt: Date | null;
}>;

type AuthorizationRecord = Readonly<{
  grant_id: string;
  role_key: typeof PLATFORM_ADMINISTRATOR_ROLE;
  mfa_verified_at: Date;
  step_up_expires_at: Date | null;
}>;

export type PlatformAdministrationOverview = Readonly<{
  activeRealOrganizationCount: string;
  activeRealUserCount: string;
  activeRealSessionCount: string;
  pendingPlatformAdministratorCount: string;
  linkedPlatformAdministratorCount: string;
  generatedAt: Date;
}>;

type PlatformAdministrationOverviewRecord = Readonly<{
  active_real_organization_count: string;
  active_real_user_count: string;
  active_real_session_count: string;
  pending_platform_administrator_count: string;
  linked_platform_administrator_count: string;
  generated_at: Date;
}>;

/** Resolve a platform role from an already-authenticated real session. */
export async function platformAdministratorAuthorization(
  principal: Pick<SessionPrincipal, "sessionId" | "userId" | "sessionMode">,
): Promise<PlatformAdministratorAuthorization | null> {
  if (principal.sessionMode !== "real") return null;
  const result = await queryDatabase<AuthorizationRecord>(
    "SELECT * FROM app.auth_platform_administrator_authorization($1,$2)",
    [principal.sessionId, principal.userId],
  );
  const row = result.rows[0];
  if (!row || row.role_key !== PLATFORM_ADMINISTRATOR_ROLE) return null;
  return {
    grantId: row.grant_id,
    roleKey: row.role_key,
    mfaVerifiedAt: new Date(row.mfa_verified_at),
    stepUpExpiresAt: row.step_up_expires_at ? new Date(row.step_up_expires_at) : null,
  };
}

export function platformAdministratorHasFreshStepUp(
  authorization: PlatformAdministratorAuthorization,
  now = Date.now(),
): boolean {
  return Boolean(authorization.stepUpExpiresAt && authorization.stepUpExpiresAt.getTime() > now);
}

/**
 * Read aggregate control-plane health through one database unit that repeats
 * live platform authorization. No tenant names, identities, or accounting
 * records cross this boundary.
 */
export async function loadPlatformAdministrationOverview(
  principal: Pick<SessionPrincipal, "sessionId" | "userId" | "sessionMode">,
): Promise<PlatformAdministrationOverview | null> {
  if (principal.sessionMode !== "real") return null;
  const result = await queryDatabase<PlatformAdministrationOverviewRecord>(
    "SELECT * FROM app.platform_administration_overview($1,$2)",
    [principal.sessionId, principal.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    activeRealOrganizationCount: row.active_real_organization_count,
    activeRealUserCount: row.active_real_user_count,
    activeRealSessionCount: row.active_real_session_count,
    pendingPlatformAdministratorCount: row.pending_platform_administrator_count,
    linkedPlatformAdministratorCount: row.linked_platform_administrator_count,
    generatedAt: new Date(row.generated_at),
  };
}
