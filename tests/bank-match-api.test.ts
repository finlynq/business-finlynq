import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const ids = {
  reconciliation: "10000000-0000-4000-8000-000000000004",
  observation: "10000000-0000-4000-8000-000000000005",
  line: "10000000-0000-4000-8000-000000000006",
  allocation: "10000000-0000-4000-8000-000000000007",
};

const mocks = vi.hoisted(() => ({
  principal: null as SessionPrincipal | null,
  requestPrincipal: vi.fn(),
  sameOrigin: vi.fn(),
  consumeBankingRateLimit: vi.fn(),
  createBankMatchAllocation: vi.fn(),
}));

vi.mock("@/modules/identity/request-security", () => ({ validateSameOriginMutation: mocks.sameOrigin }));
vi.mock("@/modules/identity/session", () => ({ requestPrincipal: mocks.requestPrincipal }));
vi.mock("@/modules/banking/rate-limit", () => ({ consumeBankingRateLimit: mocks.consumeBankingRateLimit }));
vi.mock("@/modules/banking/banking-service", () => ({
  BankingServiceError: class BankingServiceError extends Error {},
  createBankMatchAllocation: mocks.createBankMatchAllocation,
}));

import { POST as createMatch } from "@/app/api/banking/reconciliations/[reconciliationId]/matches/route";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000008",
  organizationName: "Tenant", roleLabel: "Preparer", displayName: "Preparer", initials: "PR",
  sessionMode: "real", authMethod: "PASSWORD", expiresAt: new Date("2026-08-31T00:00:00Z"),
  mfaVerifiedAt: null, stepUpExpiresAt: null,
};

const body = {
  observationVersionId: ids.observation,
  journalLineId: ids.line,
  allocatedAmount: "25.00",
  idempotencyKey: "bank-match-ui-1",
};

function request(payload: unknown): NextRequest {
  return new NextRequest("https://business.finlynq.com/api/banking/reconciliations/matches", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal = principal;
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.consumeBankingRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.createBankMatchAllocation.mockResolvedValue({ allocationId: ids.allocation, idempotentReplay: false });
});

describe("bank-match allocation route", () => {
  it("requires a bounded key and forwards it with the reconciliation identity", async () => {
    const missing = await createMatch(request({ ...body, idempotencyKey: undefined }), {
      params: Promise.resolve({ reconciliationId: ids.reconciliation }),
    });
    expect(missing.status).toBe(400);
    expect(mocks.createBankMatchAllocation).not.toHaveBeenCalled();

    const response = await createMatch(request(body), {
      params: Promise.resolve({ reconciliationId: ids.reconciliation }),
    });
    expect(response.status).toBe(201);
    expect(mocks.createBankMatchAllocation).toHaveBeenCalledWith(expect.objectContaining({
      principal,
      reconciliationId: ids.reconciliation,
      idempotencyKey: body.idempotencyKey,
    }));
  });

  it("returns the original allocation with 200 for an idempotent replay", async () => {
    mocks.createBankMatchAllocation.mockResolvedValueOnce({ allocationId: ids.allocation, idempotentReplay: true });
    const response = await createMatch(request(body), {
      params: Promise.resolve({ reconciliationId: ids.reconciliation }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allocationId: ids.allocation, idempotentReplay: true });
  });
});
