"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type NavigationItem = Readonly<{
  abbreviation: string;
  label: string;
  href: string;
  badge?: string;
  group?: "Daily work" | "Review & close" | "Administration";
}>;

export function currentNavigationHref(pathname: string, items: readonly NavigationItem[]): string | undefined {
  return items.filter(({ href }) => href === "/app"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}

function NavigationLinks({
  items,
  allItems,
  onNavigate,
}: {
  items: readonly NavigationItem[];
  allItems: readonly NavigationItem[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const activeHref = currentNavigationHref(pathname, allItems);

  return (
    <ul className="nav-list">
      {items.map((item) => {
        const current = activeHref === item.href;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={current ? "active" : undefined}
              onClick={onNavigate}
            >
              <span className="nav-icon" aria-hidden="true">{item.abbreviation}</span>
              <span>{item.label}</span>
              {item.badge && <span className="nav-count" aria-label={`${item.badge} items need attention`}>{item.badge}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DesktopNavigation({
  workspaceItems,
  connectionItems,
}: {
  workspaceItems: readonly NavigationItem[];
  connectionItems: readonly NavigationItem[];
}) {
  return (
    <nav className="desktop-navigation" aria-label="Workspace">
      <NavigationGroups workspaceItems={workspaceItems} connectionItems={connectionItems} />
    </nav>
  );
}

function NavigationGroups({ workspaceItems, connectionItems, onNavigate }: {
  workspaceItems: readonly NavigationItem[];
  connectionItems: readonly NavigationItem[];
  onNavigate?: () => void;
}) {
  const allItems = [...workspaceItems, ...connectionItems];
  return <>{(["Daily work", "Review & close", "Administration"] as const).map((group) => {
    const items = allItems.filter((item) => (item.group ?? "Daily work") === group);
    return items.length > 0 && <div className="nav-group" key={group}>
      <p className="nav-label">{group}</p>
      <NavigationLinks items={items} allItems={allItems} onNavigate={onNavigate} />
    </div>;
  })}</>;
}

export function MobileNavigation({
  organizationName,
  workspaceItems,
  connectionItems,
}: {
  organizationName: string;
  workspaceItems: readonly NavigationItem[];
  connectionItems: readonly NavigationItem[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (event.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;

        const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ));
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !panel.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mobile-menu-button"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-navigation-panel"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {open && (
        <div className="mobile-nav-layer">
          <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation" onClick={close} />
          <div ref={panelRef} id="mobile-navigation-panel" className="mobile-nav-panel" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="mobile-nav-heading">
              <div>
                <span className="eyebrow">Workspace</span>
                <strong>{organizationName}</strong>
              </div>
              <button ref={closeRef} className="icon-button close-button" type="button" aria-label="Close navigation" onClick={close}>×</button>
            </div>
            <nav aria-label="Mobile workspace">
              <NavigationGroups workspaceItems={workspaceItems} connectionItems={connectionItems} onNavigate={close} />
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
