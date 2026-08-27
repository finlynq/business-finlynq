import { afterEach, describe, expect, it } from "vitest";
import { validateTenantTransactionContext } from "@/db/transaction";
import { isDemoTransactionAuthMethod } from "@/modules/identity/auth-provenance";
import { type SessionPrincipal } from "@/modules/identity/session";
import {
  assertTenantWritesEnabled,
  isAuthorizedDemoWriteContext,
  mutationContext,
} from "@/modules/workspace/write-policy";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Demo organization",
  roleLabel: "Demo owner",
  displayName: "Demo owner",
  initials: "DO",
  sessionMode: "demo",
  authMethod: "DEMO_LINK",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: new Date("2099-01-01T00:00:00Z"),
};

const previousDemoWrites = process.env.DEMO_WRITES_ENABLED;

afterEach(() => {
  if (previousDemoWrites === undefined) delete process.env.DEMO_WRITES_ENABLED;
  else process.env.DEMO_WRITES_ENABLED = previousDemoWrites;
});

describe("demo transaction authentication provenance", () => {
  it("accepts a stepped-up demo principal across context validation and write authorization", () => {
    process.env.DEMO_WRITES_ENABLED = "true";
    const context = mutationContext(principal, "demo-step-up-request", {
      reason: "Exercise a sandbox-only privileged control",
    });

    expect(context.authMethod).toBe("demo-link+mfa");
    expect(validateTenantTransactionContext(context)).toMatchObject({
      sessionMode: "demo",
      authMethod: "demo-link+mfa",
    });
    expect(isAuthorizedDemoWriteContext(context)).toBe(true);
    expect(() => assertTenantWritesEnabled(context)).not.toThrow();
  });

  it("infers demo mode for both exact supported methods", () => {
    process.env.DEMO_WRITES_ENABLED = "true";
    for (const authMethod of ["demo-link", "demo-link+mfa"]) {
      const context = {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        requestId: `request-${authMethod}`,
        authMethod,
        sourceSurface: "UI" as const,
        demoWriteAuthorized: true,
      };
      expect(validateTenantTransactionContext(context).sessionMode).toBe("demo");
      expect(isAuthorizedDemoWriteContext(context)).toBe(true);
    }
  });

  it("rejects arbitrary methods that merely resemble demo authentication", () => {
    process.env.DEMO_WRITES_ENABLED = "true";
    for (const authMethod of [
      "demo-link+admin",
      "demo-link+mfa+override",
      "x-demo-link",
      "password+mfa",
    ]) {
      expect(isDemoTransactionAuthMethod(authMethod)).toBe(false);
      const context = {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        sessionMode: "demo" as const,
        requestId: `request-${authMethod}`,
        authMethod,
        sourceSurface: "UI" as const,
        demoWriteAuthorized: true,
      };
      expect(() => validateTenantTransactionContext(context)).toThrow(
        /session mode does not match/i,
      );
      expect(isAuthorizedDemoWriteContext(context)).toBe(false);
      expect(() => assertTenantWritesEnabled(context)).toThrow(
        /live isolated demo-link session/i,
      );
    }
  });
});
