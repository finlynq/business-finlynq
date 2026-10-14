import Link from "next/link";
import { randomUUID } from "node:crypto";
import { JournalWorkflowControls } from "../../../_components/journal-workflow-controls.client";
import { CompactDisclosure } from "../../../_components/compact-disclosure.client";
import { notFound } from "next/navigation";
import { formatMoney } from "@/kernel/money";
import { accountKeyDisplayTitle } from "@/modules/ledger/account-key-display";
import { loadTenantJournalDetail } from "@/modules/ledger/tenant-workspace";
import { listPostedJournalEvidence } from "@/modules/ledger/journal-evidence";
import { mutationContext } from "@/modules/workspace/write-policy";
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
  const evidence = await listPostedJournalEvidence(
    mutationContext(principal, randomUUID(), { reason: "View journal evidence", sourceSurface: "UI" }),
    journalId,
  );

  return (
    <div className="page-content">
      <BackLink href="/app/journals">Back to journals</BackLink>
      <p><Link href={`/app/reports/booking-batches?journalId=${journal.id}`}>Booking review and posting reports</Link></p>
      <PageHeader
        eyebrow={`${journal.entityCode} · ${journal.ledgerCode} · General ledger`}
        title={`Journal ${journal.number}`}
        description="Review journal evidence and complete the actions available to your role. Source-owned journals are corrected in their originating module; posted lines stay immutable."
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
        <dl className="detail-grid summary-details">
          <div><dt>Accounting date</dt><dd>{journal.accountingDate}</dd></div>
          <div><dt>Owner module</dt><dd>{journal.ownerModule}</dd></div>
          <div><dt>Functional debit</dt><dd className="amount-cell">{money(journal.functionalCurrency, journal.debitFunctional)}</dd></div>
          <div><dt>Functional credit</dt><dd className="amount-cell">{money(journal.functionalCurrency, journal.creditFunctional)}</dd></div>
          <div><dt>Source document</dt><dd>{journal.sourceNumber ?? "Manual journal"}</dd></div>
        </dl>
        <CompactDisclosure summary="Additional journal metadata" className="inline-disclosure"><dl className="detail-grid summary-details">          <div><dt>Type</dt><dd>{journal.typeLabel}</dd></div>
          <div><dt>Type key</dt><dd><code>{journal.typeKey}</code></dd></div>
          <div><dt>Origin / purpose</dt><dd>{journal.origin} · {journal.purpose}</dd></div>
          <div><dt>Posted at</dt><dd>{journal.postedAt ?? "Not posted"}</dd></div>
</dl></CompactDisclosure>
      </section>

      <section className="panel" aria-labelledby="journal-evidence-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Supporting documents</p>
            <h2 id="journal-evidence-title">Original evidence</h2>
          </div>
          <span className="subtle-label">Evidence revision {evidence.evidenceRevision}</span>
        </div>
        {evidence.links.length ? (
          <div className="table-scroll" tabIndex={0} aria-label={`Journal ${journal.number} evidence; scroll horizontally if needed`}>
            <table>
              <thead><tr><th scope="col">Document</th><th scope="col">Original date</th><th scope="col">Original total</th><th scope="col">Integrity</th><th scope="col">Action</th></tr></thead>
              <tbody>{evidence.links.map((link) => (
                <tr key={link.linkId}>
                  <td><strong>{link.documentReference}</strong><small>{link.asset.filename}</small></td>
                  <td>{link.documentDate}</td>
                  <td className="amount-cell">{money(link.documentCurrency, link.documentTotal)}</td>
                  <td><span title={link.asset.sha256}>SHA-256 {link.asset.sha256.slice(0, 12)}…</span><small>Scanned {new Date(link.asset.scannedAt).toLocaleDateString("en-CA")}</small></td>
                  <td><a href={link.downloadUrl}>Download original</a></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p>No original documents are linked to this journal yet.</p>}
        {journal.status === "POSTED" && <p className="panel-note">Have an original invoice or receipt to add? Open <Link href="/app/settings/documents">Documents</Link> and link it to this posted journal using your connected assistant. Its accounting entries will stay as posted.</p>}
      </section>

      {!["POSTED", "REVERSED", "DELETED"].includes(journal.status) && (
        <section className="panel" aria-labelledby="journal-workflow-title">
          <div className="panel-heading"><h2 id="journal-workflow-title">Journal workflow</h2></div>
          <JournalWorkflowControls journalId={journal.id} journalNumber={journal.number} workflow={journal.workflow} />
        </section>
      )}

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
export const metadata = { title: "Journal detail" };
