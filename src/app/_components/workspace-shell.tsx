import Link from "next/link";
import { demoSearchIndex } from "@/modules/demo/dashboard-data";
import type { SessionPrincipal } from "@/modules/identity/session";
import type { WorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { AccountMenu, type AccountMenuPrincipal } from "./account-menu.client";
import { EntityContextSwitcher } from "./entity-context-switcher.client";
import { GlobalSearch, type SearchEntry } from "./global-search.client";
import {
  DesktopNavigation,
  MobileNavigation,
  type NavigationItem,
} from "./navigation.client";

const workspaceItems: readonly NavigationItem[] = [
  { abbreviation: "OV", label: "Overview", href: "/app" },
  { abbreviation: "GL", label: "General ledger", href: "/app/journals" },
  { abbreviation: "PT", label: "Parties", href: "/app/parties" },
  { abbreviation: "AR", label: "Receivables", href: "/app/receivables/invoices" },
  { abbreviation: "AP", label: "Payables", href: "/app/payables/bills" },
  { abbreviation: "BK", label: "Banking", href: "/app/banking" },
  { abbreviation: "TX", label: "Tax", href: "/app/tax" },
  { abbreviation: "RP", label: "Reports", href: "/app/reports/trial-balance" },
  { abbreviation: "CT", label: "Controls", href: "/app/controls/period-close" },
  { abbreviation: "ST", label: "Settings", href: "/app/settings" },
];

const connectionItems: readonly NavigationItem[] = [
  { abbreviation: "AI", label: "AI & MCP", href: "/app/settings/mcp" },
];

function createSearchIndex(includeDemoRecords: boolean): readonly SearchEntry[] {
  const routes: SearchEntry[] = [...workspaceItems, ...connectionItems].map((item) => ({
    label: item.label,
    detail: "Workspace page",
    href: item.href,
    keywords: item.abbreviation,
  }));
  const records: SearchEntry[] = (includeDemoRecords ? demoSearchIndex : []).map((entry) => ({
      label: entry.title,
      detail: entry.subtitle,
      href: `/app${entry.href}`,
      keywords: `${entry.kind} ${entry.keywords.join(" ")} ${entry.entityCode ?? ""}`,
    }));
  return [...routes, ...records];
}

export function WorkspaceShell({
  children,
  principal,
  readOnly,
  entityContext,
  isPlatformAdministrator = false,
}: {
  children: React.ReactNode;
  principal: SessionPrincipal;
  readOnly: boolean;
  entityContext: WorkspaceEntityContext;
  isPlatformAdministrator?: boolean;
}) {
  const organization = {
    name: principal.organizationName,
    environment: principal.sessionMode === "demo" ? "Shared nightly demo" : "Private workspace",
  };
  const searchIndex = createSearchIndex(principal.sessionMode === "demo");
  const accountPrincipal: AccountMenuPrincipal = {
    displayName: principal.displayName,
    organizationName: principal.organizationName,
    roleLabel: principal.roleLabel,
    sessionMode: principal.sessionMode,
    isPlatformAdministrator,
  };

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar" aria-label="Primary navigation">
        <Link href="/app" className="brand-lockup" aria-label="Business Finlynq overview">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span className="brand-copy"><strong>Finlynq</strong><span>Business</span></span>
        </Link>
        <div className="workspace-card">
          <span className="eyebrow">Workspace</span>
          <strong>{organization.name}</strong>
          <span className="demo-chip">{organization.environment}</span>
        </div>
        <DesktopNavigation workspaceItems={workspaceItems} connectionItems={connectionItems} />
        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">{principal.initials}</div>
          <div><strong>{principal.displayName}</strong><span>{principal.roleLabel}{readOnly ? " · read only" : ""}</span></div>
          <AccountMenu principal={accountPrincipal} />
        </div>
      </aside>

      <div className="mobile-bar">
        <MobileNavigation
          organizationName={organization.name}
          workspaceItems={workspaceItems}
          connectionItems={connectionItems}
        />
        <Link href="/app" className="mobile-brand"><span className="brand-mark" aria-hidden="true">F</span><strong>Business Finlynq</strong></Link>
        <div className="mobile-utilities"><AccountMenu principal={accountPrincipal} /></div>
      </div>

      <div className="main-shell">
        <div className="utility-bar">
          <EntityContextSwitcher context={entityContext} />
          <div className="utility-actions">
            <div className="workspace-session-note">
              <span className="read-only-dot" aria-hidden="true" />
              <strong>{principal.sessionMode === "demo" ? "Public demo" : "Accounting workspace"}</strong>
              <span>{principal.sessionMode === "demo"
                ? readOnly ? "Sandbox writes disabled" : "Resets nightly"
                : readOnly ? "Writes disabled" : "Role-based posting"}</span>
            </div>
            <GlobalSearch entries={searchIndex} />
          </div>
        </div>
        <main id="main-content">{children}</main>
        <footer className="app-footer">
          <span>Business Finlynq foundation · AGPL-3.0-or-later</span>
          <span>{principal.sessionMode === "demo" ? "Synthetic demo data · do not enter real information" : "Encrypted organization workspace"}</span>
        </footer>
      </div>
    </div>
  );
}
