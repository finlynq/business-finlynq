import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  requireWorkspacePrincipal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));

import AccountPage from "@/app/(workspace)/app/account/page";
import {
  AccountMenu,
  type AccountMenuPrincipal,
} from "@/app/_components/account-menu.client";
import { EntityContextSwitcher } from "@/app/_components/entity-context-switcher.client";

const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Account tenant",
  roleLabel: "Accountant approver",
  displayName: "Taylor Owner",
  initials: "TO",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-08-27T00:00:00Z"),
  stepUpExpiresAt: new Date("2026-08-27T00:10:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspacePrincipal.mockResolvedValue(principal);
});

describe("workspace account and entity experience", () => {
  it("renders the complete pinned entity identity in an accessible native switcher", () => {
    const markup = renderToStaticMarkup(<EntityContextSwitcher context={{
      options: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          code: "CA01",
          displayName: "Canada Company",
          functionalCurrency: "CAD",
          periodLabel: "August 2026",
          periodState: "OPEN",
        },
        {
          id: "20000000-0000-4000-8000-000000000002",
          code: "US01",
          displayName: "United States Company",
          functionalCurrency: "USD",
          periodLabel: "August 2026",
          periodState: "OPEN",
        },
      ],
      selectedEntity: {
        id: "20000000-0000-4000-8000-000000000001",
        code: "CA01",
        displayName: "Canada Company",
        functionalCurrency: "CAD",
        periodLabel: "August 2026",
        periodState: "OPEN",
      },
    }} />);

    expect(markup).toContain("Working entity");
    expect(markup).toContain("CA01");
    expect(markup).toContain("Canada Company");
    expect(markup).toContain("CAD");
    expect(markup).toContain("August 2026");
    expect(markup).toContain("<select");
  });

  it("uses a top-layer dialog with labelled controls for the unclipped account menu", () => {
    const accountPrincipal: AccountMenuPrincipal = {
      displayName: principal.displayName,
      organizationName: principal.organizationName,
      roleLabel: principal.roleLabel,
      sessionMode: principal.sessionMode,
      isPlatformAdministrator: false,
    };
    const markup = renderToStaticMarkup(<AccountMenu principal={accountPrincipal} />);

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("<dialog");
    expect(markup).toContain('aria-labelledby=');
    expect(markup).toContain("Close account menu");
    expect(markup).toContain('href="/app/account"');
    expect(markup).toContain("Account &amp; security");
  });

  it("shows personal, role, MFA, and session state without credential mutation controls", async () => {
    const markup = renderToStaticMarkup(await AccountPage());

    expect(mocks.requireWorkspacePrincipal).toHaveBeenCalledWith("/app/account");
    expect(markup).toContain("Account &amp; security");
    expect(markup).toContain("Taylor Owner");
    expect(markup).toContain("Account tenant");
    expect(markup).toContain("Accountant approver");
    expect(markup).toContain("Private business account");
    expect(markup).toContain("VERIFIED");
    expect(markup).toContain("Verified for this session");
    expect(markup).toContain('href="/app/settings"');
    expect(markup).toContain('href="/security"');
    expect(markup).not.toContain("type=\"password\"");
    expect(markup).not.toContain("<form");
  });
});
