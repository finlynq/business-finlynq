"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandLockup } from "@/app/_components/brand-lockup";
import styles from "../marketing.module.css";

const navigation = [
  ["Product", "#product"],
  ["Controls", "#controls"],
  ["Multicurrency", "#multicurrency"],
  ["AI & MCP", "#ai"],
  ["Open source", "#open-source"],
] as const;

export function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const headerContent = headerContentRef.current;
    const firstLink = panel?.querySelector<HTMLElement>("a[href]");
    firstLink?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('a[href],button:not([disabled])'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.body.style.overflow = "hidden";
    headerContent?.setAttribute("inert", "");
    document.querySelector("main")?.setAttribute("inert", "");
    document.querySelector("footer")?.setAttribute("inert", "");
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      headerContent?.removeAttribute("inert");
      document.querySelector("main")?.removeAttribute("inert");
      document.querySelector("footer")?.removeAttribute("inert");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <header className={styles.header}>
      <div ref={headerContentRef} className={styles.headerInner}>
        <BrandLockup />
        <nav className={styles.desktopNav} aria-label="Website">
          {navigation.map(([label, href]) => <a href={href} key={href}>{label}</a>)}
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.signInLink} href="/login">Sign in</Link>
          <Link className={styles.headerDemo} href="/try-demo?next=/app" prefetch={false}>Open demo</Link>
        </div>
        <button
          ref={triggerRef}
          className={styles.menuButton}
          type="button"
          aria-label="Open website navigation"
          aria-expanded={open}
          aria-controls="marketing-mobile-nav"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className={styles.mobileLayer}>
          <button className={styles.mobileBackdrop} type="button" aria-label="Close website navigation" onClick={close} />
          <div ref={panelRef} id="marketing-mobile-nav" className={styles.mobilePanel} role="dialog" aria-modal="true" aria-label="Website navigation">
            <div className={styles.mobilePanelHeading}>
              <BrandLockup inverse />
              <button className={styles.mobileClose} type="button" aria-label="Close website navigation" onClick={close}>×</button>
            </div>
            <nav aria-label="Mobile website">
              {navigation.map(([label, href]) => <a href={href} key={href} onClick={close}>{label}</a>)}
            </nav>
            <div className={styles.mobileActions}>
              <Link href="/login" onClick={close}>Sign in</Link>
              <Link href="/try-demo?next=/app" prefetch={false} onClick={close}>Open live demo</Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
