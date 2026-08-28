import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
process.env.BUSINESS_WRITES_ENABLED = "true";

const mocks = vi.hoisted(() => {
  const principal: SessionPrincipal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Tenant",
    roleLabel: "Owner",
    displayName: "Owner",
    initials: "OW",
    sessionMode: "real",
    authMethod: "PASSWORD",
    expiresAt: new Date("2026-08-27T00:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  return {
    principal,
    requestPrincipal: vi.fn(async (): Promise<SessionPrincipal | null> => principal),
    transactionAuthMethod: vi.fn(() => "password"),
    sameOrigin: vi.fn(() => true),
    consumeLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    addPartyAccount: vi.fn(async () => ({
      partyAccount: {
        id: "30000000-0000-4000-8000-000000000001",
        legalEntityId: "40000000-0000-4000-8000-000000000001",
        ledgerId: "40000000-0000-4000-8000-000000000002",
        role: "CUSTOMER" as const,
        accountNumber: "C-US-1001",
        controlAccountId: "40000000-0000-4000-8000-000000000003",
        transactionCurrency: null,
      },
      idempotentReplay: false,
    })),
  };
});

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.sameOrigin,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  transactionAuthMethod: mocks.transactionAuthMethod,
}));
vi.mock("@/modules/ledger/mutation-rate-limit", () => ({
  consumeLedgerMutationRateLimit: mocks.consumeLimit,
}));
vi.mock("@/modules/parties/party-service", () => ({
  addPartyAccount: mocks.addPartyAccount,
}));

import { POST } from "@/app/api/parties/[partyId]/accounts/route";

const partyId = "50000000-0000-4000-8000-000000000001";
const body = {
  idempotencyKey: "attach-us-customer",
  account: {
    legalEntityId: "40000000-0000-4000-8000-000000000001",
    ledgerId: "40000000-0000-4000-8000-000000000002",
    role: "CUSTOMER" as const,
    accountNumber: "C-US-1001",
    controlAccountId: "40000000-0000-4000-8000-000000000003",
    transactionCurrency: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("party legal-entity account route", () => {
  it("attaches a role to the existing organization party through a bounded tenant mutation", async () => {
    const response = await POST(new NextRequest(
      `https://business.finlynq.com/api/parties/${partyId}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ), { params: Promise.resolve({ partyId }) });

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.consumeLimit).toHaveBeenCalledWith(mocks.principal, "party");
    expect(mocks.addPartyAccount).toHaveBeenCalledWith(expect.objectContaining({
      partyId,
      idempotencyKey: body.idempotencyKey,
      account: body.account,
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        actorId: mocks.principal.userId,
        sessionId: mocks.principal.sessionId,
      }),
    }));
  });

  it("fails closed before persistence for cross-site and malformed commands", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossSite = await POST(new NextRequest(
      `https://business.finlynq.com/api/parties/${partyId}/accounts`,
      { method: "POST", body: JSON.stringify(body) },
    ), { params: Promise.resolve({ partyId }) });
    expect(crossSite.status).toBe(403);

    const malformed = await POST(new NextRequest(
      `https://business.finlynq.com/api/parties/${partyId}/accounts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, account: { ...body.account, accountNumber: "bad number" } }),
      },
    ), { params: Promise.resolve({ partyId }) });
    expect(malformed.status).toBe(400);
    expect(mocks.addPartyAccount).not.toHaveBeenCalled();

    const invalidParty = await POST(new NextRequest(
      "https://business.finlynq.com/api/parties/not-a-uuid/accounts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ), { params: Promise.resolve({ partyId: "not-a-uuid" }) });
    expect(invalidParty.status).toBe(400);
    expect(mocks.addPartyAccount).not.toHaveBeenCalled();
  });
});
