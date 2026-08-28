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
}));

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consume,
}));
vi.mock("@/security/identity-secret", () => ({
  identityLookupHash: (value: string) => `lookup:${value}`,
}));

import {
  consumeBankingProviderOrganizationRateLimit,
  consumeBankingRateLimit,
} from "@/modules/banking/rate-limit";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Banking rate limit test",
  roleLabel: "Owner",
  displayName: "Test owner",
  initials: "TO",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-27T00:00:00Z"),
  stepUpExpiresAt: new Date("2026-08-27T01:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
});

describe("banking outbound rate limits", () => {
  it("uses persistent user scopes for live connect and sync", async () => {
    await consumeBankingRateLimit(principal, "connect");

    expect(mocks.consume).toHaveBeenNthCalledWith(
      1,
      "banking-connect-user",
      `lookup:banking-mutation|user|${principal.organizationId}|${principal.userId}|connect`,
      5,
      3600,
    );
    await consumeBankingRateLimit({ ...principal, sessionId: "20000000-0000-4000-8000-000000000001" }, "sync");
    expect(mocks.consume).toHaveBeenNthCalledWith(
      2,
      "banking-sync-user",
      `lookup:banking-mutation|user|${principal.organizationId}|${principal.userId}|sync`,
      12,
      3600,
    );
    for (const call of mocks.consume.mock.calls) {
      expect(call[1]).not.toContain(principal.sessionId);
    }
  });

  it("consumes the tenant aggregate only after service authorization", async () => {
    await consumeBankingProviderOrganizationRateLimit(principal.organizationId, "connect");
    await consumeBankingProviderOrganizationRateLimit(principal.organizationId, "sync");

    expect(mocks.consume).toHaveBeenNthCalledWith(
      1,
      "banking-connect-organization",
      `lookup:banking-mutation|organization|${principal.organizationId}|connect`,
      10,
      3600,
    );
    expect(mocks.consume).toHaveBeenNthCalledWith(
      2,
      "banking-sync-organization",
      `lookup:banking-mutation|organization|${principal.organizationId}|sync`,
      30,
      3600,
    );
  });

  it("keeps non-provider mutations on a persistent organization-and-user key", async () => {
    await consumeBankingRateLimit(principal, "reconciliation");

    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.consume.mock.calls[0]?.[1]).toBe(
      `lookup:banking-mutation|user|${principal.organizationId}|${principal.userId}|reconciliation`,
    );
  });

  it("fails closed when the live-provider organization scope is exhausted", async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false, retry_after_seconds: 47 });

    await expect(consumeBankingProviderOrganizationRateLimit(principal.organizationId, "sync")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 47,
    });
  });
});
