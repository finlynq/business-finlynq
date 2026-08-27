import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(async (
    scope: string,
    keyHash: string,
    limit: number,
    windowSeconds: number,
  ) => {
    void scope;
    void keyHash;
    void limit;
    void windowSeconds;
    return { allowed: true, retry_after_seconds: 0 };
  }),
  principal: vi.fn(),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consume,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.principal,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  demoWritesEnabled: () => true,
}));
vi.mock("@/security/identity-secret", () => ({
  identityLookupHash: (value: string) => `lookup:${value}`,
}));

import { prepareOrganizationAdminMutation } from "@/app/api/_shared/organization-administration-route";

const basePrincipal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Demo business",
  roleLabel: "Demo owner",
  displayName: "Demo owner",
  initials: "DO",
  sessionMode: "demo",
  authMethod: "DEMO_LINK",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue(basePrincipal);
});

describe("organization administration mutation rate key", () => {
  it("survives session rotation but separates organizations and source IPs", async () => {
    const request = (ip: string) => new NextRequest(
      "http://localhost:3000/api/organization/invitations",
      { method: "POST", headers: { "x-forwarded-for": ip } },
    );
    await prepareOrganizationAdminMutation(request("203.0.113.10"), "invite-member");
    const firstKey = mocks.consume.mock.calls[0]?.[1];

    mocks.principal.mockResolvedValueOnce({
      ...basePrincipal,
      sessionId: "20000000-0000-4000-8000-000000000001",
    });
    await prepareOrganizationAdminMutation(request("203.0.113.10"), "invite-member");
    const rotatedSessionKey = mocks.consume.mock.calls[2]?.[1];
    expect(rotatedSessionKey).toBe(firstKey);
    expect(firstKey).toContain(basePrincipal.organizationId);
    expect(firstKey).not.toContain(basePrincipal.sessionId);

    await prepareOrganizationAdminMutation(request("203.0.113.11"), "invite-member");
    expect(mocks.consume.mock.calls[4]?.[1]).not.toBe(firstKey);

    mocks.principal.mockResolvedValueOnce({
      ...basePrincipal,
      organizationId: "30000000-0000-4000-8000-000000000001",
    });
    await prepareOrganizationAdminMutation(request("203.0.113.10"), "invite-member");
    expect(mocks.consume.mock.calls[6]?.[1]).not.toBe(firstKey);
  });
});
