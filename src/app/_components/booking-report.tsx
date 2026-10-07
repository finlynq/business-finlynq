import Link from "next/link";
import type { BookingReport } from "@/modules/booking-reports/service";
import { BookingReportPrint } from "./booking-report-print.client";
import styles from "./booking-report.module.css";
export const bookingStatusLabel=(status:string)=>status==="POSTED"?"Posted":status==="PARTIALLY_POSTED"?"Partially posted":"Draft";
export function BookingReportView({report}:{report:BookingReport}) {
  const {snapshot}=report,{summary}=snapshot;
  return <div className={styles.report}>
    <div className={styles.actions}><BookingReportPrint/><a className="secondary-button" href={`/app/reports/booking-batches/${report.batchId}/export?reportId=${report.reportId}`}>Download CSV</a><Link href={`/app/reports/booking-batches/${report.batchId}`}>Latest report</Link><Link href="/app/reports/booking-batches">All booking reports</Link></div>
    <section className={styles.summary} aria-label="Batch summary">
      <h2>{snapshot.company} · {bookingStatusLabel(report.status)}</h2>
      <p>{snapshot.phase==="REVIEW"?"Draft review — reading or sharing this report does not approve or post entries.":"Posting outcome — posted amounts below come from actual journal lines."}</p>
      <p>Generated {new Date(snapshot.generatedAt).toISOString()} · Version {report.version} · Periods: {[...new Set(snapshot.entries.map((entry)=>entry.period))].join(", ")}</p>
      <dl><div><dt>Bills and invoices</dt><dd>{summary.counts.bills}</dd></div><div><dt>Settlements</dt><dd>{summary.counts.settlements}</dd></div><div><dt>Manual journals</dt><dd>{summary.counts.manualJournals}</dd></div><div><dt>Posted entries</dt><dd>{summary.counts.posted}</dd></div><div><dt>Unposted or deferred</dt><dd>{summary.counts.held}</dd></div></dl>
      <div className={styles.table}><table><caption>Invoice value and amounts still owed, by original currency</caption><thead><tr><th>Currency</th><th>Net</th><th>Tax</th><th>Invoice total</th><th>Still owed on posted invoices</th></tr></thead><tbody>{Object.entries(summary.invoiceCurrencies).map(([currency,total])=><tr key={currency}><th>{currency}</th><td>{total.net}</td><td>{total.tax}</td><td>{total.gross}</td><td>{total.outstanding}</td></tr>)}</tbody></table></div>
      <p>Posted invoice recognition: {snapshot.entries[0]?.functionalCurrency} {summary.recognizedFunctional}. This is invoice value, independent of later payment.</p>
      <p>Selected entries: debits {summary.debitFunctional} · credits {summary.creditFunctional}. Posted entries: debits {summary.postedDebitFunctional} · credits {summary.postedCreditFunctional} ({snapshot.entries[0]?.functionalCurrency}).</p>
      {snapshot.reviewReportId&&<p><Link href={`/app/reports/booking-batches/${report.batchId}?reportId=${snapshot.reviewReportId}`}>Original draft review</Link></p>}
      {report.completeness!=="COMPLETE"&&<p className={styles.notice}>{report.completeness==="STALE"?"Entries changed since selection. Review the differences below; the earlier review does not approve changed entries.":"Some entries or reconciliations need attention."}</p>}
    </section>
    {(summary.exceptions.length>0||snapshot.heldItems.length>0)&&<section className={styles.summary} aria-label="Exceptions and held items"><h2>Exceptions and held items</h2><ul>{summary.exceptions.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
    {summary.clearing.length>0&&<section className={styles.summary}><h2>Clearing reconciliation</h2><ul>{summary.clearing.map((item,index)=><li key={index}>{item.group} · {item.account}: {item.net} {snapshot.entries[0]?.functionalCurrency} · {item.balanced?"Reconciled":"Unmatched — review required"}</li>)}</ul><p>These checks cover the selected entries in each declared group.</p></section>}
    {snapshot.entries.map((entry,index)=><article key={`${entry.id}:${index}`} className={styles.entry}>
      <h2>{entry.selected.group&&`${entry.selected.group} · `}{entry.sourceNumber}</h2>
      <p>{entry.party} · {entry.documentDate} · {entry.period} · {entry.linesArePosted?"Posted":"Draft / held"}{entry.journalNumber?` · Journal ${entry.journalNumber}`:""}</p><p>{entry.description}</p>
      {entry.gross!==null&&<p>Invoice {entry.currency} {entry.gross} · Tax {entry.tax} · Functional value {entry.functionalCurrency} {entry.grossFunctional} · Still owed {entry.outstanding===null?"Not posted":`${entry.currency} ${entry.outstanding}`}</p>}
      {entry.heldReason&&<p className={styles.notice}>{entry.heldReason}</p>}{entry.differences.map((difference)=><p className={styles.notice} key={difference}>{difference}</p>)}
      {entry.treatments.map((treatment)=><p key={treatment}>{treatment}</p>)}
      <div className={styles.table}><table><caption>{entry.linesArePosted?"Actual posted journal lines":"Draft accounting review"} · {entry.functionalCurrency} functional currency</caption><thead><tr><th>Account</th><th>Original debit / credit</th><th>Functional debit</th><th>Functional credit</th><th>FX evidence</th></tr></thead><tbody>{entry.lines.map((line,lineIndex)=><tr key={lineIndex}><td><strong>{line.accountCode} · {line.accountName}</strong><small>{line.memo}</small></td><td className={styles.amount}>{line.currency} {line.debit} / {line.credit}</td><td className={styles.amount}>{line.debitFunctional}</td><td className={styles.amount}>{line.creditFunctional}</td><td>{line.fxRate}<small>{line.fxSource} · {line.fxDate}</small></td></tr>)}</tbody></table></div>
      {entry.taxDetails.length>0&&<><h3>Tax and source rounding</h3><ul>{entry.taxDetails.map((tax,taxIndex)=><li key={taxIndex}>{tax.description}: net {tax.net}, tax {tax.tax} {entry.currency}. {tax.treatment.replaceAll("_"," ").toLowerCase()}. Source adjustment {tax.rounding}.{tax.reason&&` ${tax.reason}`}{tax.evidence&&` Evidence: ${tax.evidence}`}</li>)}</ul></>}
      <h3>Supporting evidence</h3>{entry.attachments.length?<ul>{entry.attachments.map((attachment)=><li key={attachment.assetId}><a href={`${attachment.downloadUrl}&disposition=inline`} target="_blank" rel="noopener noreferrer">{attachment.filename}</a> · {attachment.purpose} · <a href={attachment.downloadUrl}>Download</a></li>)}</ul>:<p>No attachment available for this source version.</p>}
      <p>{entry.journalId&&<Link href={`/app/journals/${entry.journalId}`}>Open journal</Link>}{entry.sourceType&&<> · <Link href={`/app/${entry.sourceType.startsWith("payables.")?"payables/bills":"receivables/invoices"}?q=${encodeURIComponent(entry.sourceNumber)}`}>Open source register</Link></>}</p>
      <details className={styles.audit}><summary>Audit details</summary><p>Source version {entry.version} · {entry.id} · Hash {entry.contentHash}</p><pre>{JSON.stringify(entry.approvalContext,null,2)}</pre></details>
    </article>)}
    <details className={styles.audit}><summary>Report audit details</summary><p>Batch {report.batchId} · Report {report.reportId} · Hash {report.hash}</p><p>Generated by {snapshot.generatedBy} · Request {snapshot.requestId} · {snapshot.reason}</p></details>
  </div>;
}
