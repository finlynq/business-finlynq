import Link from "next/link";
import { demoDashboard } from "@/modules/demo/dashboard-data";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

export default async function JournalsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const journals = demoDashboard.journals.filter((journal) => !query || Object.values(journal).join(" ").toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="General ledger" title="Journals" description="Posted journals are immutable; correction ownership follows the source module." actions={<Link className="primary-button" href="/journals/new">＋ New journal</Link>} />
      <DemoNotice>These are sample records. Source-owned invoice and bill journals are view-only here and must be corrected in AR or AP.</DemoNotice>
      {journals.length ? <section className="panel" aria-label="Journal register"><div className="table-scroll" tabIndex={0}><table><caption className="sr-only">Journal register</caption><thead><tr><th scope="col">Journal</th><th scope="col">Source</th><th scope="col">Owner</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead><tbody>{journals.map((journal) => <tr key={`${journal.entity}-${journal.number}-${journal.source}`}><td><strong>{journal.number}</strong><small>{journal.date} · {journal.entity}</small></td><td><strong>{journal.source}</strong><small>{journal.typeKey}</small></td><td>{journal.owner}</td><td className="amount-cell">{journal.amount}</td><td><StatusPill status={journal.status} /></td></tr>)}</tbody></table></div></section> : <EmptyState title="No journals found">Clear the search query or search by journal, source, entity, or owner.</EmptyState>}
    </div>
  );
}
