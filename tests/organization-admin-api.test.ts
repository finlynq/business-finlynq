import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => {
  const principal: SessionPrincipal = {
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
    mfaVerifiedAt: new Date("2026-08-27T00:00:00Z"),
    stepUpExpiresAt: new Date("2026-08-27T00:10:00Z"),
  };
  return {
    principal,
    prepare: vi.fn(async () => ({ principal })),
    readJson: vi.fn(),
    updateProfile: vi.fn(async (input: Record<string, unknown>) => { void input; return { version: 2 }; }),
    invite: vi.fn(async (input: Record<string, unknown>) => { void input; return { invitationId: "40000000-0000-4000-8000-000000000001" }; }),
    assignRole: vi.fn(async (input: Record<string, unknown>) => { void input; return { version: 3 }; }),
    setActive: vi.fn(async (input: Record<string, unknown>) => { void input; return { version: 3 }; }),
    revokeSessions: vi.fn(async (input: Record<string, unknown>) => { void input; return { revokedCount: 2 }; }),
  };
});

vi.mock("@/app/api/_shared/organization-administration-route", () => ({
  organizationAdminHeaders: { "Cache-Control": "private, no-store" },
  prepareOrganizationAdminMutation: mocks.prepare,
  readOrganizationAdminJson: mocks.readJson,
  organizationAdminErrorResponse: () => NextResponse.json({ error: "failed" }, { status: 503 }),
}));
vi.mock("@/modules/identity/organization-administration", () => ({
  updateOrganizationProfile: mocks.updateProfile,
  inviteOrganizationMember: mocks.invite,
  assignOrganizationMemberRole: mocks.assignRole,
  setOrganizationMemberActive: mocks.setActive,
  revokeOrganizationMemberSessions: mocks.revokeSessions,
  resendOrganizationInvitation: vi.fn(),
  cancelOrganizationInvitation: vi.fn(),
}));

import { PATCH as updateSettings } from "@/app/api/organization/settings/route";
import { POST as inviteMember } from "@/app/api/organization/invitations/route";
import { PATCH as updateMember } from "@/app/api/organization/members/[membershipId]/route";

beforeEach(() => vi.clearAllMocks());

describe("organization administration API", () => {
  it("binds profile updates to the authenticated principal and a server request id", async () => {
    mocks.readJson.mockResolvedValueOnce({ data: {
      displayName: "Updated Business",
      expectedVersion: 1,
      reason: "Approved organization name",
    } });
    const response = await updateSettings(new NextRequest("https://business.finlynq.com/api/organization/settings", { method: "PATCH" }));
    expect(response.status).toBe(200);
    expect(mocks.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      principal: mocks.principal,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: 1,
    }));
  });

  it("never accepts organization or actor identifiers in the invitation service contract", async () => {
    mocks.readJson.mockResolvedValueOnce({ data: {
      email: "user@example.com",
      displayName: "User",
      roleId: "20000000-0000-4000-8000-000000000001",
      reason: "Approved member invitation",
    } });
    const response = await inviteMember(new NextRequest("https://business.finlynq.com/api/organization/invitations", { method: "POST" }));
    expect(response.status).toBe(201);
    const input = mocks.invite.mock.calls[0]?.[0];
    expect(input?.principal).toBe(mocks.principal);
    expect(input).not.toHaveProperty("organizationId");
    expect(input).not.toHaveProperty("actorId");
  });

  it("dispatches fixed-role and session-revocation actions only for a validated path member", async () => {
    const membershipId = "30000000-0000-4000-8000-000000000001";
    mocks.readJson.mockResolvedValueOnce({ data: {
      action: "ASSIGN_ROLE",
      roleId: "20000000-0000-4000-8000-000000000002",
      expectedVersion: 2,
      reason: "Approved role change",
    } });
    const assigned = await updateMember(
      new NextRequest(`https://business.finlynq.com/api/organization/members/${membershipId}`, { method: "PATCH" }),
      { params: Promise.resolve({ membershipId }) },
    );
    expect(assigned.status).toBe(200);
    expect(mocks.assignRole).toHaveBeenCalledWith(expect.objectContaining({ membershipId, expectedVersion: 2 }));

    mocks.readJson.mockResolvedValueOnce({ data: { action: "REVOKE_SESSIONS", reason: "Security access review" } });
    await updateMember(
      new NextRequest(`https://business.finlynq.com/api/organization/members/${membershipId}`, { method: "PATCH" }),
      { params: Promise.resolve({ membershipId }) },
    );
    expect(mocks.revokeSessions).toHaveBeenCalledWith(expect.objectContaining({ membershipId }));
  });

  it("rejects a malformed member path before a service can change access", async () => {
    mocks.readJson.mockResolvedValueOnce({ data: { action: "SUSPEND", expectedVersion: 1, reason: "Approved suspension" } });
    const response = await updateMember(
      new NextRequest("https://business.finlynq.com/api/organization/members/not-a-uuid", { method: "PATCH" }),
      { params: Promise.resolve({ membershipId: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.setActive).not.toHaveBeenCalled();
  });
});
