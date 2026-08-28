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
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="account-menu">
      <button
        ref={triggerRef}
        type="button"
        className="icon-button account-trigger"
        aria-label="Open account and security menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">•••</span>
      </button>

      <dialog
        ref={dialogRef}
        id={dialogId}
        className="account-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={close}
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={close}
      >
        <div className="account-panel-popover" onClick={(event) => event.stopPropagation()}>
          <div className="account-popover-heading">
            <div>
              <strong id={titleId}>{principal.displayName}</strong>
              <span>{principal.organizationName} · {principal.roleLabel}</span>
            </div>
            <button type="button" className="icon-button close-button" aria-label="Close account menu" onClick={close}>×</button>
          </div>
          <p id={descriptionId}>{principal.sessionMode === "demo" ? "Public synthetic sandbox. Changes are disposable; do not enter real information or connect external systems." : "Your session is checked against active organization membership and roles."}</p>
          <div className="account-popover-actions">
            <Link className="secondary-button compact-button" href="/app/account" onClick={close}>Account &amp; security</Link>
            <Link className="secondary-button compact-button" href="/app/settings" onClick={close}>Organization settings</Link>
            {showPlatformAdministrationLink(principal) && <Link className="secondary-button compact-button" href="/app/platform" onClick={close}>Platform operations</Link>}
            {principal.sessionMode === "demo" && <Link className="secondary-button compact-button" href="/signup" onClick={close}>Create account</Link>}
            <Link className="secondary-button compact-button" href="/" onClick={close}>Website</Link>
            <form action="/api/auth/logout" method="post"><button type="submit" className="primary-button compact-button">Sign out</button></form>
          </div>
        </div>
      </dialog>
    </div>
  );
}
