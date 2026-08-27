import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

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
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
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
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        actorId: mocks.principal.userId,
        sessionId: mocks.principal.sessionId,
      }),
    }));
  });

  it("denies the public demo before rate limiting or persistence", async () => {
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
  });
});
