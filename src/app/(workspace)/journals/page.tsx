import Link from "next/link";
import { redirect } from "next/navigation";
import { exact } from "@/kernel/money";
import { currentPrincipal } from "@/modules/identity/session";
import { loadTenantJournalWorkspace } from "@/modules/ledger/tenant-workspace";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

function formatAmount(currency: string, amount: string): string {
  const [whole, fraction] = exact(amount).toFixed(2).split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

export default async function JournalsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login?next=%2Fapp%2Fjournals&reason=expired");
  const query = (await searchParams).q?.trim() ?? "";
  const workspace = await loadTenantJournalWorkspace(principal, query);
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="General ledger"
        title="Journals"
        description="Posted journals are immutable; correction ownership follows the source module."
        actions={workspace.canDraft ? <Link className="primary-button" href="/app/journals/new">＋ New journal</Link> : undefined}
      />
      {workspace.demoOnly && <DemoNotice>These records are synthetic, tenant-scoped PostgreSQL data. The public demo cannot create, post, or reverse them.</DemoNotice>}
      {!workspace.demoOnly && (
        <aside className="demo-notice" aria-label="Journal action availability">
          <span aria-hidden="true">i</span>
          <p>Manual draft creation and policy-driven auto-post are available here. Interactive post and reversal controls are not yet exposed in this register; the protected tenant APIs enforce those workflows until the reviewed UI is added.</p>
        </aside>
      )}
      {workspace.readiness === "EMPTY_ORGANIZATION" && (
        <EmptyState title="Accounting setup is not complete">Create a legal entity, primary ledger, fiscal calendar, and chart of accounts before entering journals.</EmptyState>
      )}
      {workspace.journals.length ? (
        <section className="panel" aria-label="Journal register">
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Journal register</caption>
              <thead><tr><th scope="col">Journal</th><th scope="col">Description</th><th scope="col">Owner</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
              <tbody>{workspace.journals.map((journal) => (
                <tr key={journal.id}>
                  <td><strong>{journal.number}</strong><small>{journal.accountingDate} · {journal.entityCode}</small></td>
                  <td><strong>{journal.description}</strong><small>{journal.typeKey}{journal.reversalOfNumber ? ` · reverses ${journal.reversalOfNumber}` : ""}</small></td>
                  <td>{journal.ownerModule}</td>
                  <td className="amount-cell">{formatAmount(journal.currency, journal.amount)}</td>
                  <td><StatusPill status={journal.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : workspace.readiness === "READY" ? (
        <EmptyState title="No journals found">{query ? "Clear the search query or search by journal, description, entity, or type." : "Create the first authorized journal draft for this ledger."}</EmptyState>
      ) : null}
    </div>
  );
}
