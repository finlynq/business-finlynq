import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/app/reports/balance-sheet", requireWorkspacePrincipal: vi.fn(async () => ({})) }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/modules/workspace/access", () => ({ requireWorkspacePrincipal: mocks.requireWorkspacePrincipal }));

import { currentNavigationHref, DesktopNavigation, type NavigationItem } from "@/app/_components/navigation.client";
import { RouteTabs } from "@/app/_components/route-tabs";
import { SectionTabs } from "@/app/_components/section-tabs.client";
import ReportsPage from "@/app/(workspace)/reports/page";

const items: readonly NavigationItem[] = [
  { abbreviation: "OV", label: "Overview", href: "/app" },
  { abbreviation: "RP", label: "Reports", href: "/app/reports", group: "Review & close" },
  { abbreviation: "ST", label: "Settings", href: "/app/settings", group: "Administration" },
  { abbreviation: "DC", label: "Documents", href: "/app/settings/documents" },
  { abbreviation: "AI", label: "AI & MCP", href: "/app/settings/mcp", group: "Administration" },
];

describe("workspace information architecture", () => {
  it("keeps Reports selected for every report and matches route boundaries", () => {
    for (const report of ["trial-balance", "balance-sheet", "profit-and-loss", "account-inquiry"]) {
      expect(currentNavigationHref(`/app/reports/${report}`, items)).toBe("/app/reports");
    }
    expect(currentNavigationHref("/app/reportss", items)).toBeUndefined();
    expect(currentNavigationHref("/app/account", items)).toBeUndefined();
    expect(currentNavigationHref("/app", items)).toBe("/app");
  });

  it("selects the specific document or AI destination instead of selecting Settings twice", () => {
    for (const path of ["/app/settings/documents", "/app/settings/mcp"]) {
      expect(currentNavigationHref(path, items)).toBe(path);
      mocks.pathname = path;
      const markup = renderToStaticMarkup(<DesktopNavigation workspaceItems={items} connectionItems={[]} />);
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      expect(markup).toContain("Review &amp; close");
      expect(markup).toContain("Administration");
    }
    expect(currentNavigationHref("/app/settings/accounting", items)).toBe("/app/settings");
  });

  it("uses ordinary links and a current-page indicator for route tabs", () => {
    const markup = renderToStaticMarkup(<RouteTabs label="Example views" active="history" tabs={[
      { key: "prepare", label: "Prepare", href: "/app/tax" },
      { key: "history", label: "History", href: "/app/tax?view=history" },
    ]} />);
    expect(markup).toContain('aria-current="page" href="/app/tax?view=history"');
    expect(markup).not.toContain('role="tab"');
  });

  it("mounts every section with associated accessible panels and one tab stop", () => {
    const markup = renderToStaticMarkup(<SectionTabs label="Configuration" defaultSection="rates" sections={[
      { id: "accounts", label: "Accounts" }, { id: "rates", label: "Rates" },
    ]}><form><input defaultValue="Draft account" /></form><form><input defaultValue="Draft rate" /></form></SectionTabs>);
    expect(markup).toContain('role="tablist" aria-label="Configuration"');
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup.match(/hidden=""/g)).toHaveLength(1);
    expect(markup).toContain("Draft account");
    expect(markup).toContain("Draft rate");
  });

  it("authenticates the reports hub and exposes all four existing report destinations", async () => {
    const markup = renderToStaticMarkup(await ReportsPage());
    expect(mocks.requireWorkspacePrincipal).toHaveBeenCalledWith("/app/reports");
    for (const report of ["trial-balance", "balance-sheet", "profit-and-loss", "account-inquiry"]) {
      expect(markup).toContain(`href="/app/reports/${report}"`);
    }
    expect(markup).toContain("Currencies stay separate");
  });
});
