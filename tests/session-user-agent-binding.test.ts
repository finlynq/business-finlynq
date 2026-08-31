import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveStoredSession: vi.fn(),
  identityLookupHash: vi.fn((value: string) => `lookup:${value}`),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  resolveStoredSession: mocks.resolveStoredSession,
}));
vi.mock("@/security/identity-secret", () => ({
  decryptIdentityField: vi.fn(),
  identityLookupHash: mocks.identityLookupHash,
}));

import { requestFingerprints } from "@/modules/identity/request-security";
import { resolveSession } from "@/modules/identity/session";

const storedDemoPrincipal = {
  session_id: "10000000-0000-4000-8000-000000000001",
  user_id: "10000000-0000-4000-8000-000000000002",
  organization_id: "10000000-0000-4000-8000-000000000003",
  membership_id: "10000000-0000-4000-8000-000000000004",
  session_mode: "DEMO" as const,
  auth_method: "DEMO_LINK" as const,
  organization_name: "Demo organization",
  role_label: "Demo owner",
  email_ciphertext: "",
  display_name_ciphertext: null,
  expires_at: new Date("2026-08-29T00:00:00Z"),
  mfa_verified_at: null,
  step_up_expires_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveStoredSession.mockResolvedValue(null);
});

describe("session user-agent binding", () => {
  it("derives a non-null deterministic hash when a new request has no User-Agent", () => {
    const first = requestFingerprints(new NextRequest("https://business.finlynq.com/login"));
    const second = requestFingerprints(new NextRequest("https://business.finlynq.com/try-demo"));

    expect(first.userAgentHash).toBe("lookup:user-agent|");
    expect(second.userAgentHash).toBe(first.userAgentHash);
    expect(first.userAgentHash).not.toBeNull();
  });

  it("resolves a no-UA session with the empty hash but rejects a later different User-Agent", async () => {
    const emptyUserAgentHash = "lookup:user-agent|";
    mocks.resolveStoredSession.mockImplementation(async (_tokenHash: string, userAgentHash: string | null) => (
      userAgentHash === emptyUserAgentHash ? storedDemoPrincipal : null
    ));
    const rawToken = "no-user-agent-session-token".padEnd(48, "x");
    const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");

    await expect(resolveSession(rawToken, null)).resolves.toMatchObject({
      sessionId: storedDemoPrincipal.session_id,
      sessionMode: "demo",
    });
    await expect(resolveSession(rawToken, "A different browser agent")).resolves.toBeNull();
    expect(mocks.resolveStoredSession).toHaveBeenNthCalledWith(1, tokenHash, emptyUserAgentHash);
    expect(mocks.resolveStoredSession).toHaveBeenNthCalledWith(
      2,
      tokenHash,
      "lookup:user-agent|A different browser agent",
    );
  });

  it("preserves the SQL wildcard only for existing rows whose stored hash is NULL", () => {
    const resolverMigration = readFileSync(join(
      process.cwd(),
      "migrations/drizzle/0007_auth_delivery_invites.sql",
    ), "utf8");
    const bindingMigration = readFileSync(join(
      process.cwd(),
      "migrations/drizzle/0027_session_user_agent_binding.sql",
    ), "utf8");

    expect(resolverMigration).toContain(
      "AND (session.user_agent_hash IS NULL OR session.user_agent_hash = selected_user_agent_hash)",
    );
    expect(bindingMigration).toContain(
      "New authentication sessions require a user-agent fingerprint",
    );
    expect(bindingMigration).toContain(
      "BEFORE INSERT OR UPDATE OF user_agent_hash ON auth_sessions",
    );
    expect(bindingMigration).toContain(
      "NULL is permitted only on sessions issued before migration 0027",
    );
  });
});
