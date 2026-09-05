import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateSameOrigin: vi.fn(() => true),
  requestFingerprints: vi.fn(() => ({ ipHash: "ip-hash", userAgentHash: "ua-hash" })),
  requestPrincipal: vi.fn(),
  ledgerRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  bankingRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/modules/identity/request-security", () => ({
  validateSameOriginMutation: mocks.validateSameOrigin,
  requestFingerprints: mocks.requestFingerprints,
}));

vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.requestPrincipal,
  clearSessionCookie: vi.fn(),
}));

vi.mock("@/modules/ledger/mutation-rate-limit", () => ({
  consumeLedgerMutationRateLimit: mocks.ledgerRateLimit,
}));

vi.mock("@/modules/banking/rate-limit", () => ({
  consumeBankingRateLimit: mocks.bankingRateLimit,
}));

vi.mock("@/modules/workspace/write-policy", () => ({
  demoWritesEnabled: () => true,
  mutationContext: () => ({ organizationId: "tenant" }),
  principalCanWrite: () => true,
}));

import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import {
  organizationAdminMutationRoute,
} from "@/app/api/_shared/organization-administration-route";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { POST as confirmDemoStepUp } from "@/app/api/auth/demo-step-up/route";
import { PUT as selectWorkspaceEntity } from "@/app/api/workspace/entity-context/route";
import { FxRateUnavailableError } from "@/modules/fx/rate-resolver";
import { AccountCombinationValidationError } from "@/modules/subledger/validation-errors";

const principal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Tenant",
  roleLabel: "Owner",
  displayName: "Owner",
  initials: "OW",
  sessionMode: "real" as const,
  authMethod: "PASSWORD" as const,
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

const sensitiveFailure = new Error(
  "email=owner@example.com token=private-token otp=123456",
);

function request(method: "POST" | "PUT" = "POST") {
  return new NextRequest("https://business.finlynq.com/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function expectRedactedFailure(
  response: Response,
  logging: ReturnType<typeof vi.spyOn>,
  expectedStatus: number,
) {
  expect(response.status).toBe(expectedStatus);
  const serialized = JSON.stringify(await response.json());
  expect(serialized).not.toMatch(/owner@example\.com|private-token|123456/);
  expect(JSON.stringify(logging.mock.calls)).not.toMatch(
    /owner@example\.com|private-token|123456/,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateSameOrigin.mockReturnValue(true);
  mocks.requestFingerprints.mockReturnValue({ ipHash: "ip-hash", userAgentHash: "ua-hash" });
  mocks.requestPrincipal.mockResolvedValue(principal);
  mocks.ledgerRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.bankingRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("mutation route setup failure boundaries", () => {
  it.each([
    ["origin validation", () => mocks.validateSameOrigin.mockImplementationOnce(() => { throw sensitiveFailure; })],
    ["principal resolution", () => mocks.requestPrincipal.mockRejectedValueOnce(sensitiveFailure)],
    ["rate-limit setup", () => mocks.ledgerRateLimit.mockRejectedValueOnce(sensitiveFailure)],
  ])("contains and redacts %s failures in the accounting mutation factory", async (_stage, fail) => {
    fail();
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = createMutationRoute({
      schema: z.object({}).strict(),
      operation: "test.accounting",
      rateAction: "create",
      maximumBytes: 1_024,
      invalidMessage: "Invalid accounting request.",
      failureMessage: "The accounting request failed safely.",
      invoke: async () => ({ idempotentReplay: false }),
    });

    await expectRedactedFailure(await route(request()), logging, 409);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it.each([
    ["origin validation", () => mocks.validateSameOrigin.mockImplementationOnce(() => { throw sensitiveFailure; })],
    ["principal resolution", () => mocks.requestPrincipal.mockRejectedValueOnce(sensitiveFailure)],
    ["rate-limit setup", () => mocks.bankingRateLimit.mockRejectedValueOnce(sensitiveFailure)],
  ])("contains and redacts %s failures in the banking mutation factory", async (_stage, fail) => {
    fail();
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = createBankingMutationRoute({
      schema: z.object({}).strict(),
      operation: "test.banking",
      rateAction: "mapping",
      invoke: async () => ({ success: true }),
    });

    await expectRedactedFailure(
      await route(request(), { params: Promise.resolve({}) }),
      logging,
      409,
    );
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("contains rejected route parameters inside the banking boundary", async () => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = createBankingMutationRoute({
      schema: z.object({}).strict(),
      paramsSchema: z.object({ accountId: z.uuid() }),
      operation: "test.banking-params",
      rateAction: "mapping",
      invoke: async () => ({ success: true }),
    });

    await expectRedactedFailure(
      await route(request(), { params: Promise.reject(sensitiveFailure) }),
      logging,
      409,
    );
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("contains and redacts organization administration setup failures", async () => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await organizationAdminMutationRoute(request(), async () => {
      throw sensitiveFailure;
    });

    await expectRedactedFailure(response, logging, 503);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("contains fingerprint failures in the demo step-up route", async () => {
    mocks.requestPrincipal.mockResolvedValueOnce({ ...principal, sessionMode: "demo" });
    mocks.requestFingerprints.mockImplementationOnce(() => { throw sensitiveFailure; });
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectRedactedFailure(await confirmDemoStepUp(request()), logging, 409);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("contains principal failures in the entity-context route", async () => {
    mocks.requestPrincipal.mockRejectedValueOnce(sensitiveFailure);
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectRedactedFailure(await selectWorkspaceEntity(request("PUT")), logging, 503);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });

  it("returns tenant-safe structured account-combination failures", async () => {
    const failure = new AccountCombinationValidationError([{
      field: "lines[1].accountCombinationId",
      lineNumber: 2,
      combinationId: "50000000-0000-4000-8000-000000000001",
      accountCode: "6100",
      accountName: "Office expense",
      active: true,
      combinationActive: true,
      accountActive: true,
      postable: true,
      validFrom: "2026-01-01",
      validTo: null,
      ledgerMismatch: false,
      entityMismatch: false,
      evaluatedAccountingDate: "2025-12-15",
      failureCodes: ["FUTURE_DATED"],
      remediation: "Select a valid combination.",
    }]);
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = createMutationRoute({
      schema: z.object({}).strict(),
      operation: "test.account-combination",
      rateAction: "create",
      maximumBytes: 1_024,
      invalidMessage: "Invalid accounting request.",
      failureMessage: "The accounting request failed safely.",
      invoke: async () => {
        throw failure;
      },
    });

    try {
      const response = await route(request());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("account combinations"),
        code: "ACCOUNT_COMBINATION_INVALID",
        remediation: expect.stringContaining("do not change the accounting date"),
        accountCombinationFailures: [{
          field: "lines[1].accountCombinationId",
          lineNumber: 2,
          accountCode: "6100",
          validFrom: "2026-01-01",
          evaluatedAccountingDate: "2025-12-15",
          failureCodes: ["FUTURE_DATED"],
        }],
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      });
      expect(JSON.stringify(logging.mock.calls)).not.toMatch(/6100|Office expense/);
    } finally {
      logging.mockRestore();
    }
  });

  it("returns and logs only reviewed FX failure codes for browser mutations", async () => {
    const failure = new FxRateUnavailableError(
      "USD",
      "CAD",
      "2026-09-04",
      "ECB_FX_HTTP_ERROR",
    );
    Object.assign(failure, {
      upstreamStatus: 502,
      upstreamBody: "upstream-sensitive-payload",
    });
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const route = createMutationRoute({
      schema: z.object({}).strict(),
      operation: "test.fx-rate",
      rateAction: "create",
      maximumBytes: 1_024,
      invalidMessage: "Invalid accounting request.",
      failureMessage: "No permitted FX rate is available.",
      invoke: async () => {
        throw failure;
      },
    });

    try {
      const response = await route(request());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "No permitted FX rate is available.",
        code: "FX_RATE_UNAVAILABLE",
        providerFailureCode: "ECB_FX_HTTP_ERROR",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      });
      expect(logging).toHaveBeenCalledOnce();
      expect(JSON.parse(String(logging.mock.calls[0]?.[0]))).toEqual({
        event: "route.failure",
        operation: "subledger-mutation",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        errorType: "Error",
        errorCode: "FX_RATE_UNAVAILABLE",
        providerFailureCode: "ECB_FX_HTTP_ERROR",
      });
      expect(JSON.stringify(logging.mock.calls)).not.toMatch(
        /upstream-sensitive-payload|upstreamBody|upstreamStatus/,
      );
    } finally {
      logging.mockRestore();
    }
  });
});

describe("mutation route boundary structure", () => {
  it("keeps every direct origin check inside its route try boundary", () => {
    const routes = [
      "auth/demo-step-up/route.ts",
      "auth/login/route.ts",
      "auth/logout/route.ts",
      "auth/mfa/enroll/confirm/route.ts",
      "auth/mfa/enroll/enable/route.ts",
      "auth/mfa/enroll/skip/route.ts",
      "auth/mfa/enroll/start/route.ts",
      "auth/mfa/step-up/route.ts",
      "auth/recovery/approve/route.ts",
      "auth/signup/accept/route.ts",
      "auth/signup/request/route.ts",
      "auth/invitations/accept/route.ts",
      "auth/password-reset/confirm/route.ts",
      "auth/password-reset/escalate/route.ts",
      "auth/password-reset/request/route.ts",
      "workspace/entity-context/route.ts",
    ];

    for (const relativePath of routes) {
      const source = readFileSync(join(process.cwd(), "src/app/api", relativePath), "utf8");
      expect(source.indexOf("try {"), relativePath).toBeGreaterThanOrEqual(0);
      expect(source.indexOf("try {"), relativePath).toBeLessThan(
        source.indexOf("validateSameOriginMutation(request)"),
      );
    }
  });

  it("routes all organization administration setup through the shared boundary", () => {
    const organizationRoutes = [
      "accounting/configuration/account-combinations/route.ts",
      "accounting/configuration/currencies/route.ts",
      "accounting/configuration/entities/route.ts",
      "accounting/configuration/hierarchies/route.ts",
      "accounting/configuration/hierarchies/[hierarchyId]/route.ts",
      "accounting/configuration/hierarchies/[hierarchyId]/publish/route.ts",
      "accounting/configuration/posting-policy/route.ts",
      "accounting/configuration/rates/route.ts",
      "accounting/configuration/segment-values/route.ts",
      "accounting/configuration/segments/route.ts",
      "accounting/configuration/tax-registrations/route.ts",
      "organization/invitations/route.ts",
      "organization/invitations/[invitationId]/cancel/route.ts",
      "organization/invitations/[invitationId]/resend/route.ts",
      "organization/members/[membershipId]/route.ts",
      "organization/settings/route.ts",
    ];

    for (const relativePath of organizationRoutes) {
      const source = readFileSync(join(process.cwd(), "src/app/api", relativePath), "utf8");
      expect(source.indexOf("organizationAdminMutationRoute("), relativePath).toBeLessThan(
        source.indexOf("prepareOrganizationAdminMutation(request"),
      );
    }
  });
});
