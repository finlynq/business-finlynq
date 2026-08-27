import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspacePrincipal: vi.fn(),
  loadPlatformAdministrationOverview: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));
vi.mock("@/modules/identity/platform-administration", () => ({
  loadPlatformAdministrationOverview: mocks.loadPlatformAdministrationOverview,
}));

import { showPlatformAdministrationLink, type AccountMenuPrincipal } from "@/app/_components/account-menu.client";
import PlatformAdministrationPage from "@/app/(workspace)/app/platform/page";

const accountPrincipal: AccountMenuPrincipal = {
  displayName: "Platform operator",
  organizationName: "Private business",
  roleLabel: "Owner",
  sessionMode: "real",
  isPlatformAdministrator: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspacePrincipal.mockResolvedValue({
    sessionId: "70000000-0000-4000-8000-000000000001",
    userId: "60000000-0000-4000-8000-000000000001",
    sessionMode: "real",
  });
  mocks.loadPlatformAdministrationOverview.mockResolvedValue({
    activeRealOrganizationCount: "3",
    activeRealUserCount: "12",
    activeRealSessionCount: "5",
    pendingPlatformAdministratorCount: "1",
    linkedPlatformAdministratorCount: "2",
    generatedAt: new Date("2026-08-27T12:00:00Z"),
  });
});

describe("platform administration page", () => {
  it("renders only aggregate read-only control-plane metadata", async () => {
    const markup = renderToStaticMarkup(await PlatformAdministrationPage());
    expect(mocks.requireWorkspacePrincipal).toHaveBeenCalledWith("/app/platform");
    expect(markup).toContain("Read-only control plane");
    expect(markup).toContain("Platform operations");
    expect(markup).toContain("Real organizations");
    expect(markup).toContain("Pending administrators");
    expect(markup).toContain("does not bypass organization encryption");
    expect(markup).not.toContain("email_ciphertext");
    expect(markup).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  it("uses the non-disclosing not-found boundary when live role authorization fails", async () => {
    mocks.loadPlatformAdministrationOverview.mockResolvedValue(null);
    await expect(PlatformAdministrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("adds the platform destination only for an active platform administrator", () => {
    expect(showPlatformAdministrationLink(accountPrincipal)).toBe(true);
    expect(showPlatformAdministrationLink({ ...accountPrincipal, isPlatformAdministrator: false })).toBe(false);
    expect(showPlatformAdministrationLink({
      ...accountPrincipal,
      sessionMode: "demo",
      isPlatformAdministrator: false,
    })).toBe(false);
  });
});
