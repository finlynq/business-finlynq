import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OrganizationAdministrationDto } from "@/modules/identity/organization-administration";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { OrganizationSettings } from "@/app/_components/organization-settings.client";

const workspace: OrganizationAdministrationDto = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  displayName: "Northstar Demo Group",
  settingsVersion: 2,
  isDemo: true,
  permissions: {
    canManageSettings: true,
    canReadMembers: true,
    canManageMembers: true,
    canManageRoles: true,
    canManageRecovery: true,
  },
  assignableRoles: [
    { id: "20000000-0000-4000-8000-000000000001", key: "OWNER", displayName: "Owner" },
    { id: "20000000-0000-4000-8000-000000000002", key: "BOOKKEEPER_MAKER", displayName: "Bookkeeper / maker" },
  ],
  members: [{
    membershipId: "30000000-0000-4000-8000-000000000001",
    email: "demo@example.invalid",
    displayName: "Demo owner",
    status: "ACTIVE",
    version: 1,
    role: { id: "20000000-0000-4000-8000-000000000001", key: "OWNER", displayName: "Owner" },
    invitation: null,
    isSelf: true,
    activeSessionCount: 1,
    lastActiveAt: "2026-08-27T10:00:00.000Z",
  }],
  requiresMfaStepUp: false,
};

describe("organization settings UI", () => {
  it("keeps settings behind the protected /app workspace route", () => {
    const nextConfig = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(nextConfig).toContain('{ source: "/app/settings", destination: "/settings" }');
  });

  it("exposes standard profile, invitation, fixed-role, and access controls in demo", () => {
    const markup = renderToStaticMarkup(<OrganizationSettings workspace={workspace} />);
    expect(markup).toContain("Business profile");
    expect(markup).toContain("Create synthetic invitation");
    expect(markup).toContain("No email is sent");
    expect(markup).toContain("Members &amp; fixed roles");
    expect(markup).toContain("One email can belong to one organization");
    expect(markup).toContain("final active owner");
    expect(markup).not.toContain("Delete member");
  });

  it("requires a visible authenticator step before real administration changes", () => {
    const markup = renderToStaticMarkup(<OrganizationSettings workspace={{
      ...workspace,
      isDemo: false,
      requiresMfaStepUp: true,
    }} />);
    expect(markup).toContain("Verify before changing access");
    expect(markup).toContain("Six-digit authenticator code");
    expect(markup).toContain("Send invitation");
  });

  it("keeps a cancelled invitation reversible without exposing a delete action", () => {
    const cancelled = {
      ...workspace.members[0]!,
      membershipId: "30000000-0000-4000-8000-000000000002",
      email: "cancelled@example.invalid",
      displayName: "Cancelled teammate",
      status: "CANCELLED" as const,
      isSelf: false,
      activeSessionCount: 0,
      invitation: {
        id: "40000000-0000-4000-8000-000000000001",
        version: 2,
        expiresAt: "2026-08-30T00:00:00.000Z",
      },
    };
    const markup = renderToStaticMarkup(<OrganizationSettings workspace={{
      ...workspace,
      members: [...workspace.members, cancelled],
    }} />);
    expect(markup).toContain("Reinvite");
    expect(markup).not.toContain("Delete member");
  });

  it("renders a signup-superseded invitation as terminal", () => {
    const superseded = {
      ...workspace.members[0]!,
      membershipId: "30000000-0000-4000-8000-000000000003",
      email: "signup-owner@example.invalid",
      displayName: "Verified signup owner",
      status: "SUPERSEDED" as const,
      isSelf: false,
      activeSessionCount: 0,
      invitation: {
        id: "40000000-0000-4000-8000-000000000002",
        version: 3,
        expiresAt: "2026-08-30T00:00:00.000Z",
      },
    };
    const markup = renderToStaticMarkup(<OrganizationSettings workspace={{
      ...workspace,
      members: [superseded],
    }} />);
    expect(markup).toContain("Replaced by verified owner signup");
    expect(markup).not.toContain("Reinvite");
    expect(markup).not.toContain("Reactivate");
  });
});
