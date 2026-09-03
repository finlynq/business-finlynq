import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  principal: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true, retry_after_seconds: 0 })),
  create: vi.fn(),
}));
vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.sameOrigin,
  requestFingerprints: () => ({ ipHash: "test-ip", userAgentHash: "test-ua" }),
}));
vi.mock("@/modules/identity/session", async (importOriginal) => ({
  ...await importOriginal<object>(),
  requestPrincipal: mocks.principal,
}));
vi.mock("@/modules/identity/auth-store", async (importOriginal) => ({
  ...await importOriginal<object>(),
  consumeRateLimit: mocks.rateLimit,
}));
vi.mock("@/security/identity-secret", async (importOriginal) => ({
  ...await importOriginal<object>(),
  identityLookupHash: () => "test-hash",
}));
vi.mock("@/modules/ledger/accounting-configuration", async (importOriginal) => ({
  ...await importOriginal<object>(),
  createFiscalPeriods: mocks.create,
}));

import { POST } from "@/app/api/ledger/periods/route";
import { OrganizationAdministrationError } from "@/modules/identity/organization-administration";

const principal = { sessionMode: "real", organizationId: "tenant", userId: "actor" };
const command = {
  ledgerId: "10000000-0000-4000-8000-000000000001",
  fiscalYear: 2027,
  periodPattern: "MONTHLY",
  initialState: "OPEN",
  idempotencyKey: "browser-calendar-2027",
  reason: "Create next year's calendar",
};
const result = {
  accepted: true,
  idempotentReplay: false,
  summary: { created: 12, existing: 0, rejected: 0 },
  conflicts: [],
};

function request(body: unknown = command) {
  return new NextRequest("https://finlynq.test/api/ledger/periods", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://finlynq.test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.principal.mockResolvedValue(principal);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.create.mockResolvedValue(result);
});

describe("fiscal-period browser API", () => {
  it("uses the authenticated tenant, API provenance, and client idempotency key", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(result);
    expect(mocks.create).toHaveBeenCalledWith({
      ...command, principal, requestId: expect.any(String), sourceSurface: "API",
    });
  });

  it.each([
    { ...result, idempotentReplay: true },
    { ...result, summary: { created: 0, existing: 12, rejected: 0 } },
  ])("returns 200 for a completed or fully existing calendar", async (completed) => {
    mocks.create.mockResolvedValue(completed);
    expect((await POST(request())).status).toBe(200);
  });

  it("returns structured conflicts without pretending any periods were created", async () => {
    const conflict = { ...result, accepted: false, summary: { created: 0, existing: 0, rejected: 12 }, conflicts: [{ label: "Legacy period" }] };
    mocks.create.mockResolvedValue(conflict);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(conflict);
  });

  it.each([
    { ...command, organizationId: "another-tenant" },
    { ...command, fiscalYear: 2201 },
    { ...command, reason: "short" },
    { ...command, initialState: "SEALED" },
  ])("rejects invalid or tenant-injected input", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and cross-origin requests before mutation", async () => {
    mocks.principal.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rate-limits creation", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retry_after_seconds: 60 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [428, "MFA_STEP_UP_REQUIRED"],
    [403, "PERMISSION_DENIED"],
    [403, "BUSINESS_WRITES_DISABLED"],
  ] as const)("preserves the service boundary's %s response", async (status, code) => {
    mocks.create.mockRejectedValue(new OrganizationAdministrationError("Change is not allowed.", status, code));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
});
