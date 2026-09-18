"use client";

import { Children, useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import styles from "./workspace-navigation.module.css";

type Section = Readonly<{ id: string; label: string }>;

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  window.addEventListener("popstate", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
    window.removeEventListener("popstate", callback);
  };
}

/** Keep every panel mounted so moving between sections preserves unfinished forms. */
export function SectionTabs({ label, sections, children, defaultSection }: {
  label: string;
  sections: readonly Section[];
  children: ReactNode;
  defaultSection?: string;
}) {
  const instanceId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const hash = useSyncExternalStore(subscribe, () => window.location.hash.slice(1), () => "");
  const requestedIndex = sections.findIndex((section) => section.id === hash);
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : Math.max(0, sections.findIndex((section) => section.id === defaultSection));
  const panels = Children.toArray(children);
  useEffect(() => {
    const button = buttons.current[selectedIndex];
    const rail = button?.parentElement;
    if (!button || !rail) return;
    const item = button.getBoundingClientRect();
    const bounds = rail.getBoundingClientRect();
    if (item.left < bounds.left) rail.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) rail.scrollLeft += item.right - bounds.right;
  }, [selectedIndex]);

  function activate(index: number, focus = false) {
    const section = sections[index];
    if (!section) return;
    if (window.location.hash !== `#${section.id}`) {
      window.history.pushState(null, "", `#${section.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    if (focus) buttons.current[index]?.focus();
  }

  return <div className={styles.sections}>
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {sections.map((section, index) => <button
        key={section.id}
        ref={(node) => { buttons.current[index] = node; }}
        id={`${instanceId}-${section.id}-tab`}
        role="tab"
        type="button"
        aria-selected={selectedIndex === index}
        aria-controls={`${instanceId}-${section.id}-panel`}
        tabIndex={selectedIndex === index ? 0 : -1}
        onClick={() => activate(index)}
        onKeyDown={(event) => {
          const target = event.key === "ArrowRight" ? (index + 1) % sections.length
            : event.key === "ArrowLeft" ? (index - 1 + sections.length) % sections.length
              : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
          if (target !== null) { event.preventDefault(); activate(target, true); }
        }}
      >{section.label}</button>)}
    </div>
    {sections.map((section, index) => <div
      className={styles.tabPanel}
      key={section.id}
      id={`${instanceId}-${section.id}-panel`}
      role="tabpanel"
      aria-labelledby={`${instanceId}-${section.id}-tab`}
      hidden={selectedIndex !== index}
      tabIndex={0}
    >{panels[index]}</div>)}
  </div>;
}
