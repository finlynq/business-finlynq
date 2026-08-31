import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertEmailDeliveryReady } from "@/modules/identity/auth-store";
import {
  assignOrganizationMemberRoleRecord,
  cancelOrganizationInvitationRecord,
  inviteOrganizationMemberRecord,
  readOrganizationMemberRecords,
  readOrganizationSettingsRecord,
  resendOrganizationInvitationRecord,
  revokeOrganizationMemberSessionsRecord,
  setOrganizationMemberActiveRecord,
  updateOrganizationSettingsRecord,
} from "@/modules/identity/member-access-store";
import {
  createOpaqueToken,
  hasRecentStepUp,
  type SessionPrincipal,
} from "@/modules/identity/session";
import {
  demoWritesEnabled,
  mutationContext,
  principalCanWrite,
} from "@/modules/workspace/write-policy";
import { withWorkspaceSessionExpiryRedirect } from "@/modules/workspace/tenant-read";
import {
  decryptIdentityField,
  emailLookupHash,
  encryptAuthPayload,
  encryptIdentityField,
  identityDerivedUuid,
  identityLookupHash,
  normalizeEmail,
} from "@/security/identity-secret";

const roleSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1).max(100),
  displayName: z.string().min(1).max(160),
});

const roleCatalogSchema = z.array(roleSchema).max(20);

export type OrganizationRoleDto = z.infer<typeof roleSchema>;

export type OrganizationMemberDto = Readonly<{
  membershipId: string;
  email: string;
  displayName: string;
  status: "ACTIVE" | "SUSPENDED" | "PENDING" | "CANCELLED" | "SUPERSEDED";
  version: number;
  role: OrganizationRoleDto;
  invitation: Readonly<{
    id: string;
    version: number;
    expiresAt: string;
  }> | null;
  isSelf: boolean;
  activeSessionCount: number;
  lastActiveAt: string | null;
}>;

export type OrganizationAdministrationDto = Readonly<{
  organizationId: string;
  displayName: string;
  settingsVersion: number;
  isDemo: boolean;
  permissions: Readonly<{
    canManageSettings: boolean;
    canReadMembers: boolean;
    canManageMembers: boolean;
    canManageRoles: boolean;
    canManageRecovery: boolean;
  }>;
  assignableRoles: readonly OrganizationRoleDto[];
  members: readonly OrganizationMemberDto[];
  requiresMfaStepUp: boolean;
}>;

export class OrganizationAdministrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 428 | 503,
    readonly code: string,
  ) {
    super(message);
  }
}

function context(principal: SessionPrincipal, requestId: string, reason?: string) {
  return mutationContext(principal, requestId, { reason, sourceSurface: "UI" });
}

function assertMutationSession(principal: SessionPrincipal): void {
  if (principal.sessionMode === "demo") {
    if (!demoWritesEnabled()) {
      throw new OrganizationAdministrationError(
        "Demo changes are not available on this deployment.",
        403,
        "DEMO_WRITES_DISABLED",
      );
    }
    return;
  }
  if (!principalCanWrite(principal)) {
    throw new OrganizationAdministrationError(
      "Business changes are disabled on this deployment.",
      403,
      "WRITES_DISABLED",
    );
  }
  if (!hasRecentStepUp(principal)) {
    throw new OrganizationAdministrationError(
      "Verify your authenticator code before changing organization access.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
}

function safeIdentity(
  envelope: string | null,
  field: "email" | "display-name",
  userId: string,
  fallback: string,
): string {
  if (!envelope) return fallback;
  try {
    return decryptIdentityField(envelope, field, userId);
  } catch {
    return fallback;
  }
}

function memberStatus(record: Awaited<ReturnType<typeof readOrganizationMemberRecords>>[number]): OrganizationMemberDto["status"] {
  if (record.membership_active) return "ACTIVE";
  if (record.invitation_status === "PENDING") return "PENDING";
  if (record.invitation_status === "CANCELLED") return "CANCELLED";
  if (record.invitation_status === "SUPERSEDED") return "SUPERSEDED";
  return "SUSPENDED";
}

export async function loadOrganizationAdministration(
  principal: SessionPrincipal,
): Promise<OrganizationAdministrationDto> {
  const readContext = context(principal, randomUUID());
  const settings = await withWorkspaceSessionExpiryRedirect(
    "/app/settings",
    () => readOrganizationSettingsRecord(readContext),
  );
  if (!settings) {
    throw new OrganizationAdministrationError(
      "Organization settings are unavailable.",
      403,
      "SETTINGS_UNAVAILABLE",
    );
  }
  const assignableRoles = roleCatalogSchema.parse(settings.assignable_roles);
  const records = settings.can_read_members
    ? await withWorkspaceSessionExpiryRedirect(
        "/app/settings",
        () => readOrganizationMemberRecords(readContext),
      )
    : [];
  const members = records.map((record, index): OrganizationMemberDto => {
    const syntheticEmail = `demo-member-${index + 1}@example.invalid`;
    const fallbackEmail = settings.is_demo ? syntheticEmail : "Identity unavailable";
    const fallbackName = settings.is_demo ? `Demo member ${index + 1}` : "Business user";
    return {
      membershipId: record.membership_id,
      email: safeIdentity(record.email_ciphertext, "email", record.user_id, fallbackEmail),
      displayName: safeIdentity(record.display_name_ciphertext, "display-name", record.user_id, fallbackName),
      status: memberStatus(record),
      version: record.administration_version,
      role: {
        id: record.role_id,
        key: record.role_key,
        displayName: record.role_name,
      },
      invitation: record.invitation_id && record.invitation_version !== null && record.invitation_expires_at
        ? {
            id: record.invitation_id,
            version: record.invitation_version,
            expiresAt: record.invitation_expires_at.toISOString(),
          }
        : null,
      isSelf: record.is_self,
      activeSessionCount: Number(record.active_session_count),
      lastActiveAt: record.last_active_at?.toISOString() ?? null,
    };
  });

  return {
    organizationId: settings.organization_id,
    displayName: settings.display_name,
    settingsVersion: settings.settings_version,
    isDemo: settings.is_demo,
    permissions: {
      canManageSettings: settings.can_manage_settings,
      canReadMembers: settings.can_read_members,
      canManageMembers: settings.can_manage_members,
      canManageRoles: settings.can_manage_roles,
      canManageRecovery: settings.can_manage_recovery,
    },
    assignableRoles,
    members,
    requiresMfaStepUp: principal.sessionMode === "real" && !hasRecentStepUp(principal),
  };
}

export async function updateOrganizationProfile(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  displayName: string;
  expectedVersion: number;
  reason: string;
}>): Promise<Readonly<{ version: number }>> {
  assertMutationSession(input.principal);
  const version = await updateOrganizationSettingsRecord(
    context(input.principal, input.requestId, input.reason),
    { displayName: input.displayName, expectedVersion: input.expectedVersion },
  );
  return { version };
}

function invitationIdentity(principal: SessionPrincipal, email: string) {
  const normalized = normalizeEmail(email);
  if (principal.sessionMode === "real") {
    return { email: normalized, lookupHash: emailLookupHash(normalized) };
  }
  const fingerprint = identityLookupHash(
    `demo-organization-invitation|${principal.organizationId}|${normalized}`,
  ).slice(0, 20);
  const synthetic = `sandbox-${fingerprint}@example.invalid`;
  return { email: synthetic, lookupHash: emailLookupHash(synthetic) };
}

export async function inviteOrganizationMember(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  email: string;
  displayName: string;
  roleId: string;
  reason: string;
}>): Promise<Readonly<{ invitationId: string; membershipId: string; version: number; expiresAt: string }>> {
  assertMutationSession(input.principal);
  if (input.principal.sessionMode === "real") await assertEmailDeliveryReady();

  const membershipId = randomUUID();
  const invitationId = randomUUID();
  const identity = invitationIdentity(input.principal, input.email);
  const userId = input.principal.sessionMode === "real"
    ? identityDerivedUuid("account-user", identity.lookupHash)
    : randomUUID();
  const token = input.principal.sessionMode === "real" ? createOpaqueToken() : null;
  const tokenId = token ? randomUUID() : null;
  const outboxId = token ? randomUUID() : null;
  const result = await inviteOrganizationMemberRecord(
    context(input.principal, input.requestId, input.reason),
    {
      roleId: input.roleId,
      userId,
      membershipId,
      invitationId,
      emailLookupHash: identity.lookupHash,
      emailCiphertext: encryptIdentityField(identity.email, "email", userId),
      displayNameCiphertext: encryptIdentityField(input.displayName, "display-name", userId),
      tokenId,
      tokenHash: token?.hash ?? null,
      outboxId,
      payloadCiphertext: token && outboxId
        ? encryptAuthPayload(JSON.stringify({ token: token.raw }), "email-payload", outboxId)
        : null,
    },
  );
  return {
    invitationId: result.invitation_id,
    membershipId: result.membership_id,
    version: result.version,
    expiresAt: result.expires_at.toISOString(),
  };
}

export async function resendOrganizationInvitation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  invitationId: string;
  expectedVersion: number;
  reason: string;
}>): Promise<Readonly<{ version: number; expiresAt: string }>> {
  assertMutationSession(input.principal);
  if (input.principal.sessionMode === "real") await assertEmailDeliveryReady();
  const token = input.principal.sessionMode === "real" ? createOpaqueToken() : null;
  const tokenId = token ? randomUUID() : null;
  const outboxId = token ? randomUUID() : null;
  const result = await resendOrganizationInvitationRecord(
    context(input.principal, input.requestId, input.reason),
    {
      invitationId: input.invitationId,
      expectedVersion: input.expectedVersion,
      tokenId,
      tokenHash: token?.hash ?? null,
      outboxId,
      payloadCiphertext: token && outboxId
        ? encryptAuthPayload(JSON.stringify({ token: token.raw }), "email-payload", outboxId)
        : null,
    },
  );
  return { version: result.version, expiresAt: result.expires_at.toISOString() };
}

export async function cancelOrganizationInvitation(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  invitationId: string;
  expectedVersion: number;
  reason: string;
}>): Promise<Readonly<{ version: number }>> {
  assertMutationSession(input.principal);
  const version = await cancelOrganizationInvitationRecord(
    context(input.principal, input.requestId, input.reason),
    input.invitationId,
    input.expectedVersion,
  );
  return { version };
}

export async function assignOrganizationMemberRole(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  membershipId: string;
  roleId: string;
  expectedVersion: number;
  reason: string;
}>): Promise<Readonly<{ version: number }>> {
  assertMutationSession(input.principal);
  const version = await assignOrganizationMemberRoleRecord(
    context(input.principal, input.requestId, input.reason),
    input,
  );
  return { version };
}

export async function setOrganizationMemberActive(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  membershipId: string;
  expectedVersion: number;
  active: boolean;
  reason: string;
}>): Promise<Readonly<{ version: number }>> {
  assertMutationSession(input.principal);
  const version = await setOrganizationMemberActiveRecord(
    context(input.principal, input.requestId, input.reason),
    input,
  );
  return { version };
}

export async function revokeOrganizationMemberSessions(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  membershipId: string;
  reason: string;
}>): Promise<Readonly<{ revokedCount: number }>> {
  assertMutationSession(input.principal);
  const revokedCount = await revokeOrganizationMemberSessionsRecord(
    context(input.principal, input.requestId, input.reason),
    input.membershipId,
  );
  return { revokedCount };
}

export function organizationAdministrationFailure(error: unknown): OrganizationAdministrationError {
  if (error instanceof OrganizationAdministrationError) return error;
  const message = error instanceof Error ? error.message : "";
  const sqlState = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (/fresh MFA|step-up|authenticator/i.test(message)) {
    return new OrganizationAdministrationError(
      "Verify your authenticator code before changing organization access.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
  if (sqlState === "28000" || /requires an active session|session mode is invalid/i.test(message)) {
    return new OrganizationAdministrationError(
      "Your secure session is no longer valid. Sign in again and retry the change.",
      401,
      "SESSION_INVALID",
    );
  }
  if (sqlState === "42501") {
    return new OrganizationAdministrationError(
      "Your current role cannot perform this organization change.",
      403,
      "PERMISSION_DENIED",
    );
  }
  if (sqlState === "22023" || sqlState === "23514") {
    return new OrganizationAdministrationError(
      "The accounting configuration is invalid. Review the values and try again.",
      400,
      "INVALID_CONFIGURATION",
    );
  }
  if (["23505", "40001", "55000"].includes(sqlState)) {
    return new OrganizationAdministrationError(
      "That accounting configuration already exists or conflicts with the current setup. Refresh and try again.",
      409,
      "CONFIGURATION_CONFLICT",
    );
  }
  if (/permission|required|active administrator/i.test(message)) {
    return new OrganizationAdministrationError(
      "Your current role cannot perform this organization change.",
      403,
      "PERMISSION_DENIED",
    );
  }
  if (/version|changed by another|last active|already|cannot be invited|pending invitation|member limit/i.test(message)) {
    return new OrganizationAdministrationError(
      "The organization access record changed or the requested transition is not allowed. Refresh and try again.",
      409,
      "ACCESS_CONFLICT",
    );
  }
  if (/role|display name|member|invitation/i.test(message)) {
    return new OrganizationAdministrationError(
      "The organization access request is invalid.",
      400,
      "INVALID_ACCESS_REQUEST",
    );
  }
  return new OrganizationAdministrationError(
    "Organization administration is temporarily unavailable.",
    503,
    "ADMINISTRATION_UNAVAILABLE",
  );
}
