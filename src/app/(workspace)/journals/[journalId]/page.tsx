import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import { loadTenantJournalDetail } from "@/modules/ledger/tenant-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { BackLink, EmptyState, PageHeader, StatusPill } from "../../../_components/ui";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function money(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ journalId: string }>;
}) {
  const { journalId } = await params;
  if (!UUID_PATTERN.test(journalId)) notFound();
  const principal = await requireWorkspacePrincipal(`/app/journals/${journalId}`);
  const journal = await loadTenantJournalDetail(principal, journalId);
  if (!journal) notFound();

  return (
    <div className="page-content">
      <BackLink href="/app/journals">Back to journals</BackLink>
      <PageHeader
        eyebrow={`${journal.entityCode} · ${journal.ledgerCode} · General ledger`}
        title={`Journal ${journal.number}`}
        description="Read-only posting evidence. Source-owned journals must be corrected in their originating module; posted lines are never edited in place."
        actions={journal.sourceHref ? (
          <Link className="primary-button" href={journal.sourceHref}>
            Open {journal.ownerModule === "receivables" ? "AR" : "AP"} source{journal.sourceNumber ? ` ${journal.sourceNumber}` : ""}
          </Link>
        ) : undefined}
      />

      <section className="panel" aria-labelledby="journal-summary-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Journal header</p>
            <h2 id="journal-summary-title">{journal.description}</h2>
          </div>
          <StatusPill status={journal.status} />
        </div>
        <dl className="detail-grid" style={{ padding: "20px" }}>
          <div><dt>Accounting date</dt><dd>{journal.accountingDate}</dd></div>
          <div><dt>Type</dt><dd>{journal.typeLabel}</dd></div>
          <div><dt>Type key</dt><dd><code>{journal.typeKey}</code></dd></div>
          <div><dt>Owner module</dt><dd>{journal.ownerModule}</dd></div>
          <div><dt>Origin / purpose</dt><dd>{journal.origin} · {journal.purpose}</dd></div>
          <div><dt>Posted at</dt><dd>{journal.postedAt ?? "Not posted"}</dd></div>
          <div><dt>Functional debit</dt><dd className="amount-cell">{money(journal.functionalCurrency, journal.debitFunctional)}</dd></div>
          <div><dt>Functional credit</dt><dd className="amount-cell">{money(journal.functionalCurrency, journal.creditFunctional)}</dd></div>
          <div><dt>Source document</dt><dd>{journal.sourceNumber ?? "Manual journal"}</dd></div>
        </dl>
      </section>

      {journal.lines.length ? (
        <section className="panel" aria-labelledby="journal-lines-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Immutable line evidence</p>
              <h2 id="journal-lines-title">Debit and credit detail</h2>
            </div>
            <span className="subtle-label">Functional currency · {journal.functionalCurrency}</span>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label={`Journal ${journal.number} lines; scroll horizontally if needed`}>
            <table>
              <caption className="sr-only">Journal {journal.number} debit and credit lines</caption>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Account</th>
                  <th scope="col">Memo</th>
                  <th scope="col">Transaction debit</th>
                  <th scope="col">Transaction credit</th>
                  <th scope="col">FX provenance</th>
                  <th scope="col">Functional debit</th>
                  <th scope="col">Functional credit</th>
                </tr>
              </thead>
              <tbody>{journal.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.lineNumber}</td>
                  <td><strong>{line.accountCode} · {line.accountName}</strong><small><code title={accountKeyDisplayTitle(line.displaySegments ?? [])}>{line.displayKey ?? line.canonicalKey}</code></small></td>
                  <td>{line.memo ?? <span className="subtle-label">No memo</span>}</td>
                  <td className="amount-cell">{money(line.transactionCurrency, line.debitTransaction)}</td>
                  <td className="amount-cell">{money(line.transactionCurrency, line.creditTransaction)}</td>
                  <td><strong>{line.fxRate}</strong><small>{line.fxRateSource} · {line.fxRateEffectiveAt}</small></td>
                  <td className="amount-cell">{money(journal.functionalCurrency, line.debitFunctional)}</td>
                  <td className="amount-cell">{money(journal.functionalCurrency, line.creditFunctional)}</td>
                </tr>
              ))}</tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={6}>{journal.functionalCurrency} journal total</th>
                  <td className="amount-cell"><strong>{money(journal.functionalCurrency, journal.debitFunctional)}</strong></td>
                  <td className="amount-cell"><strong>{money(journal.functionalCurrency, journal.creditFunctional)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState title="No journal lines">This authorized journal header does not currently contain any lines.</EmptyState>
      )}
    </div>
  );
}
