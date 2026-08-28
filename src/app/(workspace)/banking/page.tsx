import Link from "next/link";
import { BankingWorkspace } from "@/app/_components/banking-workspace.client";
import styles from "@/app/_components/banking-workspace.module.css";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { loadBankingWorkspace } from "@/modules/banking/banking-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

type BankingView = "connections" | "reconciliation" | "rules";

export default async function BankingPage({ searchParams }: {
  searchParams: Promise<{ view?: string; reconciliation?: string }>;
}) {
  const principal = await requireWorkspacePrincipal("/app/banking");
  const requestedParams = await searchParams;
  const requested = requestedParams.view;
  const view: BankingView = requested === "reconciliation" || requested === "rules" ? requested : "connections";
  const workspace = await loadBankingWorkspace(principal, requestedParams.reconciliation);

  return <div className="page-content">
    <PageHeader
      eyebrow="Bank feeds and reconciliation"
      title="Banking"
      description="Import provider observations without treating them as books, map each account explicitly, reconcile against posted cash lines, and let rules produce encrypted manual-review suggestions without posting."
    />
    {workspace.isDemo && <DemoNotice>External credentials and live provider calls are disabled in the public demo. Synthetic observations reset nightly; mapping, matching, reconciliation, and immutable rule-version controls remain writable.</DemoNotice>}
    <nav className={styles.tabs} aria-label="Banking views">
      <Link href="/app/banking" data-active={view === "connections"}>Connections & transactions</Link>
      <Link href="/app/banking?view=reconciliation" data-active={view === "reconciliation"}>Reconciliation</Link>
      <Link href="/app/banking?view=rules" data-active={view === "rules"}>Categorization rules</Link>
    </nav>
    <BankingWorkspace workspace={workspace} view={view} />
  </div>;
}
