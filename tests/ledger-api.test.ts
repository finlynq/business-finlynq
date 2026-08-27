import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const principal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Tenant",
    roleLabel: "Owner",
    displayName: "Owner",
    initials: "OW",
    sessionMode: "real" as const,
    authMethod: "PASSWORD" as const,
    expiresAt: new Date("2026-08-27T00:00:00Z"),
    mfaVerifiedAt: new Date("2026-08-26T18:00:00Z"),
    stepUpExpiresAt: new Date("2026-08-26T19:00:00Z"),
  };
  return {
    principal,
    requestPrincipal: vi.fn(async () => principal),
    transactionAuthMethod: vi.fn(() => "password+mfa"),
    hasRecentStepUp: vi.fn(() => true),
    sameOrigin: vi.fn(() => true),
    consumeLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    createJournal: vi.fn(async (command: unknown) => {
      void command;
      return {
        journalId: "30000000-0000-4000-8000-000000000001",
        status: "DRAFT" as const,
        journalNumber: null,
        idempotentReplay: false,
        autoPosted: false,
      };
    }),
    transitionPeriod: vi.fn(async (command: unknown) => {
      void command;
      return {
        periodId: "40000000-0000-4000-8000-000000000001",
        state: "ADJUSTMENT_ONLY" as const,
        version: 2,
        idempotentReplay: false,
      };
    }),
  };
});

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.sameOrigin,
}));
vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  transactionAuthMethod: mocks.transactionAuthMethod,
  hasRecentStepUp: mocks.hasRecentStepUp,
}));
vi.mock("@/modules/ledger/mutation-rate-limit", () => ({
  consumeLedgerMutationRateLimit: mocks.consumeLimit,
}));
vi.mock("@/modules/ledger/journal-service", () => ({
  createManualJournal: mocks.createJournal,
}));
vi.mock("@/modules/ledger/period-service", () => ({
  transitionFiscalPeriod: mocks.transitionPeriod,
}));

import { POST as createJournal } from "@/app/api/ledger/journals/route";
import { POST as transitionPeriod } from "@/app/api/ledger/periods/[periodId]/transition/route";

const journalBody = {
  ledgerId: "30000000-0000-4000-8000-000000000002",
  legalEntityId: "30000000-0000-4000-8000-000000000003",
  periodId: "30000000-0000-4000-8000-000000000004",
  accountingDate: "2026-08-26",
  purpose: "ROUTINE",
  description: "Accrue exact professional fees",
  idempotencyKey: "journal-request-1",
  lines: [
    {
      accountCombinationId: "30000000-0000-4000-8000-000000000005",
      debitFunctional: "999999999999999999999.12",
      creditFunctional: "0",
      transactionCurrency: "CAD",
      debitTransaction: "999999999999999999999.12",
      creditTransaction: "0",
      fxRate: "1",
      fxRateSource: "functional-currency",
      fxRateEffectiveAt: "2026-08-26T12:00:00.000Z",
    },
    {
      accountCombinationId: "30000000-0000-4000-8000-000000000006",
      debitFunctional: "0",
      creditFunctional: "999999999999999999999.12",
      transactionCurrency: "CAD",
      debitTransaction: "0",
      creditTransaction: "999999999999999999999.12",
      fxRate: "1",
      fxRateSource: "functional-currency",
      fxRateEffectiveAt: "2026-08-26T12:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.hasRecentStepUp.mockReturnValue(true);
});

describe("tenant ledger mutation routes", () => {
  it("preserves exact amount strings and the client idempotency key when saving a journal", async () => {
    const response = await createJournal(new NextRequest("https://business.finlynq.com/api/ledger/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(journalBody),
    }));
    expect(response.status).toBe(201);
    expect(mocks.consumeLimit).toHaveBeenCalledWith(mocks.principal, "create");
    expect(mocks.createJournal).toHaveBeenCalledOnce();
    const command = mocks.createJournal.mock.calls[0]?.[0] as {
      idempotencyKey: string;
      lines: readonly { debitFunctional: string; creditFunctional: string }[];
      context: { authMethod: string; sessionId: string };
    };
    expect(command.idempotencyKey).toBe("journal-request-1");
    expect(command.lines[0].debitFunctional).toBe("999999999999999999999.12");
    expect(command.lines[1].creditFunctional).toBe("999999999999999999999.12");
    expect(command.context.authMethod).toBe("password+mfa");
    expect(command.context.sessionId).toBe(mocks.principal.sessionId);
  });

  it("rejects an oversized journal before validation or persistence", async () => {
    const response = await createJournal(new NextRequest("https://business.finlynq.com/api/ledger/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "128001" },
      body: "{}",
    }));
    expect(response.status).toBe(413);
    expect(mocks.createJournal).not.toHaveBeenCalled();
  });

  it("fails closed under the durable actor/session mutation limit", async () => {
    mocks.consumeLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 47 });
    const response = await createJournal(new NextRequest("https://business.finlynq.com/api/ledger/journals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(journalBody),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("47");
    expect(mocks.createJournal).not.toHaveBeenCalled();
  });

  it("passes optimistic version, reason, and idempotency into a period transition", async () => {
    const periodId = "40000000-0000-4000-8000-000000000001";
    const response = await transitionPeriod(new NextRequest(`https://business.finlynq.com/api/ledger/periods/${periodId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        toState: "ADJUSTMENT_ONLY",
        reason: "Begin the controlled month-end adjustment window.",
        idempotencyKey: "period-request-1",
      }),
    }), { params: Promise.resolve({ periodId }) });
    expect(response.status).toBe(200);
    expect(mocks.transitionPeriod).toHaveBeenCalledWith(expect.objectContaining({
      periodId,
      expectedVersion: 1,
      toState: "ADJUSTMENT_ONLY",
      idempotencyKey: "period-request-1",
      context: expect.objectContaining({
        reason: "Begin the controlled month-end adjustment window.",
        authMethod: "password+mfa",
        sessionId: mocks.principal.sessionId,
      }),
    }));
  });

  it("requires current MFA at the route boundary before irreversible sealing", async () => {
    mocks.hasRecentStepUp.mockReturnValueOnce(false);
    const periodId = "40000000-0000-4000-8000-000000000001";
    const response = await transitionPeriod(new NextRequest(`https://business.finlynq.com/api/ledger/periods/${periodId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 3,
        toState: "SEALED",
        reason: "Seal the audited period after final external approval.",
        idempotencyKey: "period-request-seal",
      }),
    }), { params: Promise.resolve({ periodId }) });
    expect(response.status).toBe(403);
    expect(mocks.transitionPeriod).not.toHaveBeenCalled();
  });
});
