"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import styles from "./workspace-navigation.module.css";

export type RouteTab = Readonly<{ key: string; label: string; href: string }>;

export function RouteTabs({ label, active, tabs }: {
  label: string;
  active: string;
  tabs: readonly RouteTab[];
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const rail = ref.current;
    const selected = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !selected) return;
    const item = selected.getBoundingClientRect();
    const bounds = rail.getBoundingClientRect();
    if (item.left < bounds.left) rail.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) rail.scrollLeft += item.right - bounds.right;
  }, [active]);
  return <nav ref={ref} className={styles.tabs} aria-label={label}>
    {tabs.map((tab) => <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? "page" : undefined}>{tab.label}</Link>)}
  </nav>;
}

export function SettingsNavigation({ active }: { active: string }) {
  return <RouteTabs label="Settings pages" active={active} tabs={[
    { key: "organization", label: "Organization & team", href: "/app/settings" },
    { key: "accounting", label: "Accounting", href: "/app/settings/accounting" },
    { key: "entities", label: "Legal entities", href: "/app/entities" },
    { key: "documents", label: "Documents", href: "/app/settings/documents" },
    { key: "email", label: "Email automation", href: "/app/settings/email" },
    { key: "mcp", label: "AI connections", href: "/app/settings/mcp" },
  ]} />;
}
