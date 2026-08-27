import Link from "next/link";
import { ArApWorkspace } from "@/app/_components/ar-ap-workspace.client";
import { DemoNotice, EmptyState, PageHeader } from "@/app/_components/ui";
import { loadSubledgerWorkspace } from "@/modules/subledger/workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TenantModuleUnavailable } from "../../../_components/tenant-module-unavailable";

export default async function BillsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ q?: string }> }>) {
  const principal = await requireWorkspacePrincipal("/app/payables/bills");
  const query = (await searchParams).q?.trim() ?? "";
  const workspace = await loadSubledgerWorkspace(principal, "payables", query);
  if (!workspace.canRead) return <TenantModuleUnavailable moduleName="Accounts payable" />;
  const ready = workspace.entities.some((entity) =>
    entity.periods.length > 0 && entity.partyAccounts.length > 0 &&
    entity.lineAccounts.length > 0 && entity.taxAccounts.length > 0);

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Accounts payable"
        title="Supplier bills & payments"
        description="Capture service bills, determine recoverable tax, post immutable AP journals, allocate payments, and correct mistakes by voiding at the source."
        actions={<Link className="secondary-button" href="/app/parties">Manage suppliers</Link>}
      />
      {workspace.demoOnly && (
        <DemoNotice>
          This is your private writable demo business. Create, issue, allocate, and void transactions freely; the seeded company is restored automatically every night and after the sandbox expires.
        </DemoNotice>
      )}
      {!ready ? (
        <EmptyState title="Payables setup is incomplete">
          Add an active legal entity, primary ledger, open fiscal period, supplier party account, chart combinations, and tax registration before entering bills.
        </EmptyState>
      ) : (
        <ArApWorkspace workspace={workspace} />
      )}
    </div>
  );
}
