import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryDatabase: vi.fn() }));

vi.mock("@/db/transaction", () => ({ queryDatabase: mocks.queryDatabase }));

import {
  finishSessionMfaEnrollment,
  issueDemoSession,
  issueMfaUserSession,
  issuePasswordUserSession,
  resolveStoredSession,
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

  it("keeps ordinary real-account login on the same atomic issuance path with an empty-UA hash", async () => {
    await issueMfaUserSession({
      userId: "30000000-0000-4000-8000-000000000001",
      organizationId: "30000000-0000-4000-8000-000000000002",
      membershipId: "30000000-0000-4000-8000-000000000003",
      factorId: "30000000-0000-4000-8000-000000000004",
      totpCounter: 102,
      tokenHash: "new-real-token-hash",
      ipHash: "ip-hash",
      userAgentHash: "empty-user-agent-hash",
      requestId: "request-id",
    });

    const [, values] = mocks.queryDatabase.mock.calls[0] as [string, unknown[]];
    expect(values[7]).toBe("empty-user-agent-hash");
    expect(values[9]).toBeNull();
  });

  it("keeps the stored-session adapter nullable for legacy database rows", async () => {
    mocks.queryDatabase.mockResolvedValueOnce({ rows: [] });

    await expect(resolveStoredSession("legacy-session-token-hash", null)).resolves.toBeNull();

    expect(mocks.queryDatabase).toHaveBeenCalledWith(
      "SELECT * FROM app.auth_resolve_session_v3($1, $2)",
      ["legacy-session-token-hash", null],
    );
  });

  it("passes the bound empty-UA hash through password and demo issuance", async () => {
    await issuePasswordUserSession({
      userId: "30000000-0000-4000-8000-000000000001",
      organizationId: "30000000-0000-4000-8000-000000000002",
      membershipId: "30000000-0000-4000-8000-000000000003",
      tokenHash: "password-session-token-hash",
      ipHash: "ip-hash",
      userAgentHash: "empty-user-agent-hash",
      requestId: "password-session-request",
    });
    await issueDemoSession({
      tokenHash: "demo-session-token-hash",
      ipHash: "ip-hash",
      userAgentHash: "empty-user-agent-hash",
      requestId: "demo-session-request",
    });

    const [, passwordValues] = mocks.queryDatabase.mock.calls[0] as [string, unknown[]];
    const [, demoValues] = mocks.queryDatabase.mock.calls[1] as [string, unknown[]];
    expect(passwordValues[5]).toBe("empty-user-agent-hash");
    expect(demoValues.slice(1, 3)).toEqual([null, null]);
    expect(demoValues[4]).toBe("empty-user-agent-hash");
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
