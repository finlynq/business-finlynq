import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  requireWorkspacePrincipal: vi.fn(),
  listUserMcpConnections: vi.fn(),
  listPendingMcpApprovals: vi.fn(),
  mfaStatusForSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));

vi.mock("@/modules/mcp/connection-policy", () => ({
  listUserMcpConnections: mocks.listUserMcpConnections,
}));

vi.mock("@/modules/mcp/settings-store", () => ({
  listPendingMcpApprovals: mocks.listPendingMcpApprovals,
}));

vi.mock("@/modules/mcp/protocol", () => ({
  mcpResourceUrl: () => new URL("https://business.example.test/mcp"),
}));

vi.mock("@/modules/identity/auth-store", () => ({
  mfaStatusForSession: mocks.mfaStatusForSession,
}));

import McpSettingsPage from "@/app/(workspace)/settings/mcp/page";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Account tenant",
  roleLabel: "Owner",
  displayName: "Taylor Owner",
  initials: "TO",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-04T00:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspacePrincipal.mockResolvedValue(principal);
  mocks.listUserMcpConnections.mockResolvedValue([]);
  mocks.listPendingMcpApprovals.mockResolvedValue([]);
  mocks.mfaStatusForSession.mockResolvedValue({
    mfa_required: false,
    active_factor: false,
    pending_enrollment: false,
  });
});

describe("MCP settings MFA enrollment guidance", () => {
  it("routes a password-only user to authenticator enrollment instead of showing an unusable code prompt", async () => {
    const markup = renderToStaticMarkup(await McpSettingsPage());

    expect(mocks.mfaStatusForSession).toHaveBeenCalledWith(principal.sessionId);
    expect(markup).toContain("Add an authenticator for protected access");
    expect(markup).toContain("This password-only account can use ordinary and read-only features");
    expect(markup).toContain('href="/app/account#mfa-enrollment"');
    expect(markup).not.toContain("Six-digit authenticator code");
  });

  it("makes interrupted enrollment restartable from the MCP page", async () => {
    mocks.mfaStatusForSession.mockResolvedValue({
      mfa_required: false,
      active_factor: false,
      pending_enrollment: true,
    });

    const markup = renderToStaticMarkup(await McpSettingsPage());

    expect(markup).toContain("Finish authenticator setup");
    expect(markup).toContain("Restart authenticator setup");
  });

  it("does not show enrollment guidance when an active authenticator exists", async () => {
    mocks.mfaStatusForSession.mockResolvedValue({
      mfa_required: true,
      active_factor: true,
      pending_enrollment: false,
    });

    const markup = renderToStaticMarkup(await McpSettingsPage());

    expect(markup).not.toContain("Security readiness");
    expect(markup).not.toContain("Add authenticator");
  });
});
