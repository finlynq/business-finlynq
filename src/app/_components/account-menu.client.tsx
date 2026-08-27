"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

export type AccountMenuPrincipal = Readonly<{
  displayName: string;
  organizationName: string;
  roleLabel: string;
  sessionMode: "real" | "demo";
  isPlatformAdministrator: boolean;
}>;

export function showPlatformAdministrationLink(principal: AccountMenuPrincipal): boolean {
  return principal.isPlatformAdministrator;
}

export function AccountMenu({ principal }: { principal: AccountMenuPrincipal }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button account-trigger"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        •••
      </button>
      {open && (
        <div id={panelId} className="account-panel-popover" role="region" aria-label="Account details">
          <strong>{principal.displayName}</strong>
          <span>{principal.organizationName} · {principal.roleLabel}</span>
          <p>{principal.sessionMode === "demo" ? "Public synthetic sandbox. Changes are disposable; do not enter real information or connect external systems." : "Your session is checked against active organization membership and roles."}</p>
          <div className="account-popover-actions">
            <Link className="secondary-button compact-button" href="/app/settings" onClick={() => setOpen(false)}>Settings</Link>
            {showPlatformAdministrationLink(principal) && <Link className="secondary-button compact-button" href="/app/platform" onClick={() => setOpen(false)}>Platform operations</Link>}
            {principal.sessionMode === "demo" && <Link className="secondary-button compact-button" href="/signup" onClick={() => setOpen(false)}>Create account</Link>}
            <Link className="secondary-button compact-button" href="/" onClick={() => setOpen(false)}>Website</Link>
            <form action="/api/auth/logout" method="post"><button type="submit" className="primary-button compact-button">Sign out</button></form>
          </div>
        </div>
      )}
    </div>
  );
}
