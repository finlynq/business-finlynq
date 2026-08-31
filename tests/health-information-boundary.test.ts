import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryDatabase: vi.fn(),
  emailDeliveryReadiness: vi.fn(),
  assertAccountAuthenticationConfigured: vi.fn(),
  assertSignupChallengeConfigured: vi.fn(),
  loadIdentitySecret: vi.fn(),
  loadOrganizationRootKek: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.queryDatabase }));
vi.mock("@/modules/identity/auth-store", () => ({
  emailDeliveryReadiness: mocks.emailDeliveryReadiness,
}));
vi.mock("@/modules/identity/email-provider", () => ({
  assertAccountAuthenticationConfigured: mocks.assertAccountAuthenticationConfigured,
}));
vi.mock("@/modules/identity/signup-challenge", () => ({
  assertSignupChallengeConfigured: mocks.assertSignupChallengeConfigured,
}));
vi.mock("@/security/identity-secret", () => ({ loadIdentitySecret: mocks.loadIdentitySecret }));
vi.mock("@/security/root-secret", () => ({ loadOrganizationRootKek: mocks.loadOrganizationRootKek }));

import { GET as health } from "@/app/api/health/route";
import { GET as live } from "@/app/api/live/route";
import { journalTypeSeedDefinitions } from "@/modules/ledger/journal-type-registry-contract";

const controlledEnvironment = [
  "ACCOUNT_LOGIN_ENABLED",
  "ACCOUNT_SIGNUP_ENABLED",
  "BANK_FEEDS_ENABLED",
  "BUSINESS_FINLYNQ_IMAGE_REVISION",
] as const;
const previousEnvironment = Object.fromEntries(
  controlledEnvironment.map((name) => [name, process.env[name]]),
) as Record<(typeof controlledEnvironment)[number], string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    ACCOUNT_LOGIN_ENABLED: "false",
    ACCOUNT_SIGNUP_ENABLED: "false",
    BANK_FEEDS_ENABLED: "false",
    BUSINESS_FINLYNQ_IMAGE_REVISION: "a".repeat(40),
  });
  mocks.queryDatabase.mockImplementation((statement: string) =>
    Promise.resolve({
      rows: statement.includes("FROM journal_type_definitions")
        ? journalTypeSeedDefinitions
        : [{ ready: 1 }],
    }),
  );
  mocks.emailDeliveryReadiness.mockResolvedValue({ worker_ready: true });
});

afterAll(() => {
  for (const name of controlledEnvironment) {
    const value = previousEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("health information boundary", () => {
  it("keeps public liveness minimal and non-cacheable", async () => {
    const response = await live();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "live" });
  });

  it("keeps public readiness useful without exposing posture or revision", async () => {
    const response = await health(new NextRequest("https://business.finlynq.com/api/health", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("retains detailed readiness for marked direct internal probes", async () => {
    const response = await health(new NextRequest("http://127.0.0.1:3100/api/health", {
      headers: { "x-business-finlynq-internal-health": "1" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: {
        database: "ready",
        organizationKey: "ready",
        identityKey: "ready",
        accountAuthentication: "disabled",
        accountSignup: "disabled",
        emailWorker: "disabled",
        bankFeeds: "disabled",
      },
      revision: "a".repeat(40),
    });
  });

  it("fails readiness when the deployed journal-type seed drifts from the runtime manifests", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.queryDatabase
      .mockResolvedValueOnce({ rows: [{ ready: 1 }] })
      .mockResolvedValueOnce({
        rows: journalTypeSeedDefinitions.map((definition) =>
          definition.key === "ledger.reversal"
            ? { ...definition, version: definition.version + 1 }
            : definition,
        ),
      });

    try {
      const response = await health(new NextRequest("https://business.finlynq.com/api/health"));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    } finally {
      log.mockRestore();
    }
  });

  it("does not disclose a failed component or exception", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadIdentitySecret.mockImplementationOnce(() => {
      throw new Error("sensitive internal failure");
    });

    try {
      const response = await health(new NextRequest("https://business.finlynq.com/api/health"));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "unavailable" });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "Business Finlynq route failure",
        {
          operation: "health-readiness",
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          errorType: "Error",
        },
      );
      const serializedLog = JSON.stringify(log.mock.calls);
      expect(serializedLog).not.toContain("sensitive internal failure");
      expect(serializedLog).not.toMatch(/\bat\s+.+:\d+:\d+/);
    } finally {
      log.mockRestore();
    }
  });

  it.each(["deploy/Caddyfile.container", "deploy/Caddyfile.example"])(
    "strips the internal detail marker before proxying in %s",
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");

      expect(source).toContain("header_up -X-Business-Finlynq-Internal-Health");
      expect(source).toContain("health_uri /api/health");
      expect(source).not.toMatch(/header_up\s+X-Business-Finlynq-Internal-Health/i);
    },
  );

  it("uses the isolated loopback listener for detailed production monitoring", () => {
    const monitor = readFileSync(join(
      process.cwd(),
      "deploy/monitoring/check-production.sh",
    ), "utf8");
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    const healthRoute = readFileSync(join(
      process.cwd(),
      "src/app/api/health/route.ts",
    ), "utf8");

    expect(monitor).toContain('"$MONITOR_BASE_URL/api/live"');
    expect(monitor).toContain('"$MONITOR_BASE_URL/api/health"');
    expect(monitor).toContain('keys == ["status"] and .status == "ready"');
    expect(monitor).toContain('"http://127.0.0.1:3100/api/health"');
    expect(monitor).toContain("--header 'X-Business-Finlynq-Internal-Health: 1'");
    expect(compose).toContain('"127.0.0.1:3100:3000"');
    expect(healthRoute).not.toMatch(/x-forwarded-for|x-real-ip/i);
  });
});
