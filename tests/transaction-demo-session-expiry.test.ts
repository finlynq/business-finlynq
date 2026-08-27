import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  const end = vi.fn(async () => undefined);
  return { query, release, client, connect, end, pool: { connect, end } };
});

vi.mock("pg", () => ({
  Pool: function Pool() {
    return mocks.pool;
  },
}));

import {
  closeDatabasePool,
  DemoSessionLeaseLostError,
  withTenantTransaction,
} from "@/db/transaction";

const context = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
  sessionMode: "demo" as const,
  requestId: "request-1",
  authMethod: "demo-link",
  sourceSurface: "UI" as const,
};

function databaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function failLeaseAssertion(error: Error & { code: string }): void {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === "SELECT app.assert_current_demo_session_lease()") throw error;
    return { rows: [] };
  });
}

describe("demo tenant transaction expiry", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://unit-test.invalid/business_finlynq";
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.connect.mockClear();
    mocks.end.mockClear();
  });

  afterAll(async () => {
    await closeDatabasePool();
  });

  it("sanitizes the assertion's exact revoked-lease result after rollback", async () => {
    const cause = databaseError("28000", "Demo session claim is not live");
    const work = vi.fn(async () => "unreachable");
    failLeaseAssertion(cause);

    let thrown: unknown;
    try {
      await withTenantTransaction(context, work);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DemoSessionLeaseLostError);
    expect((thrown as DemoSessionLeaseLostError).message).toBe("The demo session is no longer active.");
    expect((thrown as DemoSessionLeaseLostError).cause).toBe(cause);
    expect(work).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    databaseError("28000", "Demo session transaction context is invalid"),
    databaseError("28000", "Demo reset is due; wait for nightly reconciliation"),
    databaseError("42501", "Demo session claim is not live"),
  ])("rethrows every neighboring database authorization failure unchanged", async (cause) => {
    failLeaseAssertion(cause);

    await expect(withTenantTransaction(context, async () => "unreachable"))
      .rejects.toBe(cause);
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
