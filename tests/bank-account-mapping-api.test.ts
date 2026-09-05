import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  requestPrincipal: vi.fn(),
  sameOrigin: vi.fn(),
  consumeBankingRateLimit: vi.fn(),
  mapBankExternalAccount: vi.fn(),
}));

vi.mock("@/modules/identity/request-security", () => ({ validateSameOriginMutation: mocks.sameOrigin }));
vi.mock("@/modules/identity/session", () => ({ requestPrincipal: mocks.requestPrincipal }));
vi.mock("@/modules/banking/rate-limit", () => ({ consumeBankingRateLimit: mocks.consumeBankingRateLimit }));
vi.mock("@/modules/banking/banking-service", () => ({
  BankingServiceError: class BankingServiceError extends Error {},
  mapBankExternalAccount: mocks.mapBankExternalAccount,
}));

import { PUT as mapAccount } from "@/app/api/banking/accounts/[accountId]/mapping/route";

const ids = {
  session: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  organization: "10000000-0000-4000-8000-000000000003",
  membership: "10000000-0000-4000-8000-000000000004",
  external: "10000000-0000-4000-8000-000000000005",
  entity: "10000000-0000-4000-8000-000000000006",
  ledger: "10000000-0000-4000-8000-000000000007",
  combination: "10000000-0000-4000-8000-000000000008",
};

const principal: SessionPrincipal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Tenant",
  roleLabel: "Preparer",
  displayName: "Preparer",
  initials: "PR",
  sessionMode: "real",
  authMethod: "PASSWORD",
  organizationWritesEnabled: true,
  expiresAt: new Date("2026-09-30T00:00:00.000Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const body = {
  legalEntityId: ids.entity,
  ledgerId: ids.ledger,
  cashAccountCombinationId: ids.combination,
};

function request(payload: unknown): NextRequest {
  return new NextRequest(`https://business.finlynq.com/api/banking/accounts/${ids.external}/mapping`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.consumeBankingRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.mapBankExternalAccount.mockResolvedValue({ accountId: ids.external, mapped: true });
});

describe("bank account mapping API", () => {
  it("accepts an explicit first-mapping kind and forwards it to the service", async () => {
    const response = await mapAccount(request({ ...body, accountKind: "CREDIT_CARD" }), {
      params: Promise.resolve({ accountId: ids.external }),
    });

    expect(response.status).toBe(200);
    expect(mocks.mapBankExternalAccount).toHaveBeenCalledWith(expect.objectContaining({
      ...body,
      accountKind: "CREDIT_CARD",
      externalAccountId: ids.external,
      principal,
    }));
  });

  it("preserves callers that omit accountKind and rejects unknown classifications", async () => {
    const compatible = await mapAccount(request(body), {
      params: Promise.resolve({ accountId: ids.external }),
    });
    expect(compatible.status).toBe(200);
    expect(mocks.mapBankExternalAccount).toHaveBeenCalledWith(expect.not.objectContaining({
      accountKind: expect.anything(),
    }));

    mocks.mapBankExternalAccount.mockClear();
    const invalid = await mapAccount(request({ ...body, accountKind: "LOAN" }), {
      params: Promise.resolve({ accountId: ids.external }),
    });
    expect(invalid.status).toBe(400);
    expect(mocks.mapBankExternalAccount).not.toHaveBeenCalled();
  });
});
