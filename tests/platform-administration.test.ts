import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const mocks = vi.hoisted(() => ({
  queryDatabase: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.queryDatabase }));
vi.mock("@/security/identity-secret", () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  emailLookupHash: (value: string) => `hash:${value}`,
  decryptIdentityField: (value: string) => value.replace(/^encrypted:email:[^:]+:/, ""),
  identityDerivedUuid: () => "50000000-0000-4000-8000-000000000001",
  encryptIdentityField: (value: string, field: string, id: string) => `encrypted:${field}:${id}:${value}`,
}));

import {
  PLATFORM_ADMINISTRATOR_ROLE,
  provisionPlatformAdministratorGrant,
} from "@/modules/identity/platform-administrator-provisioning";
import {
  loadPlatformAdministrationOverview,
  platformAdministratorAuthorization,
  platformAdministratorHasFreshStepUp,
} from "@/modules/identity/platform-administration";

function clientWithRows(rowsByCall: readonly unknown[][]): PoolClient {
  let call = 0;
  return {
    query: vi.fn(async () => ({ rows: rowsByCall[call++] ?? [], rowCount: 0 })),
  } as unknown as PoolClient;
}

describe("platform administrator grants", () => {
  it("reserves an encrypted pending grant without creating an identity", async () => {
    const client = clientWithRows([[], [], [], [{ effective: false }]]);
    const result = await provisionPlatformAdministratorGrant(client, {
      email: "  ADMIN@Example.com ",
      grantedBy: "operator:release-admin",
      reason: "Approved initial control-plane administrator",
      requestId: "request-1",
    });
    expect(result).toEqual({
      grantId: "50000000-0000-4000-8000-000000000001",
      roleKey: PLATFORM_ADMINISTRATOR_ROLE,
      state: "PENDING_IDENTITY",
      created: true,
    });
    const calls = vi.mocked(client.query).mock.calls;
    expect(calls[2]?.[0]).toContain("INSERT INTO platform_administrator_grants");
    expect(calls[2]?.[1]).toContain("hash:admin@example.com");
    expect(calls[2]?.[1]).toContain(
      "encrypted:email:50000000-0000-4000-8000-000000000001:admin@example.com",
    );
    expect(JSON.stringify(result)).not.toContain("admin@example.com");
  });

  it("is idempotent for an existing active-intent grant and never silently restores revocation", async () => {
    const active = clientWithRows([[], [{
      id: "50000000-0000-4000-8000-000000000001",
      role_key: PLATFORM_ADMINISTRATOR_ROLE,
      status: "GRANTED",
      linked_user_id: "60000000-0000-4000-8000-000000000001",
      email_ciphertext: "encrypted:email:50000000-0000-4000-8000-000000000001:admin@example.com",
      effective: true,
    }]]);
    await expect(provisionPlatformAdministratorGrant(active, {
      email: "admin@example.com",
      grantedBy: "operator:release-admin",
      reason: "Approved initial control-plane administrator",
      requestId: "request-2",
    })).resolves.toMatchObject({ state: "ACTIVE", created: false });

    const revoked = clientWithRows([[], [{
      id: "50000000-0000-4000-8000-000000000001",
      role_key: PLATFORM_ADMINISTRATOR_ROLE,
      status: "REVOKED",
      linked_user_id: null,
      email_ciphertext: "encrypted:email:50000000-0000-4000-8000-000000000001:admin@example.com",
      effective: false,
    }]]);
    await expect(provisionPlatformAdministratorGrant(revoked, {
      email: "admin@example.com",
      grantedBy: "operator:release-admin",
      reason: "Approved initial control-plane administrator",
      requestId: "request-3",
    })).rejects.toThrow(/separate reviewed reauthorization/);
  });

  it("recognizes only a real authenticated session and reports step-up separately", async () => {
    mocks.queryDatabase.mockResolvedValueOnce({ rows: [{
      grant_id: "50000000-0000-4000-8000-000000000001",
      role_key: PLATFORM_ADMINISTRATOR_ROLE,
      mfa_verified_at: new Date("2026-08-27T12:00:00Z"),
      step_up_expires_at: new Date("2026-08-27T12:10:00Z"),
    }] });
    const authorization = await platformAdministratorAuthorization({
      sessionId: "70000000-0000-4000-8000-000000000001",
      userId: "60000000-0000-4000-8000-000000000001",
      sessionMode: "real",
    });
    expect(authorization?.roleKey).toBe(PLATFORM_ADMINISTRATOR_ROLE);
    expect(platformAdministratorHasFreshStepUp(authorization!, Date.parse("2026-08-27T12:09:59Z"))).toBe(true);
    expect(platformAdministratorHasFreshStepUp(authorization!, Date.parse("2026-08-27T12:10:00Z"))).toBe(false);

    mocks.queryDatabase.mockClear();
    await expect(platformAdministratorAuthorization({
      sessionId: "70000000-0000-4000-8000-000000000002",
      userId: "60000000-0000-4000-8000-000000000002",
      sessionMode: "demo",
    })).resolves.toBeNull();
    expect(mocks.queryDatabase).not.toHaveBeenCalled();
  });

  it("loads only aggregate control-plane metadata through live database authorization", async () => {
    mocks.queryDatabase.mockResolvedValueOnce({ rows: [{
      active_real_organization_count: "3",
      active_real_user_count: "12",
      active_real_session_count: "5",
      pending_platform_administrator_count: "1",
      linked_platform_administrator_count: "2",
      generated_at: new Date("2026-08-27T12:00:00Z"),
    }] });
    await expect(loadPlatformAdministrationOverview({
      sessionId: "70000000-0000-4000-8000-000000000001",
      userId: "60000000-0000-4000-8000-000000000001",
      sessionMode: "real",
    })).resolves.toEqual({
      activeRealOrganizationCount: "3",
      activeRealUserCount: "12",
      activeRealSessionCount: "5",
      pendingPlatformAdministratorCount: "1",
      linkedPlatformAdministratorCount: "2",
      generatedAt: new Date("2026-08-27T12:00:00Z"),
    });
    expect(mocks.queryDatabase).toHaveBeenCalledWith(
      "SELECT * FROM app.platform_administration_overview($1,$2)",
      [
        "70000000-0000-4000-8000-000000000001",
        "60000000-0000-4000-8000-000000000001",
      ],
    );

    mocks.queryDatabase.mockClear();
    await expect(loadPlatformAdministrationOverview({
      sessionId: "70000000-0000-4000-8000-000000000002",
      userId: "60000000-0000-4000-8000-000000000002",
      sessionMode: "demo",
    })).resolves.toBeNull();
    expect(mocks.queryDatabase).not.toHaveBeenCalled();
  });
});
