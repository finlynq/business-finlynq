import { BankingWorkspace } from "@/app/_components/banking-workspace.client";
import { RouteTabs } from "@/app/_components/route-tabs";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { loadBankingWorkspace } from "@/modules/banking/banking-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

type BankingView = "connections" | "reconciliation" | "rules";

export default async function BankingPage({ searchParams }: {
  searchParams: Promise<{
    view?: string;
    reconciliation?: string;
    bankAfter?: string;
    booksAfter?: string;
    pageSize?: string;
  }>;
}) {
  const principal = await requireWorkspacePrincipal("/app/banking");
  const requestedParams = await searchParams;
  const requested = requestedParams.view;
  const view: BankingView = requested === "reconciliation" || requested === "rules" ? requested : "connections";
  const workspace = await loadBankingWorkspace(principal, requestedParams.reconciliation, {
    bankAfter: requestedParams.bankAfter,
    booksAfter: requestedParams.booksAfter,
    pageSize: requestedParams.pageSize ? Number(requestedParams.pageSize) : undefined,
  });

  return <div className="page-content">
    <PageHeader
      eyebrow="Bank feeds and reconciliation"
      title="Banking"
      description="Connect bank feeds, review transactions and reconcile statement balances with your posted cash activity."
    />
    {workspace.isDemo && <DemoNotice>External credentials and live provider calls are disabled in the public demo. Synthetic observations reset nightly; mapping, matching, reconciliation, and immutable rule-version controls remain writable.</DemoNotice>}
    <RouteTabs label="Banking views" active={view} tabs={[
      { key: "connections", label: "Connections & transactions", href: "/app/banking" },
      { key: "reconciliation", label: "Reconciliation", href: "/app/banking?view=reconciliation" },
      { key: "rules", label: "Categorization rules", href: "/app/banking?view=rules" },
    ]} />
    <BankingWorkspace workspace={workspace} view={view} />
  </div>;
}
export const metadata = { title: "Banking" };
