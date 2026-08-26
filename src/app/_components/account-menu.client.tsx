"use client";

import { useEffect, useId, useRef, useState } from "react";

export function AccountMenu() {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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
        <div id={panelId} className="account-panel-popover" role="dialog" aria-label="Demo account">
          <strong>Demo viewer</strong>
          <span>Read-only sample workspace</span>
          <p>No signed-in user session is active. Posting, role changes, recovery, and key administration remain unavailable.</p>
          <button type="button" className="secondary-button compact-button" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
