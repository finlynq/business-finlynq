import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney } from "@/kernel/money";
import { currentPrincipal } from "@/modules/identity/session";
import { loadTenantJournalWorkspace, type TenantJournalDto } from "@/modules/ledger/tenant-workspace";
import { JournalRegisterAction } from "../../_components/journal-register-action.client";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

function formatAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

function sourceModuleHref(journal: TenantJournalDto): string | null {
  const expectedBase = journal.ownerModule === "receivables"
    ? "/app/receivables/invoices"
    : journal.ownerModule === "payables" ? "/app/payables/bills" : null;
  if (!expectedBase) return null;
  const base = journal.correctionRoute === expectedBase ? journal.correctionRoute : expectedBase;
  return journal.sourceNumber ? `${base}?q=${encodeURIComponent(journal.sourceNumber)}` : base;
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
      {workspace.demoOnly && <DemoNotice>This is your isolated writable sandbox. Changes are private to this session and the seeded company is restored automatically after use.</DemoNotice>}
      <aside className="demo-notice" aria-label="Journal correction ownership">
        <span aria-hidden="true">i</span>
        <p>Manual journals can be posted or fully reversed here when your role permits. AR and AP journals remain immutable in the general ledger and must be corrected in their source module.</p>
      </aside>
      {workspace.readiness === "EMPTY_ORGANIZATION" && (
        <EmptyState title="Accounting setup is not complete">Create a legal entity, primary ledger, fiscal calendar, and chart of accounts before entering journals.</EmptyState>
      )}
      {workspace.journals.length ? (
        <section className="panel" aria-label="Journal register">
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Journal register</caption>
              <thead><tr><th scope="col">Journal</th><th scope="col">Description</th><th scope="col">Owner</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
              <tbody>{workspace.journals.map((journal) => {
                const sourceHref = sourceModuleHref(journal);
                const reversalPeriods = workspace.reversalPeriods.filter((period) => period.ledgerId === journal.ledgerId);
                return (
                  <tr key={journal.id}>
                    <td><strong>{journal.number}</strong><small>{journal.accountingDate} · {journal.entityCode}</small></td>
                    <td><strong>{journal.description}</strong><small>{journal.typeKey}{journal.reversalOfNumber ? ` · reverses ${journal.reversalOfNumber}` : ""}{journal.reversedByNumber ? ` · reversed by ${journal.reversedByNumber}` : ""}</small></td>
                    <td>{journal.ownerModule}</td>
                    <td className="amount-cell">{formatAmount(journal.currency, journal.amount)}</td>
                    <td><StatusPill status={journal.reversedByNumber ? "REVERSED" : journal.status} /></td>
                    <td>
                      {journal.canPost && journal.expectedContentHash ? (
                        <JournalRegisterAction
                          key={`${journal.id}:post`}
                          journalId={journal.id}
                          journalNumber={journal.number}
                          journalDescription={journal.description}
                          action={{ kind: "post", expectedContentHash: journal.expectedContentHash }}
                        />
                      ) : journal.canReverse && reversalPeriods.length > 0 ? (
                        <JournalRegisterAction
                          key={`${journal.id}:reverse`}
                          journalId={journal.id}
                          journalNumber={journal.number}
                          journalDescription={journal.description}
                          action={{ kind: "reverse", periods: reversalPeriods }}
                        />
                      ) : sourceHref ? (
                        <Link className="text-link compact-button" href={sourceHref}>Open {journal.ownerModule === "receivables" ? "AR" : "AP"} source</Link>
                      ) : journal.reversedByNumber ? (
                        <span className="subtle-label">Reversal posted</span>
                      ) : (
                        <span className="subtle-label">No action</span>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      ) : workspace.readiness === "READY" ? (
        <EmptyState title="No journals found">{query ? "Clear the search query or search by journal, description, entity, or type." : "Create the first authorized journal draft for this ledger."}</EmptyState>
      ) : null}
    </div>
  );
}
