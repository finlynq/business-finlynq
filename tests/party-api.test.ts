import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const previousDemoWrites = process.env.DEMO_WRITES_ENABLED;
process.env.BUSINESS_WRITES_ENABLED = "true";
process.env.DEMO_WRITES_ENABLED = "false";
afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
  if (previousDemoWrites === undefined) delete process.env.DEMO_WRITES_ENABLED;
  else process.env.DEMO_WRITES_ENABLED = previousDemoWrites;
});

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
    createParty: vi.fn(async () => ({
      party: {
        id: "30000000-0000-4000-8000-000000000001",
        partyNumber: "CUST-1001",
        displayName: "Maple Studio",
        active: true,
        internalLegalEntityId: null,
      },
      partyAccount: {
        id: "30000000-0000-4000-8000-000000000002",
        legalEntityId: "40000000-0000-4000-8000-000000000001",
        ledgerId: "40000000-0000-4000-8000-000000000002",
        role: "CUSTOMER" as const,
        accountNumber: "C-CA-1001",
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
  createParty: mocks.createParty,
}));

import { POST as createParty } from "@/app/api/parties/route";

const body = {
  partyNumber: "cust-1001",
  displayName: "Maple Studio",
  idempotencyKey: "party-request-1",
  account: {
    legalEntityId: "40000000-0000-4000-8000-000000000001",
    ledgerId: "40000000-0000-4000-8000-000000000002",
    role: "CUSTOMER" as const,
    accountNumber: "c-ca-1001",
    controlAccountId: "40000000-0000-4000-8000-000000000003",
    transactionCurrency: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  process.env.DEMO_WRITES_ENABLED = "false";
});

describe("tenant party mutation route", () => {
  it("passes the real session, bounded fields, and durable idempotency key to encrypted persistence", async () => {
    const response = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(201);
    expect(mocks.consumeLimit).toHaveBeenCalledWith(mocks.principal, "party");
    expect(mocks.createParty).toHaveBeenCalledWith(expect.objectContaining({
      partyNumber: "cust-1001",
      displayName: "Maple Studio",
      idempotencyKey: "party-request-1",
      account: body.account,
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        actorId: mocks.principal.userId,
        sessionId: mocks.principal.sessionId,
      }),
    }));
  });

  it("denies a demo mutation when writable sandboxes are disabled", async () => {
    mocks.requestPrincipal.mockResolvedValueOnce({ ...mocks.principal, sessionMode: "demo" as const });
    const response = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(403);
    expect(mocks.consumeLimit).not.toHaveBeenCalled();
    expect(mocks.createParty).not.toHaveBeenCalled();
  });

  it("passes a writable demo principal to sandbox-validated persistence", async () => {
    process.env.DEMO_WRITES_ENABLED = "true";
    const demoPrincipal = { ...mocks.principal, sessionMode: "demo" as const };
    mocks.requestPrincipal.mockResolvedValueOnce(demoPrincipal);
    const response = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(201);
    expect(mocks.consumeLimit).toHaveBeenCalledWith(demoPrincipal, "party");
    expect(mocks.createParty).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        organizationId: demoPrincipal.organizationId,
        sessionId: demoPrincipal.sessionId,
      }),
    }));
  });

  it("fails closed for cross-site, oversized, and rate-limited mutations", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossSite = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify(body),
    }));
    expect(crossSite.status).toBe(403);

    const oversized = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "32001" },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);

    mocks.consumeLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 31 });
    const limited = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("31");
    expect(mocks.createParty).not.toHaveBeenCalled();
  });

  it("rejects malformed master data without reaching persistence", async () => {
    const response = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, idempotencyKey: "" }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.createParty).not.toHaveBeenCalled();

    const partyWithoutAccount = {
      partyNumber: body.partyNumber,
      displayName: body.displayName,
      idempotencyKey: body.idempotencyKey,
    };
    const missingAccount = await createParty(new NextRequest("https://business.finlynq.com/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partyWithoutAccount),
    }));
    expect(missingAccount.status).toBe(400);
    expect(mocks.createParty).not.toHaveBeenCalled();
  });
});
