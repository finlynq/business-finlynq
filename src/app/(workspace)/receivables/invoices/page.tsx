import { demoReceivableInvoices } from "@/modules/demo/dashboard-data";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TenantModuleUnavailable } from "../../../_components/tenant-module-unavailable";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../../_components/ui";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/receivables/invoices");
  if (principal.sessionMode !== "demo") return <TenantModuleUnavailable moduleName="Accounts receivable" />;
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const invoices = demoReceivableInvoices.filter((invoice) => !query || Object.values(invoice).join(" ").toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Accounts receivable" title="Sales invoices" description="Issued invoice journals are owned by Receivables and cannot be edited from the general ledger." />
      <DemoNotice>Invoice issuing, credit notes, payments, and allocations remain behind the write gate. This route exposes the current sample source records only.</DemoNotice>
      {invoices.length ? <div className="record-grid">{invoices.map((invoice) => <article className="record-card" id={`invoice-${invoice.id}`} key={invoice.id}><div><span className="code-chip">{invoice.number}</span><StatusPill status={invoice.status} /></div><h2>{invoice.customerName}</h2><p>{invoice.entityCode} · issued {invoice.issuedOn} · due {invoice.dueOn}</p><strong className="record-amount">{invoice.currency} {invoice.total}</strong><dl><div><dt>Open amount</dt><dd>{invoice.currency} {invoice.openAmount}</dd></div><div><dt>Tax</dt><dd>{invoice.currency} {invoice.tax} · <StatusPill status={invoice.taxDecisionStatus} /></dd></div><div><dt>Ledger link</dt><dd>{invoice.journalId ?? "Not posted · review draft"}</dd></div></dl></article>)}</div> : <EmptyState title="No invoice found">Search by invoice number, customer, status, or entity.</EmptyState>}
    </div>
  );
}
