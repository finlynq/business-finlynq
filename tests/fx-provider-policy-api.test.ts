import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  principal: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true, retry_after_seconds: 0 })),
  configure: vi.fn(),
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
vi.mock("@/modules/fx/provider-policy", async (importOriginal) => ({
  ...await importOriginal<object>(),
  configureOrganizationFxProviderPolicy: mocks.configure,
}));

import { PATCH } from "@/app/api/accounting/configuration/fx-provider-policy/route";
import { OrganizationAdministrationError } from "@/modules/identity/organization-administration";

const principal = { sessionMode: "real", organizationId: "tenant", userId: "actor" };
const command = {
  expectedVersion: 0,
  providerMode: "YAHOO_FINANCE_EXPERIMENTAL",
  maxLookbackDays: 5,
  licensedAndAuthorizedUseAcknowledged: true,
  reason: "Approve the controlled FX source",
};
const result = {
  id: "20000000-0000-4000-8000-000000000001",
  version: 1,
  providerMode: command.providerMode,
  maxLookbackDays: command.maxLookbackDays,
  licensedAndAuthorizedUseAcknowledged: true,
  configuredAt: "2026-09-05 22:15:00+00",
};

function request(body: unknown = command) {
  return new NextRequest("https://finlynq.test/api/accounting/configuration/fx-provider-policy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "https://finlynq.test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.principal.mockResolvedValue(principal);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.configure.mockResolvedValue(result);
});

describe("FX provider-policy browser API", () => {
  it("uses the authenticated tenant boundary and returns a private response", async () => {
    const response = await PATCH(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(result);
    expect(mocks.configure).toHaveBeenCalledWith({
      ...command,
      principal,
      requestId: expect.any(String),
      sourceSurface: "API",
    });
  });

  it.each([
    { ...command, maxLookbackDays: 0 },
    { ...command, maxLookbackDays: 8 },
    { ...command, licensedAndAuthorizedUseAcknowledged: false },
    { ...command, organizationId: "another-tenant" },
  ])("rejects invalid, unacknowledged, or tenant-injected input", async (body) => {
    expect((await PATCH(request(body))).status).toBe(400);
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, unauthenticated, and rate-limited requests before mutation", async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await PATCH(request())).status).toBe(403);
    mocks.sameOrigin.mockReturnValue(true);
    mocks.principal.mockResolvedValue(null);
    expect((await PATCH(request())).status).toBe(401);
    mocks.principal.mockResolvedValue(principal);
    mocks.rateLimit.mockResolvedValue({ allowed: false, retry_after_seconds: 60 });
    const limited = await PATCH(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it.each([
    [428, "MFA_STEP_UP_REQUIRED"],
    [403, "PERMISSION_DENIED"],
    [409, "CONFIGURATION_CONFLICT"],
  ] as const)("preserves the service boundary's %s response", async (status, code) => {
    mocks.configure.mockRejectedValue(
      new OrganizationAdministrationError("Change is not allowed.", status, code),
    );
    const response = await PATCH(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
});
