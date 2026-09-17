import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(async () => ({ allowed: true, retry_after_seconds: 0 })),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consume,
}));
vi.mock("@/security/identity-secret", () => ({
  identityLookupHash: (value: string) => `lookup:${value}`,
}));

import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Mutation limit test",
  roleLabel: "Owner",
  displayName: "Test owner",
  initials: "TO",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-18T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-09-17T20:00:00Z"),
  stepUpExpiresAt: new Date("2026-09-17T21:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
});

describe("ledger mutation rate limits", () => {
  it("keeps real-account daily limits bound to the durable user identity", async () => {
    await consumeLedgerMutationRateLimit(principal, "create");

    expect(mocks.consume).toHaveBeenNthCalledWith(
      1,
      "ledger-create-session-minute",
      `lookup:ledger-mutation-session|${principal.organizationId}|${principal.sessionId}|create`,
      30,
      60,
    );
    expect(mocks.consume).toHaveBeenNthCalledWith(
      2,
      "ledger-create-actor-day",
      `lookup:ledger-mutation-actor|${principal.organizationId}|${principal.userId}|create`,
      300,
      86_400,
    );
  });

  it("isolates reusable public-demo actors by their leased session", async () => {
    const demoPrincipal = {
      ...principal,
      sessionMode: "demo" as const,
      authMethod: "DEMO_LINK" as const,
    };

    await consumeLedgerMutationRateLimit(demoPrincipal, "create");

    expect(mocks.consume).toHaveBeenNthCalledWith(
      2,
      "ledger-create-actor-day",
      `lookup:ledger-mutation-actor|${principal.organizationId}|demo-session:${principal.sessionId}|create`,
      300,
      86_400,
    );
  });

  it("fails closed for either exhausted bucket and returns the longest retry", async () => {
    mocks.consume
      .mockResolvedValueOnce({ allowed: false, retry_after_seconds: 12 })
      .mockResolvedValueOnce({ allowed: false, retry_after_seconds: 45 });

    await expect(consumeLedgerMutationRateLimit(principal, "post")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });
  });
});
