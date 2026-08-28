import Link from "next/link";
import { ArApWorkspace } from "@/app/_components/ar-ap-workspace.client";
import { DemoNotice, EmptyState, PageHeader } from "@/app/_components/ui";
import { loadSubledgerWorkspace } from "@/modules/subledger/workspace";
import type { SubledgerDueFilter } from "@/modules/subledger/register-filter";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { TenantModuleUnavailable } from "../../../_components/tenant-module-unavailable";

export default async function InvoicesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const principal = await requireWorkspacePrincipal("/app/receivables/invoices");
  const parameters = await searchParams;
  const scalar = (key: string) => typeof parameters[key] === "string" ? parameters[key] : undefined;
  const entityContext = await currentWorkspaceEntityContext(principal);
  const entityParameter = scalar("entity");
  const workspace = await loadSubledgerWorkspace(principal, "receivables", {
    search: scalar("q"),
    entityCode: entityParameter === undefined ? entityContext.selectedEntity?.code ?? "" : entityParameter,
    status: scalar("status"),
    currency: scalar("currency"),
    dateFrom: scalar("dateFrom"),
    dateTo: scalar("dateTo"),
    due: scalar("due") as SubledgerDueFilter | undefined,
    page: scalar("page") ? Number(scalar("page")) : undefined,
  }, entityContext.selectedEntity?.id ?? null);
  if (!workspace.canRead) return <TenantModuleUnavailable moduleName="Accounts receivable" />;
  const ready = workspace.entities.some((entity) =>
    entity.periods.length > 0 && entity.partyAccounts.length > 0 &&
    entity.lineAccounts.length > 0 && entity.taxAccounts.length > 0);

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Accounts receivable"
        title="Sales invoices & receipts"
        description="Draft service invoices, determine tax, post immutable AR journals, allocate receipts, and correct mistakes by voiding at the source."
        actions={<Link className="secondary-button" href="/app/parties">Manage customers</Link>}
      />
      {workspace.demoOnly && (
        <DemoNotice>
          This is your private writable demo business. Create, issue, allocate, and void transactions freely; the same browser can return after logout or session expiry, and the seeded company is restored nightly.
        </DemoNotice>
      )}
      {!ready ? (
        <EmptyState title="Receivables setup is incomplete">
          Add an active legal entity, primary ledger, open fiscal period, customer party account, chart combinations, and tax registration before entering invoices.
        </EmptyState>
      ) : (
        <ArApWorkspace key={JSON.stringify([workspace.registerFilter, workspace.pagination.page])} workspace={workspace} />
      )}
    </div>
  );
}
