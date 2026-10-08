import Link from "next/link";
import { ExpandableTableRow } from "../../_components/expandable-table-row.client";
import { CompactDisclosure } from "../../_components/compact-disclosure.client";
import { redirect } from "next/navigation";
import { formatMoney } from "@/kernel/money";
import { currentPrincipal } from "@/modules/identity/session";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import { loadTenantJournalWorkspace, type TenantJournalDto } from "@/modules/ledger/tenant-workspace";
import { journalFilterParameters, journalFilterText, type JournalFilterSearchParams } from "@/modules/ledger/journal-register-filters";
import { JournalRegisterFilters } from "../../_components/journal-register-filters";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { normalizeRegisterPage } from "@/modules/workspace/register-pagination";
import { JournalRegisterAction } from "../../_components/journal-register-action.client";
import { JournalAdminAction } from "../../_components/journal-admin-action.client";
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

export default async function JournalsPage({ searchParams }: { searchParams: Promise<JournalFilterSearchParams> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login?next=%2Fapp%2Fjournals&reason=expired");
  const parameters = await searchParams;
  const query = journalFilterText(parameters.q).slice(0, 100);
  const page = normalizeRegisterPage(journalFilterText(parameters.page));
  const entityContext = await currentWorkspaceEntityContext(principal);
  const workspace = await loadTenantJournalWorkspace(
    principal,
    query,
    entityContext.selectedEntity?.id ?? null,
    page,
    parameters,
  );
  const filterParameters = journalFilterParameters(workspace.filterState.values, query);
  const hasFilters = Object.values(filterParameters).some(Boolean);
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="General ledger"
        title="Journals"
        description="Find journal entries, review debit and credit totals, and follow each entry back to its source. Open an entry for its full posting detail."
        actions={workspace.canDraft ? <Link className="primary-button" href="/app/journals/new">＋ New journal</Link> : undefined}
      />
      {workspace.demoOnly && <DemoNotice>This is one shared writable demo company. Everyone sees changes until the seeded company is restored nightly.</DemoNotice>}
      <aside className="demo-notice" aria-label="Journal correction ownership">
        <span aria-hidden="true">i</span>
        <p>Manual journals can be posted or fully reversed here when your role permits. AR and AP journals remain immutable in the general ledger and must be corrected in their source module.</p>
      </aside>
      {workspace.readiness === "EMPTY_ORGANIZATION" && (
        <EmptyState title="Accounting setup is not complete">Create a legal entity, primary ledger, fiscal calendar, and chart of accounts before entering journals.</EmptyState>
      )}
      {workspace.readiness === "READY" && (
        <JournalRegisterFilters search={query} state={workspace.filterState} options={workspace.filterOptions} />
      )}
      {workspace.readiness === "READY" && workspace.filterState.errors.length === 0 && (
        <p role="status">{workspace.matchingJournalCount.toLocaleString()} matching journal{workspace.matchingJournalCount === 1 ? "" : "s"}</p>
      )}
      {workspace.journals.length ? (
        <section className="panel" aria-label="Journal register">
          <div className="table-scroll" tabIndex={0}>
            <table className={styles.registerTable}>
              <caption className="sr-only">Journal register</caption>
              <thead><tr><th scope="col">Journal</th><th scope="col">Description</th><th scope="col">Postings</th><th scope="col">Owner</th><th scope="col">Debit</th><th scope="col">Credit</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
              <tbody>{workspace.journals.map((journal) => {
                const sourceHref = sourceModuleHref(journal);
                const reversalPeriods = workspace.reversalPeriods.filter((period) => period.ledgerId === journal.ledgerId);
                return (
                  <ExpandableTableRow key={journal.id} columns={8} label={`account postings for ${journal.number}`} triggerLabel="postings" actionLayoutClassName={styles.actionLine} cells={<>
                    <td><Link className="text-link" href={`/app/journals/${journal.id}`}>#{journal.number}</Link><span className={styles.journalMeta}> · {journal.accountingDate} · {journal.entityCode}</span></td>
                    <td><span className={styles.description} title={`${journal.description} · ${journal.typeKey}`}>{journal.description}</span></td>
                    <td>{journal.accountPostings?.length ?? journal.accountKeys?.length ?? 0}</td>
                    <td>{journal.ownerModule}</td>
                    <td className="amount-cell">{formatAmount(journal.currency, journal.debitFunctional ?? journal.amount)}</td>
                    <td className="amount-cell">{formatAmount(journal.currency, journal.creditFunctional ?? journal.amount)}</td>
                    <td><StatusPill status={journal.reversedByNumber ? "REVERSED" : journal.status} />{journal.reversedByNumber && <span className={styles.reversalMeta} title={`Reversed by journal #${journal.reversedByNumber}`} aria-label={`Reversed by journal #${journal.reversedByNumber}`}>→ #{journal.reversedByNumber}</span>}</td>
                    </>} actions={<div className={styles.actions}>
                        <Link className="text-link compact-button" href={`/app/journals/${journal.id}`} aria-label={`View journal entry #${journal.number}`}>Open</Link>
                        {journal.canPost && journal.expectedContentHash && (
                          <JournalRegisterAction
                            key={`${journal.id}:post:${journal.expectedContentHash}:${journal.expectedApprovalVersion}`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            journalDescription={journal.description}
                            action={{ kind: "post", expectedContentHash: journal.expectedContentHash, expectedApprovalVersion: journal.expectedApprovalVersion ?? undefined }}
                          />
                        )}
                        {(journal.canReverse || journal.canUnpost || journal.canDelete) && <CompactDisclosure summary="Correct" className="inline-disclosure">                        {journal.canReverse && reversalPeriods.length > 0 && (
                          <JournalRegisterAction
                            key={`${journal.id}:reverse`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            journalDescription={journal.description}
                            action={{ kind: "reverse", periods: reversalPeriods }}
                          />
                        )}
                        {journal.canUnpost && (
                          <JournalAdminAction
                            key={`${journal.id}:unpost`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            kind="unpost"
                            requiresMfaStepUp={workspace.requiresMfaStepUp}
                          />
                        )}
                        {journal.canDelete && (
                          <JournalAdminAction
                            key={`${journal.id}:delete`}
                            journalId={journal.id}
                            journalNumber={journal.number}
                            kind="delete"
                            requiresMfaStepUp={workspace.requiresMfaStepUp}
                          />
                        )}
</CompactDisclosure>}
                        {sourceHref && (
                          <Link className="text-link compact-button" href={sourceHref}>{journal.ownerModule === "receivables" ? "AR" : "AP"} source</Link>
                        )}
                      </div>}><div className="posting-evidence">{journal.accountPostings?.length ? (
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
                    )) : <span className="subtle-label">No lines</span>}</div></ExpandableTableRow>
                );
              })}</tbody>
            </table>
          </div>
          <RegisterPaginationNav
            basePath="/app/journals"
            pagination={workspace.pagination}
            parameters={filterParameters}
          />
        </section>
      ) : workspace.readiness === "READY" ? (
        <>
          <EmptyState title={workspace.filterState.errors.length ? "Check the selected filters" : "No journals found"}>
            {workspace.filterState.errors.length ? "Correct the date, amount, or selection errors above to find journals."
              : workspace.pagination.hasPrevious ? "There are no journals on this page. Return to a previous page or change the filters."
              : hasFilters ? "No journals match these filters in the current entity scope. Widen the date or amount range, remove a filter, or clear all filters."
              : "Create the first authorized journal draft for this ledger."}
          </EmptyState>
          <RegisterPaginationNav basePath="/app/journals" pagination={workspace.pagination} parameters={filterParameters} />
        </>
      ) : null}
    </div>
  );
}
export const metadata = { title: "Journals" };
