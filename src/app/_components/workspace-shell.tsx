import Link from "next/link";
import {
  demoCurrentActor,
  demoDashboard,
  demoSearchIndex,
  demoWriteState,
} from "@/modules/demo/dashboard-data";
import { AccountMenu } from "./account-menu.client";
import { GlobalSearch, type SearchEntry } from "./global-search.client";
import {
  DesktopNavigation,
  MobileNavigation,
  type NavigationItem,
} from "./navigation.client";

const workspaceItems: readonly NavigationItem[] = [
  { abbreviation: "OV", label: "Overview", href: "/" },
  { abbreviation: "GL", label: "General ledger", href: "/journals" },
  { abbreviation: "AR", label: "Receivables", href: "/receivables/invoices" },
  { abbreviation: "AP", label: "Payables", href: "/payables/bills" },
  { abbreviation: "TX", label: "Tax", href: "/tax" },
  { abbreviation: "RP", label: "Reports", href: "/reports/trial-balance" },
  { abbreviation: "CT", label: "Controls", href: "/controls/period-close", badge: "2" },
];

const connectionItems: readonly NavigationItem[] = [
  { abbreviation: "AI", label: "AI & MCP", href: "/automation" },
];

function createSearchIndex(): readonly SearchEntry[] {
  const routes: SearchEntry[] = [...workspaceItems, ...connectionItems].map((item) => ({
    label: item.label,
    detail: "Workspace page",
    href: item.href,
    keywords: item.abbreviation,
  }));
  const records: SearchEntry[] = demoSearchIndex.map((entry) => ({
      label: entry.title,
      detail: entry.subtitle,
      href: entry.href,
      keywords: `${entry.kind} ${entry.keywords.join(" ")} ${entry.entityCode ?? ""}`,
    }));
  return [...routes, ...records];
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const organization = demoDashboard.organization;
  const searchIndex = createSearchIndex();

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar" aria-label="Primary navigation">
        <Link href="/" className="brand-lockup" aria-label="Business Finlynq overview">
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
          <div className="avatar" aria-hidden="true">{demoCurrentActor.initials}</div>
          <div><strong>{demoCurrentActor.displayName}</strong><span>{demoCurrentActor.roleLabel} · writes disabled</span></div>
          <AccountMenu />
        </div>
      </aside>

      <div className="mobile-bar">
        <MobileNavigation
          organizationName={organization.name}
          workspaceItems={workspaceItems}
          connectionItems={connectionItems}
        />
        <Link href="/" className="mobile-brand"><span className="brand-mark" aria-hidden="true">F</span><strong>Business Finlynq</strong></Link>
        <div className="mobile-utilities"><AccountMenu /></div>
      </div>

      <div className="main-shell">
        <div className="utility-bar">
          <div>
            <span className="read-only-dot" aria-hidden="true" />
            <strong>Read-only demo</strong>
            <span>{demoWriteState.message}</span>
          </div>
          <GlobalSearch entries={searchIndex} />
        </div>
        <main id="main-content">{children}</main>
        <footer className="app-footer">
          <span>Business Finlynq foundation · AGPL-3.0-or-later</span>
          <span>Demo data · not financial advice</span>
        </footer>
      </div>
    </div>
  );
}
