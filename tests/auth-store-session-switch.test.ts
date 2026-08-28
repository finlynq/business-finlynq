import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryDatabase: vi.fn() }));

vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.queryDatabase }));

import {
  finishSessionMfaEnrollment,
  issueMfaUserSession,
} from "@/modules/identity/auth-store";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryDatabase.mockResolvedValue({
    rows: [{ session_id: "40000000-0000-4000-8000-000000000001" }],
  });
});

describe("MFA session issuance", () => {
  it("issues the real session and revokes a resolved demo token in one database statement", async () => {
    const result = await issueMfaUserSession({
      userId: "30000000-0000-4000-8000-000000000001",
      organizationId: "30000000-0000-4000-8000-000000000002",
      membershipId: "30000000-0000-4000-8000-000000000003",
      factorId: "30000000-0000-4000-8000-000000000004",
      totpCounter: 101,
      tokenHash: "new-real-token-hash",
      ipHash: "ip-hash",
      userAgentHash: "agent-hash",
      requestId: "request-id",
      replacedDemoSessionTokenHash: "old-demo-token-hash",
    });

    expect(result).toBe("40000000-0000-4000-8000-000000000001");
    const [statement, values] = mocks.queryDatabase.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("app.auth_issue_mfa_user_session");
    expect(statement).toContain("app.auth_revoke_session($10,$9)");
    expect(statement).toContain("issued.session_id IS NOT NULL");
    expect(values).toHaveLength(10);
    expect(values[9]).toBe("old-demo-token-hash");
  });

  it("keeps ordinary real-account login on the same atomic issuance path without a replacement", async () => {
    await issueMfaUserSession({
      userId: "30000000-0000-4000-8000-000000000001",
      organizationId: "30000000-0000-4000-8000-000000000002",
      membershipId: "30000000-0000-4000-8000-000000000003",
      factorId: "30000000-0000-4000-8000-000000000004",
      totpCounter: 102,
      tokenHash: "new-real-token-hash",
      ipHash: "ip-hash",
      userAgentHash: null,
      requestId: "request-id",
    });

    const [, values] = mocks.queryDatabase.mock.calls[0] as [string, unknown[]];
    expect(values[9]).toBeNull();
  });

  it("passes a fresh bearer hash into atomic later-enrollment completion", async () => {
    mocks.queryDatabase.mockResolvedValue({ rows: [{ finished: true }] });

    await expect(finishSessionMfaEnrollment({
      sessionId: "30000000-0000-4000-8000-000000000001",
      setupTokenHash: "setup-token-hash",
      factorId: "30000000-0000-4000-8000-000000000004",
      counter: 103,
      replacementSessionTokenHash: "replacement-session-token-hash",
      requestId: "request-id",
    })).resolves.toBe(true);

    const [statement, values] = mocks.queryDatabase.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("app.auth_finish_session_mfa_enrollment($1,$2,$3,$4,$5,$6)");
    expect(values).toHaveLength(6);
    expect(values[4]).toBe("replacement-session-token-hash");
  });
});
