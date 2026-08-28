import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney } from "@/kernel/money";
import { currentPrincipal } from "@/modules/identity/session";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import { loadTenantJournalWorkspace, type TenantJournalDto } from "@/modules/ledger/tenant-workspace";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { normalizeRegisterPage } from "@/modules/workspace/register-pagination";
import { JournalRegisterAction } from "../../_components/journal-register-action.client";
import { RegisterPaginationNav } from "../../_components/register-pagination";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";
import styles from "./journal-register.module.css";

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

export default async function JournalsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login?next=%2Fapp%2Fjournals&reason=expired");
  const parameters = await searchParams;
  const query = parameters.q?.trim() ?? "";
  const page = normalizeRegisterPage(parameters.page);
  const entityContext = await currentWorkspaceEntityContext(principal);
  const workspace = await loadTenantJournalWorkspace(
    principal,
    query,
    entityContext.selectedEntity?.id ?? null,
    page,
  );
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="General ledger"
        title="Journals"
        description="Review the debit, credit, and ending posted balance for every booked account. Posted journals are immutable; correction ownership follows the source module."
        actions={workspace.canDraft ? <Link className="primary-button" href="/app/journals/new">＋ New journal</Link> : undefined}
      />
      {workspace.demoOnly && <DemoNotice>This is your isolated writable sandbox. Changes persist for this browser until the seeded company is restored nightly.</DemoNotice>}
      <aside className="demo-notice" aria-label="Journal correction ownership">
        <span aria-hidden="true">i</span>
        <p>Manual journals can be posted or fully reversed here when your role permits. AR and AP journals remain immutable in the general ledger and must be corrected in their source module.</p>
      </aside>
      {workspace.readiness === "EMPTY_ORGANIZATION" && (
        <EmptyState title="Accounting setup is not complete">Create a legal entity, primary ledger, fiscal calendar, and chart of accounts before entering journals.</EmptyState>
      )}
      {workspace.readiness === "READY" && (
        <form className="subledger-toolbar" method="get" aria-label="Filter journal register">
          <label className="full-field"><span>Journal, description, entity, or type</span><input type="search" name="q" defaultValue={query} maxLength={100} /></label>
          <button className="secondary-button" type="submit">Search</button>
          {query && <Link className="text-link compact-button" href="/app/journals">Clear</Link>}
        </form>
      )}
      {workspace.journals.length ? (
        <section className="panel" aria-label="Journal register">
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Journal register</caption>
              <thead><tr><th scope="col">Journal</th><th scope="col">Description</th><th scope="col">Account postings</th><th scope="col">Owner</th><th scope="col">Journal debit</th><th scope="col">Journal credit</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
              <tbody>{workspace.journals.map((journal) => {
                const sourceHref = sourceModuleHref(journal);
                const reversalPeriods = workspace.reversalPeriods.filter((period) => period.ledgerId === journal.ledgerId);
                return (
                  <tr key={journal.id}>
                    <td><Link className="text-link compact-button" href={`/app/journals/${journal.id}`}>{journal.number}</Link><small>{journal.accountingDate} · {journal.entityCode}</small></td>
                    <td><strong>{journal.description}</strong><small>{journal.typeKey}{journal.reversalOfNumber ? ` · reverses ${journal.reversalOfNumber}` : ""}{journal.reversedByNumber ? ` · reversed by ${journal.reversedByNumber}` : ""}</small></td>
                    <td>{journal.accountPostings?.length ? (
                      <div className={styles.postingList}>
                        {journal.accountPostings.map((posting) => (
                          <div className={styles.posting} key={posting.canonicalKey}>
                            <code title={accountKeyDisplayTitle(posting.displaySegments)}>{posting.displayKey}</code>
                            <dl className={styles.postingAmounts}>
                              <div><dt>Debit</dt><dd>{formatAmount(journal.currency, posting.debitFunctional)}</dd></div>
                              <div><dt>Credit</dt><dd>{formatAmount(journal.currency, posting.creditFunctional)}</dd></div>
                              <div><dt>Ending balance{posting.endingSide === "ZERO" ? "" : ` · ${posting.endingSide.toLowerCase()}`}</dt><dd>{formatAmount(journal.currency, posting.endingBalanceFunctional)}</dd></div>
                            </dl>
                          </div>
                        ))}
                      </div>
                    ) : journal.accountKeys?.length ? journal.accountKeys.map((key) => (
                      <small key={key.canonicalKey}>
                        <code title={accountKeyDisplayTitle(key.displaySegments)}>{key.displayKey}</code>
                      </small>
                    )) : <span className="subtle-label">No lines</span>}</td>
                    <td>{journal.ownerModule}</td>
                    <td className="amount-cell">{formatAmount(journal.currency, journal.debitFunctional ?? journal.amount)}</td>
                    <td className="amount-cell">{formatAmount(journal.currency, journal.creditFunctional ?? journal.amount)}</td>
                    <td><StatusPill status={journal.reversedByNumber ? "REVERSED" : journal.status} /></td>
                    <td>
                      <div className={styles.actions}>
                        <Link className="text-link compact-button" href={`/app/journals/${journal.id}`}>View journal entry</Link>
                        {journal.canPost && journal.expectedContentHash && (
                          <JournalRegisterAction
                            key={`${journal.id}:post`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            journalDescription={journal.description}
                            action={{ kind: "post", expectedContentHash: journal.expectedContentHash }}
                          />
                        )}
                        {journal.canReverse && reversalPeriods.length > 0 && (
                          <JournalRegisterAction
                            key={`${journal.id}:reverse`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            journalDescription={journal.description}
                            action={{ kind: "reverse", periods: reversalPeriods }}
                          />
                        )}
                        {sourceHref && (
                          <Link className="text-link compact-button" href={sourceHref}>Open {journal.ownerModule === "receivables" ? "AR" : "AP"} source</Link>
                        )}
                        {journal.reversedByNumber && <span className="subtle-label">Reversal posted</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <RegisterPaginationNav
            basePath="/app/journals"
            pagination={workspace.pagination}
            parameters={{ q: query || undefined }}
          />
        </section>
      ) : workspace.readiness === "READY" ? (
        <EmptyState title="No journals found">{query ? "Clear the search query or search by journal, description, entity, or type." : "Create the first authorized journal draft for this ledger."}</EmptyState>
      ) : null}
    </div>
  );
}
