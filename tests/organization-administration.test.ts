import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  assertEmailReady: vi.fn(async () => undefined),
  inviteRecord: vi.fn(async (context, input) => ({
    invitation_id: input.invitationId,
    membership_id: input.membershipId,
    version: 1,
    expires_at: new Date("2026-08-30T00:00:00Z"),
  })),
  updateSettings: vi.fn(async () => 2),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  assertEmailDeliveryReady: mocks.assertEmailReady,
}));
vi.mock("@/modules/identity/member-access-store", () => ({
  assignOrganizationMemberRoleRecord: vi.fn(),
  cancelOrganizationInvitationRecord: vi.fn(),
  inviteOrganizationMemberRecord: mocks.inviteRecord,
  readOrganizationMemberRecords: vi.fn(async () => []),
  readOrganizationSettingsRecord: vi.fn(),
  resendOrganizationInvitationRecord: vi.fn(),
  revokeOrganizationMemberSessionsRecord: vi.fn(),
  setOrganizationMemberActiveRecord: vi.fn(),
  updateOrganizationSettingsRecord: mocks.updateSettings,
}));
vi.mock("@/modules/identity/session", async (original) => {
  const actual = await original<typeof import("@/modules/identity/session")>();
  return {
    ...actual,
    createOpaqueToken: () => ({ raw: "raw-invitation-token", hash: "hashed-invitation-token" }),
    hasRecentStepUp: (principal: SessionPrincipal) => Boolean(principal.stepUpExpiresAt),
  };
});
vi.mock("@/security/identity-secret", () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  identityLookupHash: (value: string) => `lookup-${value}`,
  identityDerivedUuid: () => "50000000-0000-4000-8000-000000000001",
  emailLookupHash: (value: string) => `email-hash-${value}`,
  encryptIdentityField: (value: string, field: string) => `${field}:${value}`,
  decryptIdentityField: (value: string) => value,
  encryptAuthPayload: (value: string) => `payload:${value}`,
}));

import {
  inviteOrganizationMember,
  updateOrganizationProfile,
} from "@/modules/identity/organization-administration";

const realPrincipal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-27T10:00:00Z"),
  stepUpExpiresAt: new Date("2026-08-27T10:10:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_WRITES_ENABLED = "true";
});

describe("organization administration service", () => {
  it("fails before persistence when a real administrator has no fresh MFA step-up", async () => {
    await expect(updateOrganizationProfile({
      principal: { ...realPrincipal, stepUpExpiresAt: null },
      requestId: "request-1",
      displayName: "Updated business",
      expectedVersion: 1,
      reason: "Approved legal name update",
    })).rejects.toMatchObject({ status: 428, code: "MFA_STEP_UP_REQUIRED" });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("creates real invitations with encrypted identity and queued token material", async () => {
    await inviteOrganizationMember({
      principal: realPrincipal,
      requestId: "request-2",
      email: "NEW@Example.com",
      displayName: "New User",
      roleId: "20000000-0000-4000-8000-000000000001",
      reason: "Approved member onboarding",
    });
    expect(mocks.assertEmailReady).toHaveBeenCalledOnce();
    expect(mocks.inviteRecord).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      emailLookupHash: "email-hash-new@example.com",
      emailCiphertext: "email:new@example.com",
      displayNameCiphertext: "display-name:New User",
      tokenHash: "hashed-invitation-token",
      payloadCiphertext: expect.stringContaining("raw-invitation-token"),
    }));
  });

  it("turns demo input into an example.invalid identity and never creates delivery material", async () => {
    await inviteOrganizationMember({
      principal: { ...realPrincipal, sessionMode: "demo", authMethod: "DEMO_LINK", stepUpExpiresAt: null },
      requestId: "request-3",
      email: "possibly-real@example.com",
      displayName: "Sandbox teammate",
      roleId: "20000000-0000-4000-8000-000000000001",
      reason: "Exercise member onboarding",
    });
    expect(mocks.assertEmailReady).not.toHaveBeenCalled();
    const persistence = mocks.inviteRecord.mock.calls[0]?.[1];
    expect(persistence.emailCiphertext).toContain("@example.invalid");
    expect(persistence.emailCiphertext).not.toContain("possibly-real@example.com");
    expect(persistence).toMatchObject({ tokenId: null, tokenHash: null, outboxId: null, payloadCiphertext: null });
  });
});
