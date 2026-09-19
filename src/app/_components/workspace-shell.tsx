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
  { abbreviation: "AR", label: "Receivables", href: "/app/receivables/invoices" },
  { abbreviation: "AP", label: "Payables", href: "/app/payables/bills" },
  { abbreviation: "BK", label: "Banking", href: "/app/banking" },
  { abbreviation: "AS", label: "Assets & prepaids", href: "/app/assets" },
  { abbreviation: "DC", label: "Documents", href: "/app/settings/documents" },
  { abbreviation: "EM", label: "Email automation", href: "/app/settings/email" },
  { abbreviation: "RP", label: "Reports", href: "/app/reports", group: "Review & close" },
  { abbreviation: "TX", label: "Tax", href: "/app/tax", group: "Review & close" },
  { abbreviation: "CT", label: "Period close", href: "/app/controls/period-close", group: "Review & close" },
  { abbreviation: "PT", label: "Parties", href: "/app/parties", group: "Administration" },
  { abbreviation: "EN", label: "Legal entities", href: "/app/entities", group: "Administration" },
  { abbreviation: "ST", label: "Settings", href: "/app/settings", group: "Administration" },
];

const connectionItems: readonly NavigationItem[] = [
  { abbreviation: "AI", label: "AI & MCP", href: "/app/settings/mcp", group: "Administration" },
];

function createSearchIndex(includeDemoRecords: boolean): readonly SearchEntry[] {
  const routes: SearchEntry[] = [...workspaceItems, ...connectionItems].map((item) => ({
    label: item.label,
    detail: "Workspace page",
    href: item.href,
    keywords: item.abbreviation,
  }));
  routes.push(
    { label: "Trial balance", detail: "Report · debits and credits", href: "/app/reports/trial-balance", keywords: "GL balances export CSV" },
    { label: "Balance sheet", detail: "Report · financial position", href: "/app/reports/balance-sheet", keywords: "assets liabilities equity" },
    { label: "Profit & loss", detail: "Report · financial performance", href: "/app/reports/profit-and-loss", keywords: "income revenue expenses earnings" },
    { label: "Account inquiry", detail: "Report · transaction detail", href: "/app/reports/account-inquiry", keywords: "GL journal activity" },
    { label: "Accounting configuration", detail: "Settings · entities, accounts and currencies", href: "/app/settings/accounting", keywords: "chart dimensions tax packs exchange rates hierarchies" },
    { label: "Email automation", detail: "Settings · invoice ingest and delivery operations", href: "/app/settings/email", keywords: "email invoices resend quarantine payment profiles delivery" },
    { label: "Account & security", detail: "Your profile and authentication", href: "/app/account", keywords: "MFA authenticator trusted browsers" },
    { label: "MCP connection guide", detail: "Help · connect an AI client", href: "/docs/remote-mcp", keywords: "documentation OAuth integration" },
  );
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

      <div className="main-shell">
        <div className="utility-bar">
          <div className="utility-mobile-menu"><MobileNavigation organizationName={organization.name} workspaceItems={workspaceItems} connectionItems={connectionItems} /></div>
          <EntityContextSwitcher context={entityContext} />
          <div className="utility-actions">
            <div className="workspace-session-note">
              <span className="read-only-dot" aria-hidden="true" />
              <strong>{principal.sessionMode === "demo" ? "Public demo" : "Accounting workspace"}</strong>
              <span>{principal.sessionMode === "demo"
                ? readOnly ? "Sandbox writes disabled" : "Resets nightly"
                : readOnly ? "Writes disabled" : "Role-based posting"}</span>
            </div>
            <GlobalSearch entries={searchIndex} includesDemoRecords={principal.sessionMode === "demo"} />
            <div className="utility-mobile-account"><AccountMenu principal={accountPrincipal} /></div>
          </div>
        </div>
        <main id="main-content">{children}</main>
        <footer className="app-footer">
          <span>Business Finlynq · <Link href="/docs/remote-mcp">Connection guide</Link> · <Link href="/security">Security</Link></span>
          <span>{principal.sessionMode === "demo" ? "Synthetic demo data · do not enter real information" : "Encrypted organization workspace"}</span>
        </footer>
      </div>
    </div>
  );
}
