import Link from "next/link";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusPill({ status }: { status: string }) {
  const success = status === "POSTED" || status === "APPLIED" || status === "OPEN";
  const blocked = status === "BLOCKED" || status.includes("REVIEW") || status.includes("ADJUSTMENT");
  return <span className={`status-pill ${success ? "status-success" : blocked ? "status-warning" : "status-neutral"}`}>{status}</span>;
}

export function DemoNotice({ children }: { children: React.ReactNode }) {
  return (
    <aside className="demo-notice" aria-label="Demo limitation">
      <span aria-hidden="true">i</span>
      <p>{children}</p>
    </aside>
  );
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong><p>{children}</p></div>;
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link className="back-link" href={href}><span aria-hidden="true">←</span>{children}</Link>;
}
