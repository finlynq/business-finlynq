import Link from "next/link";
import styles from "./workspace-navigation.module.css";

export type RouteTab = Readonly<{ key: string; label: string; href: string }>;

export function RouteTabs({ label, active, tabs }: {
  label: string;
  active: string;
  tabs: readonly RouteTab[];
}) {
  return <nav className={styles.tabs} aria-label={label}>
    {tabs.map((tab) => <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? "page" : undefined}>{tab.label}</Link>)}
  </nav>;
}

export function SettingsNavigation({ active }: { active: string }) {
  return <RouteTabs label="Settings pages" active={active} tabs={[
    { key: "organization", label: "Organization & team", href: "/app/settings" },
    { key: "accounting", label: "Accounting", href: "/app/settings/accounting" },
    { key: "entities", label: "Legal entities", href: "/app/entities" },
    { key: "documents", label: "Documents", href: "/app/settings/documents" },
    { key: "mcp", label: "AI connections", href: "/app/settings/mcp" },
  ]} />;
}
