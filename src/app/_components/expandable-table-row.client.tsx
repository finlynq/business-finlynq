"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** A full-width evidence row avoids putting a second table in a narrow cell. */
export function ExpandableTableRow({ cells, children, columns, label, triggerLabel, actionLayoutClassName, actions }: {
  cells: ReactNode;
  children: ReactNode;
  columns: number;
  label: string;
  triggerLabel?: string;
  actionLayoutClassName?: string;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const node = row.current;
    if (!node) return;
    const observer = new MutationObserver(() => {
      if (node.querySelector('[role="alert"]')?.textContent?.trim()) setOpen(true);
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return <>
    <tr>{cells}<td><div className={actionLayoutClassName}>{actions}<button type="button" className="secondary-button compact-button" aria-label={`${open ? "Hide" : "Show"} ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} {triggerLabel ?? label}</button></div></td></tr>
    <tr ref={row} id={id} className="expanded-row" hidden={!open} onInvalidCapture={() => { if (row.current) row.current.hidden = false; setOpen(true); }}><td colSpan={columns}>{children}</td></tr>
  </>;
}
