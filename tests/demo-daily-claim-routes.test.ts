import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const demoPrincipal = {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Northstar Demo Sandbox 001",
    roleLabel: "Demo owner",
    displayName: "Demo owner",
    initials: "DO",
    sessionMode: "demo" as const,
    authMethod: "DEMO_LINK" as const,
    expiresAt: new Date("2026-08-28T08:15:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  };
  return {
    demoPrincipal,
    requestPrincipal: vi.fn(async (): Promise<unknown> => null),
    issueDemoSession: vi.fn(),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, retry_after_seconds: 0 })),
    markDemoStepUp: vi.fn(async () => true),
  };
});

vi.mock("@/modules/identity/auth-store", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  issueDemoSession: mocks.issueDemoSession,
  markDemoStepUp: mocks.markDemoStepUp,
}));
vi.mock("@/modules/identity/request-security", () => ({
  configuredAppOrigin: () => new URL("https://business.finlynq.com"),
  isSpeculativeNavigation: () => false,
  requestFingerprints: (request: { headers: Headers }) => ({
    ipHash: "i".repeat(64),
    userAgentHash: `user-agent-hash:${(request.headers.get("user-agent") ?? "").slice(0, 1000)}`,
  }),
  validateSameOriginMutation: () => true,
}));
vi.mock("@/modules/identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/identity/session")>()),
  requestPrincipal: mocks.requestPrincipal,
}));
vi.mock("@/security/identity-secret", () => ({
  decryptIdentityField: vi.fn(),
  identityLookupHash: () => "f".repeat(64),
}));

import { POST as confirmDemoPrivilege } from "@/app/api/auth/demo-step-up/route";
import { GET as tryDemo } from "@/app/try-demo/route";

const previousDemoLogin = process.env.DEMO_LOGIN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_LOGIN_ENABLED = "true";
  mocks.requestPrincipal.mockResolvedValue(null);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retry_after_seconds: 0 });
  mocks.markDemoStepUp.mockResolvedValue(true);
});

afterAll(() => {
  if (previousDemoLogin === undefined) delete process.env.DEMO_LOGIN_ENABLED;
  else process.env.DEMO_LOGIN_ENABLED = previousDemoLogin;
});

describe("daily demo claim routes", () => {
  it("reuses a claim after session expiry and replaces only the short-lived session", async () => {
    mocks.issueDemoSession.mockResolvedValue({
      session_id: "30000000-0000-4000-8000-000000000001",
      claim_created: false,
      claim_expires_at: new Date("2026-08-28T08:15:00Z"),
    });
    const rawClaim = "daily-browser-claim-".padEnd(48, "x");
    const request = new NextRequest("https://business.finlynq.com/try-demo?next=/app/journals", {
      headers: { cookie: `business_finlynq_session=stale-session-token-that-is-long-enough; business_finlynq_demo_claim=${rawClaim}` },
    });
    const response = await tryDemo(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://business.finlynq.com/app/journals");
    expect(mocks.issueDemoSession).toHaveBeenCalledWith(expect.objectContaining({
      claimTokenHash: createHash("sha256").update(rawClaim, "utf8").digest("hex"),
    }));
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("business_finlynq_session=");
    expect(cookies).not.toContain("business_finlynq_demo_claim=");
  });

  it("sets a separate HttpOnly claim through the Toronto nightly boundary for a new browser", async () => {
    mocks.issueDemoSession.mockResolvedValue({
      session_id: "30000000-0000-4000-8000-000000000002",
      claim_created: true,
      claim_expires_at: new Date("2026-08-28T08:15:00Z"),
    });
    const response = await tryDemo(new NextRequest("https://business.finlynq.com/try-demo?next=/app"));
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("business_finlynq_session=");
    expect(cookies).toContain("business_finlynq_demo_claim=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Expires=Fri, 28 Aug 2026 08:15:00 GMT");
    expect(mocks.issueDemoSession).toHaveBeenCalledWith(expect.objectContaining({
      claimTokenHash: null,
      userAgentHash: "user-agent-hash:",
    }));
  });

  it("allows explicit sandbox-only privileged confirmation but never accepts a real session", async () => {
    mocks.requestPrincipal.mockResolvedValue(mocks.demoPrincipal);
    const confirmed = await confirmDemoPrivilege(new NextRequest("https://business.finlynq.com/api/auth/demo-step-up", { method: "POST" }));
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({ confirmed: true, sandboxOnly: true });
    expect(mocks.markDemoStepUp).toHaveBeenCalledWith(mocks.demoPrincipal.sessionId, expect.any(String));

    mocks.requestPrincipal.mockResolvedValue({ ...mocks.demoPrincipal, sessionMode: "real", authMethod: "PASSWORD" });
    const denied = await confirmDemoPrivilege(new NextRequest("https://business.finlynq.com/api/auth/demo-step-up", { method: "POST" }));
    expect(denied.status).toBe(401);
  });
});
