import Link from "next/link";
import { formatMoney } from "@/kernel/money";
import { loadTaxDeterminations } from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

function displayAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function requiresReview(status: string): boolean {
  return status.includes("REVIEW");
}

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/tax");
  const reviewOnly = (await searchParams).status === "review";
  const determinations = await loadTaxDeterminations(principal, { reviewOnly });
  const reviewCount = determinations.filter((decision) => requiresReview(decision.status)).length;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Tax decision engine"
        title={reviewOnly ? "Tax exceptions" : "Tax determinations"}
        description="Versioned posted outcomes and immutable draft decisions attached to source documents. Unsupported facts are held for review instead of silently becoming zero tax."
        actions={reviewOnly ? <Link className="secondary-button" href="/app/tax">View all determinations</Link> : undefined}
      />
      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This list reflects the shared writable demo. Transaction and tax changes from every visitor remain visible until the seeded business is restored nightly.
        </DemoNotice>
      )}

      {!reviewOnly && reviewCount > 0 && (
        <section className="attention-banner" aria-labelledby="tax-review-title">
          <span className="attention-icon" aria-hidden="true">!</span>
          <div>
            <strong id="tax-review-title">{reviewCount} tax decision{reviewCount === 1 ? "" : "s"} require review</strong>
            <p>Review the underlying source document before posting or period close.</p>
          </div>
          <Link href="/app/tax?status=review">Show exceptions <span aria-hidden="true">→</span></Link>
        </section>
      )}

      <section className="panel" aria-labelledby="tax-determinations-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Immutable evidence</p>
            <h2 id="tax-determinations-title">{reviewOnly ? "Manual review required" : "Recorded decisions"}</h2>
          </div>
          <span className="attention-count">{determinations.length}</span>
        </div>
        {determinations.length ? (
          <div className="table-scroll" tabIndex={0} aria-label="Tax determination table; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Persisted tax determination snapshots</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Entity / ledger</th>
                  <th scope="col">Jurisdiction / rule</th>
                  <th scope="col">Tax pack</th>
                  <th scope="col">Taxable basis</th>
                  <th scope="col">Tax</th>
                  <th scope="col">Status</th>
                  <th scope="col">Review reason</th>
                </tr>
              </thead>
              <tbody>{determinations.map((decision) => (
                <tr key={decision.id}>
                  <td>
                    <strong>{decision.sourceNumber}</strong>
                    <small>{decision.sourceType.replaceAll("_", " ")} · {decision.sourceStatus} · {displayDate(decision.createdAt)}</small>
                  </td>
                  <td><strong>{decision.entityCode}</strong><small>{decision.ledgerCode} · {decision.currency}</small></td>
                  <td><strong>{decision.jurisdiction}</strong><small>{decision.ruleKey}</small></td>
                  <td><strong>{decision.packKey}</strong><small>Version {decision.packVersion}</small></td>
                  <td className="amount-cell">{displayAmount(decision.currency, decision.taxableBasis)}</td>
                  <td className="amount-cell">{displayAmount(decision.currency, decision.totalTax)}</td>
                  <td><StatusPill status={decision.status} /></td>
                  <td>{decision.reviewReason ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={reviewOnly ? "No tax exceptions" : "No recorded tax decisions"}>
            {reviewOnly
              ? "No current draft decision or posted tax determination requires manual review."
              : "Tax decisions appear here while documents are drafted and after invoices or supplier bills are issued."}
          </EmptyState>
        )}
        <p className="panel-note">Each row preserves the tax-pack version and rule used for the current draft or at posting time. Source corrections create new accounting evidence instead of overwriting posted history.</p>
      </section>
    </div>
  );
}
