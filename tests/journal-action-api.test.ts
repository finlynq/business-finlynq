import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const previousDemoWrites = process.env.DEMO_WRITES_ENABLED;

const mocks = vi.hoisted(() => {
  const principal: SessionPrincipal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Demo tenant",
    roleLabel: "Accountant",
    displayName: "Demo Accountant",
    initials: "DA",
    sessionMode: "demo",
    authMethod: "DEMO_LINK",
    expiresAt: new Date("2026-08-27T20:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  return {
    principal,
    sameOrigin: vi.fn(() => true),
    requestPrincipal: vi.fn(async (): Promise<SessionPrincipal | null> => principal),
    transactionAuthMethod: vi.fn(() => "demo-link"),
    consumeLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    postJournal: vi.fn(async () => ({
      journalId: "30000000-0000-4000-8000-000000000001",
      journalNumber: 51,
      status: "POSTED" as const,
      idempotentReplay: false,
    })),
    reverseJournal: vi.fn(async () => ({
      journalId: "30000000-0000-4000-8000-000000000002",
      journalNumber: 52,
      status: "POSTED" as const,
      idempotentReplay: false,
      autoPosted: false,
    })),
    unpostJournal: vi.fn(async () => ({
      journalId: "30000000-0000-4000-8000-000000000001",
      journalNumber: null,
      status: "DRAFT" as const,
      idempotentReplay: false,
    })),
    deleteJournal: vi.fn(async () => ({
      journalId: "30000000-0000-4000-8000-000000000001",
      journalNumber: null,
      status: "DELETED" as const,
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
  hasRecentStepUp: (principal: SessionPrincipal) => Boolean(
    principal.stepUpExpiresAt && principal.stepUpExpiresAt.getTime() > Date.now()
  ),
}));
vi.mock("@/modules/ledger/mutation-rate-limit", () => ({
  consumeLedgerMutationRateLimit: mocks.consumeLimit,
}));
vi.mock("@/modules/ledger/posting-service", () => ({
  postJournal: mocks.postJournal,
}));
vi.mock("@/modules/ledger/journal-service", () => ({
  reversePostedJournal: mocks.reverseJournal,
}));
vi.mock("@/modules/ledger/journal-administration-service", () => ({
  unpostJournal: mocks.unpostJournal,
  deleteJournal: mocks.deleteJournal,
}));

import { POST as postJournal } from "@/app/api/ledger/journals/[journalId]/post/route";
import { POST as reverseJournal } from "@/app/api/ledger/journals/[journalId]/reverse/route";
import { POST as unpostJournal } from "@/app/api/ledger/journals/[journalId]/unpost/route";
import { POST as deleteJournal } from "@/app/api/ledger/journals/[journalId]/delete/route";
import { AuthorizationDeniedError } from "@/modules/identity/authorization-error";

const journalId = "30000000-0000-4000-8000-000000000001";

function request(path: string, body: unknown) {
  return new NextRequest(`https://business.finlynq.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUSINESS_WRITES_ENABLED = "false";
  process.env.DEMO_WRITES_ENABLED = "true";
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requestPrincipal.mockResolvedValue(mocks.principal);
  mocks.consumeLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.transactionAuthMethod.mockReturnValue("demo-link");
  mocks.unpostJournal.mockResolvedValue({
    journalId,
    journalNumber: null,
    status: "DRAFT",
    idempotentReplay: false,
  });
  mocks.deleteJournal.mockResolvedValue({
    journalId,
    journalNumber: null,
    status: "DELETED",
    idempotentReplay: false,
  });
});

afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
  if (previousDemoWrites === undefined) delete process.env.DEMO_WRITES_ENABLED;
  else process.env.DEMO_WRITES_ENABLED = previousDemoWrites;
});

describe("journal register mutation APIs", () => {
  it("binds the canonical draft hash to a writable demo posting command", async () => {
    const expectedContentHash = "a".repeat(64);
    const response = await postJournal(
      request(`/api/ledger/journals/${journalId}/post`, { expectedContentHash }),
      { params: Promise.resolve({ journalId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeLimit).toHaveBeenCalledWith(mocks.principal, "post");
    expect(mocks.postJournal).toHaveBeenCalledWith({
      journalId,
      expectedContentHash,
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        actorId: mocks.principal.userId,
        sessionId: mocks.principal.sessionId,
        authMethod: "demo-link",
        demoWriteAuthorized: true,
      }),
    });
  });

  it("binds reversal reason and stable idempotency to the audit context", async () => {
    const body = {
      periodId: "40000000-0000-4000-8000-000000000001",
      accountingDate: "2026-08-27",
      description: "Reverse duplicate accrual",
      reason: "The accrual was entered twice.",
      idempotencyKey: "journal-reversal-ui-1",
    };
    const response = await reverseJournal(
      request(`/api/ledger/journals/${journalId}/reverse`, body),
      { params: Promise.resolve({ journalId }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.consumeLimit).toHaveBeenCalledWith(mocks.principal, "reverse");
    expect(mocks.reverseJournal).toHaveBeenCalledWith({
      originalJournalId: journalId,
      ...body,
      context: expect.objectContaining({
        organizationId: mocks.principal.organizationId,
        reason: body.reason,
        demoWriteAuthorized: true,
      }),
    });
  });

  it("returns 200 for an idempotent reversal replay without changing its command", async () => {
    mocks.reverseJournal.mockResolvedValueOnce({
      journalId: "30000000-0000-4000-8000-000000000002",
      journalNumber: 52,
      status: "POSTED" as const,
      idempotentReplay: true,
      autoPosted: false,
    });
    const body = {
      periodId: "40000000-0000-4000-8000-000000000001",
      accountingDate: "2026-08-27",
      description: "Reverse duplicate accrual",
      reason: "The accrual was entered twice.",
      idempotencyKey: "journal-reversal-ui-1",
    };

    const response = await reverseJournal(
      request(`/api/ledger/journals/${journalId}/reverse`, body),
      { params: Promise.resolve({ journalId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.reverseJournal).toHaveBeenCalledWith(expect.objectContaining({
      originalJournalId: journalId,
      idempotencyKey: body.idempotencyKey,
    }));
  });

  it("fails closed before rate limiting when demo writes or same-origin verification are absent", async () => {
    process.env.DEMO_WRITES_ENABLED = "false";
    const disabled = await postJournal(
      request(`/api/ledger/journals/${journalId}/post`, {}),
      { params: Promise.resolve({ journalId }) },
    );
    expect(disabled.status).toBe(403);
    expect(mocks.consumeLimit).not.toHaveBeenCalled();

    process.env.DEMO_WRITES_ENABLED = "true";
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossSite = await reverseJournal(
      request(`/api/ledger/journals/${journalId}/reverse`, {}),
      { params: Promise.resolve({ journalId }) },
    );
    expect(crossSite.status).toBe(403);
    expect(mocks.consumeLimit).not.toHaveBeenCalled();
  });

  it("binds owner controls, returns 403 for authorization, and preserves 409 for conflicts", async () => {
    const assuredPrincipal: SessionPrincipal = {
      ...mocks.principal,
      organizationName: "Real tenant",
      roleLabel: "Organization administrator",
      sessionMode: "real",
      authMethod: "OIDC",
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: new Date(),
      stepUpExpiresAt: new Date(Date.now() + 60_000),
      organizationWritesEnabled: true,
    };
    process.env.BUSINESS_WRITES_ENABLED = "true";
    mocks.requestPrincipal.mockResolvedValue(assuredPrincipal);
    mocks.transactionAuthMethod.mockReturnValue("oidc+mfa");
    const body = {
      reason: "Correct a duplicated manual posting",
      idempotencyKey: "30000000-0000-4000-8000-000000000009",
    };

    const unposted = await unpostJournal(
      request(`/api/ledger/journals/${journalId}/unpost`, body),
      { params: Promise.resolve({ journalId }) },
    );
    expect(unposted.status).toBe(200);
    expect(mocks.unpostJournal).toHaveBeenCalledWith({
      context: expect.objectContaining({
        organizationId: assuredPrincipal.organizationId,
        authMethod: "oidc+mfa",
        reason: body.reason,
      }),
      journalId,
      ...body,
    });

    mocks.deleteJournal.mockRejectedValueOnce(new AuthorizationDeniedError());
    const forbidden = await deleteJournal(
      request(`/api/ledger/journals/${journalId}/delete`, body),
      { params: Promise.resolve({ journalId }) },
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      error: "Only an active organization owner can delete a journal.",
    });

    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteJournal.mockRejectedValueOnce(new Error("journal changed state"));
    const conflict = await deleteJournal(
      request(`/api/ledger/journals/${journalId}/delete`, body),
      { params: Promise.resolve({ journalId }) },
    );
    expect(conflict.status).toBe(409);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("requires current step-up before invoking journal administration", async () => {
    process.env.BUSINESS_WRITES_ENABLED = "true";
    mocks.requestPrincipal.mockResolvedValue({
      ...mocks.principal,
      sessionMode: "real",
      authMethod: "OIDC",
      stepUpExpiresAt: new Date(Date.now() - 1_000),
      organizationWritesEnabled: true,
    });
    const response = await unpostJournal(
      request(`/api/ledger/journals/${journalId}/unpost`, {
        reason: "Correct a duplicated manual posting",
        idempotencyKey: "30000000-0000-4000-8000-000000000009",
      }),
      { params: Promise.resolve({ journalId }) },
    );
    expect(response.status).toBe(428);
    expect(mocks.unpostJournal).not.toHaveBeenCalled();
  });
});
