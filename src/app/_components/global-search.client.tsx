"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

export type SearchEntry = Readonly<{
  label: string;
  detail: string;
  href: string;
  keywords: string;
}>;

export function GlobalSearch({ entries, includesDemoRecords = false }: { entries: readonly SearchEntry[]; includesDemoRecords?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");

  const open = () => {
    setQuery("");
    dialogRef.current?.showModal();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const close = () => {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return entries.slice(0, 8);
    return entries.filter((entry) =>
      `${entry.label} ${entry.detail} ${entry.keywords}`.toLocaleLowerCase().includes(normalized),
    ).slice(0, 12);
  }, [entries, query]);

  return (
    <>
      <button ref={triggerRef} type="button" className="search-button" aria-label="Search" onClick={open}>
        <span aria-hidden="true">⌕</span>
        <span className="search-button-label">Find a page or report</span>
        <kbd>Ctrl/⌘ K</kbd>
      </button>
      <dialog ref={dialogRef} className="search-dialog" aria-labelledby="search-title" onClose={() => setQuery("")}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">Workspace navigation</span>
            <h2 id="search-title">Search Business Finlynq</h2>
          </div>
          <button type="button" className="icon-button close-button" aria-label="Close search" onClick={close}>×</button>
        </div>
        <label className="search-field">
          <span className="sr-only">{includesDemoRecords ? "Search pages and demo records" : "Search workspace pages"}</span>
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={includesDemoRecords ? "Page, report or sample record" : "Page, report or setting"}
          />
        </label>
        <div className="search-results" aria-live="polite">
          {results.length > 0 ? (
            <ul>
              {results.map((entry) => (
                <li key={`${entry.href}-${entry.label}`}>
                  <Link href={entry.href} onClick={() => dialogRef.current?.close()}>
                    <strong>{entry.label}</strong>
                    <span>{entry.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-search">No results match “{query.trim()}”. Try a page name such as Reports or Banking.</p>
          )}
        </div>
        <p className="dialog-footnote">{includesDemoRecords ? "Find workspace pages and seeded demo examples. Use each register to search current transactions." : "Find pages and settings. Use the journal, invoice, bill or party register to search your organization’s records."}</p>
      </dialog>
    </>
  );
}
