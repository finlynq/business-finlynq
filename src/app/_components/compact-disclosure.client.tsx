"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Native disclosure: contents stay mounted, including unfinished form values. */
export function CompactDisclosure({ summary, children, defaultOpen = false, attention = false, desktopOpen = false, id, className = "" }: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  attention?: boolean;
  desktopOpen?: boolean;
  id?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!desktopOpen) return;
    const media = window.matchMedia("(min-width:861px)");
    const update = () => { if (ref.current) ref.current.open = media.matches; };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [desktopOpen]);
  useEffect(() => {
    if (attention && ref.current) ref.current.open = true;
  }, [attention]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const revealErrors = () => {
      if (node.querySelector('[role="alert"]')?.textContent?.trim()) node.open = true;
    };
    revealErrors();
    const observer = new MutationObserver(revealErrors);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const revealTarget = () => {
      let target: HTMLElement | null = null;
      try { target = document.getElementById(decodeURIComponent(window.location.hash.slice(1))); } catch { return; }
      if (target && ref.current?.contains(target)) {
        ref.current.open = true;
        window.requestAnimationFrame(() => target.scrollIntoView?.({ block: "nearest" }));
      }
    };
    revealTarget();
    window.addEventListener("hashchange", revealTarget);
    return () => window.removeEventListener("hashchange", revealTarget);
  }, []);
  return <details ref={ref} id={id} open={defaultOpen} className={`workspace-disclosure compact-disclosure ${className}`} onInvalidCapture={(event) => {
    // A browser must be able to focus an invalid required field inside closed details.
    let ancestor: HTMLElement | null = event.target as HTMLElement;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    const field = event.target as HTMLElement;
    window.requestAnimationFrame(() => field.focus());
  }}>
    <summary>{summary}</summary>
    <div className="disclosure-content">{children}</div>
  </details>;
}
