import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const previousBusinessWrites = process.env.BUSINESS_WRITES_ENABLED;
const mocks = vi.hoisted(() => {
  class JournalWorkflowError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  }
  return {
    JournalWorkflowError,
    sameOrigin: vi.fn(() => true),
    requestPrincipal: vi.fn<() => Promise<SessionPrincipal | null>>(),
    limit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    submit: vi.fn(), approve: vi.fn(), withdraw: vi.fn(), reject: vi.fn(), post: vi.fn(),
  };
});
vi.mock("@/modules/identity/request-security", () => ({ validateSameOriginMutation: mocks.sameOrigin }));
vi.mock("@/modules/identity/session", () => ({ requestPrincipal: mocks.requestPrincipal, transactionAuthMethod: () => "password+mfa" }));
vi.mock("@/modules/ledger/mutation-rate-limit", () => ({ consumeLedgerMutationRateLimit: mocks.limit }));
vi.mock("@/modules/ledger/journal-workflow-service", () => ({
  JournalWorkflowError: mocks.JournalWorkflowError,
  submitJournalForApproval: mocks.submit, approveSubmittedJournal: mocks.approve,
  withdrawSubmittedJournal: mocks.withdraw, rejectSubmittedJournal: mocks.reject,
}));
vi.mock("@/modules/ledger/posting-service", () => ({ postJournal: mocks.post }));

import { POST as submit } from "@/app/api/ledger/journals/[journalId]/submit/route";
import { POST as approve } from "@/app/api/ledger/journals/[journalId]/approve/route";
import { POST as withdraw } from "@/app/api/ledger/journals/[journalId]/withdraw/route";
import { POST as reject } from "@/app/api/ledger/journals/[journalId]/reject/route";
import { POST as post } from "@/app/api/ledger/journals/[journalId]/post/route";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const journalId = id(1);
const principal = {
  sessionId: id(2), userId: id(3), organizationId: id(4), membershipId: id(5),
  organizationName: "Business", displayName: "Reviewer", initials: "RE", roleLabel: "Reviewer",
  sessionMode: "real", authMethod: "PASSWORD", organizationWritesEnabled: true,
  expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: new Date(), stepUpExpiresAt: new Date(Date.now() + 60_000),
} as SessionPrincipal;
const body = { expectedContentHash: "a".repeat(64), reason: "Reviewed supporting accounting evidence." };
const frozen = { ...body, expectedApprovalVersion: 3 };
const recovery = { ...frozen, idempotencyKey: id(9) };
const params = { params: Promise.resolve({ journalId }) };
const routes = [
  { name: "submit", route: submit, service: mocks.submit, command: body, status: "SUBMITTED" },
  { name: "approve", route: approve, service: mocks.approve, command: frozen, status: "APPROVED" },
  { name: "withdraw", route: withdraw, service: mocks.withdraw, command: recovery, status: "DRAFT" },
  { name: "reject", route: reject, service: mocks.reject, command: recovery, status: "DRAFT" },
];
function request(action: string, data: unknown) {
  return new NextRequest(`https://business.finlynq.com/api/ledger/journals/${journalId}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.BUSINESS_WRITES_ENABLED = "true";
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.limit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  for (const entry of routes) entry.service.mockResolvedValue({ journalId, status: entry.status, idempotentReplay: false });
  mocks.post.mockResolvedValue({ journalId, status: "POSTED", journalNumber: 51, idempotentReplay: false });
});
afterAll(() => {
  if (previousBusinessWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousBusinessWrites;
});

describe("journal workflow mutation routes", () => {
  it.each(routes)("binds $name to the reviewed evidence and authenticated audit context", async ({ name, route, service, command }) => {
    const response = await route(request(name, command), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.limit).toHaveBeenCalledWith(principal, name);
    expect(service).toHaveBeenCalledWith({
      journalId, ...(name === "submit" ? { expectedContentHash: body.expectedContentHash } : command),
      context: expect.objectContaining({ organizationId: principal.organizationId, actorId: principal.userId,
        sessionId: principal.sessionId, authMethod: "password+mfa", reason: body.reason, sourceSurface: "API" }),
    });
  });

  it("passes the frozen approval version and reason when posting an approved journal", async () => {
    const response = await post(request("post", frozen), params);
    expect(response.status).toBe(200);
    expect(mocks.post).toHaveBeenCalledWith({ journalId, expectedContentHash: body.expectedContentHash,
      expectedApprovalVersion: 3, context: expect.objectContaining({ reason: body.reason }) });
    expect(await response.json()).toMatchObject({ status: "POSTED", journalNumber: 51 });
  });

  it.each(routes)("rejects missing hash and short reasons for $name", async ({ name, route, service, command }) => {
    expect((await route(request(name, { ...command, expectedContentHash: undefined }), params)).status).toBe(400);
    expect((await route(request(name, { ...command, reason: "short" }), params)).status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(routes.filter((entry) => entry.name !== "submit"))("requires the frozen version for $name", async ({ name, route, service, command }) => {
    expect((await route(request(name, { ...command, expectedApprovalVersion: undefined }), params)).status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(routes.filter((entry) => entry.name === "withdraw" || entry.name === "reject"))("requires a random UUIDv4 recovery key for $name", async ({ name, route, service, command }) => {
    const response = await route(request(name, { ...command, idempotencyKey: "30000000-0000-7000-8000-000000000009" }), params);
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it.each(routes)("enforces same-origin, session, write and rate boundaries for $name", async ({ name, route, service, command }) => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await route(request(name, command), params)).status).toBe(403);
    expect(mocks.requestPrincipal).not.toHaveBeenCalled();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.requestPrincipal.mockResolvedValue(null);
    expect((await route(request(name, command), params)).status).toBe(403);
    mocks.requestPrincipal.mockResolvedValue(principal);
    process.env.BUSINESS_WRITES_ENABLED = "false";
    expect((await route(request(name, command), params)).status).toBe(403);
    process.env.BUSINESS_WRITES_ENABLED = "true";
    mocks.limit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const limited = await route(request(name, command), params);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("30");
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    ["MISSING_PERMISSION", 403], ["STALE_VERSION", 409], ["PERIOD_CLOSED", 409], ["HAS_DEPENDENCIES", 409],
  ])("returns the safe stable %s reason", async (code, expectedStatus) => {
    mocks.approve.mockRejectedValueOnce(new mocks.JournalWorkflowError(String(code), "Review the current journal eligibility."));
    const response = await approve(request("approve", frozen), params);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ code, error: "Review the current journal eligibility." });
  });

  it("keeps withdrawal retries idempotent and never exposes unexpected database details", async () => {
    mocks.withdraw.mockResolvedValueOnce({ journalId, status: "DRAFT", idempotentReplay: true });
    const repeated = await withdraw(request("withdraw", recovery), params);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "DRAFT", idempotentReplay: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.reject.mockRejectedValueOnce(new Error("internal database secret should stay private"));
    const failure = await reject(request("reject", recovery), params);
    expect(failure.status).toBe(409);
    expect(JSON.stringify(await failure.json())).not.toContain("internal database secret");
    log.mockRestore();
  });

  it("maps posting hash conflicts without exposing the thrown message", async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error("database detail"), { code: "STALE_CONTENT_HASH" }));
    const response = await post(request("post", frozen), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "STALE_CONTENT_HASH", error: "The journal changed after review. Refresh it and review the current version before continuing." });
  });
});
