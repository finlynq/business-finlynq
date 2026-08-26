import { demoPayableBills } from "@/modules/demo/dashboard-data";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../../_components/ui";

export default async function BillsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const bills = demoPayableBills.filter((bill) => !query || Object.values(bill).join(" ").toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Accounts payable" title="Supplier bills" description="Confirmed bill journals are owned by Payables and route back here for any future correction workflow." />
      <DemoNotice>Bill confirmation, credits, payments, and allocations remain behind the write gate. No supplier record can be changed from this demo.</DemoNotice>
      {bills.length ? <div className="record-grid">{bills.map((bill) => <article className="record-card" id={`bill-${bill.id}`} key={bill.id}><div><span className="code-chip">{bill.number}</span><StatusPill status={bill.status} /></div><h2>{bill.supplierName}</h2><p>{bill.entityCode} · billed {bill.billDate} · due {bill.dueOn}</p><strong className="record-amount">{bill.currency} {bill.total}</strong><dl><div><dt>Open amount</dt><dd>{bill.currency} {bill.openAmount}</dd></div><div><dt>Tax</dt><dd>{bill.currency} {bill.tax}</dd></div><div><dt>Ledger link</dt><dd>{bill.journalId ?? "Not posted · review draft"}</dd></div></dl></article>)}</div> : <EmptyState title="No bill found">Search by bill number, supplier, status, or entity.</EmptyState>}
    </div>
  );
}
