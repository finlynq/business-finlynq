import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantTransactionContext } from "@/db/transaction";
import { assertWritableOrganization } from "@/modules/workspace/write-policy";

const organizationId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const previousDemoWrites = process.env.DEMO_WRITES_ENABLED;

function realContext(): TenantTransactionContext {
  return {
    organizationId,
    actorId,
    sessionMode: "real",
    requestId: "organization-write-policy-test",
    authMethod: "password+mfa",
    sourceSurface: "API",
  };
}

function clientWithOrganization(row: Readonly<{
  active: boolean;
  is_demo: boolean;
  organization_mode: string;
  writes_enabled_at: Date | null;
}>): Readonly<{ client: PoolClient; query: ReturnType<typeof vi.fn> }> {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ pg_advisory_xact_lock_shared: null }] })
    .mockResolvedValueOnce({ rows: [row] });
  return { client: { query } as unknown as PoolClient, query };
}

afterEach(() => {
  if (previousDemoWrites === undefined) delete process.env.DEMO_WRITES_ENABLED;
  else process.env.DEMO_WRITES_ENABLED = previousDemoWrites;
});

describe("per-organization write policy", () => {
  it("fails closed for an active real organization without explicit activation", async () => {
    const { client, query } = clientWithOrganization({
      active: true,
      is_demo: false,
      organization_mode: "REAL",
      writes_enabled_at: null,
    });

    await expect(assertWritableOrganization(client, realContext())).rejects.toThrow(
      "Business writes are not enabled for this organization",
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock_shared");
    expect(query.mock.calls[0]?.[0]).toContain("organization-write-activation");
    expect(query.mock.calls[0]?.[0]).toContain("$1::uuid::text");
    expect(query.mock.calls[0]?.[1]).toEqual([organizationId]);
  });

  it("allows an explicitly activated real organization behind the shared activation fence", async () => {
    const { client } = clientWithOrganization({
      active: true,
      is_demo: false,
      organization_mode: "REAL",
      writes_enabled_at: new Date("2026-08-31T12:00:00.000Z"),
    });

    await expect(assertWritableOrganization(client, realContext())).resolves.toEqual({
      isDemo: false,
    });
  });

  it("keeps an authorized sandbox on the independent demo gate", async () => {
    process.env.DEMO_WRITES_ENABLED = "true";
    const { client } = clientWithOrganization({
      active: true,
      is_demo: true,
      organization_mode: "SANDBOX",
      writes_enabled_at: null,
    });
    const context: TenantTransactionContext = {
      organizationId,
      actorId,
      sessionId,
      sessionMode: "demo",
      requestId: "organization-demo-write-policy-test",
      authMethod: "demo-link",
      sourceSurface: "API",
      demoWriteAuthorized: true,
    };

    await expect(assertWritableOrganization(client, context)).resolves.toEqual({
      isDemo: true,
    });
  });
});
