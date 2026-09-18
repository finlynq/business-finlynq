import Link from "next/link";
import { ExpandableTableRow } from "../../_components/expandable-table-row.client";
import { CompactDisclosure } from "../../_components/compact-disclosure.client";
import { formatMoney } from "@/kernel/money";
import { loadTaxDeterminations } from "@/modules/reporting/tenant-reporting";
import { loadTaxFilingWorkspace } from "@/modules/tax/filing-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TaxFilingWorkspace } from "../../_components/tax-filing-workspace.client";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";
import { RouteTabs } from "@/app/_components/route-tabs";

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

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ status?: string; view?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/tax");
  const parameters = await searchParams;
  const reviewOnly = parameters.status === "review";
  const view = reviewOnly ? "review" : ["history", "templates", "transactions"].includes(parameters.view ?? "") ? parameters.view! : "prepare";
  const [determinations, filingWorkspace] = await Promise.all([
    loadTaxDeterminations(principal, { reviewOnly }),
    loadTaxFilingWorkspace(principal),
  ]);
  const reviewCount = determinations.filter((decision) => requiresReview(decision.status)).length;
  const filingReviewCount = filingWorkspace.filings.filter((filing) => filing.status === "REVIEW_REQUIRED").length;
  const mappedScopes = new Set(filingWorkspace.mappings.map((mapping) => `${mapping.ledgerId}|${mapping.templateId}`)).size;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Tax compliance workspace"
        title={reviewOnly ? "Tax exceptions" : "Tax returns & review"}
        description="Prepare returns, reconcile historical filings and review transaction tax decisions. Choose a workspace below to keep preparation, evidence and setup in focus."
        actions={reviewOnly ? <Link className="secondary-button" href="/app/tax?view=transactions">View all determinations</Link> : undefined}
      />
      <RouteTabs label="Tax workspace views" active={view} tabs={[
        { key: "prepare", label: "Prepare return", href: "/app/tax" },
        { key: "history", label: "Filing history", href: "/app/tax?view=history" },
        { key: "templates", label: "Templates & rules", href: "/app/tax?view=templates" },
        { key: "transactions", label: "Transaction tax", href: "/app/tax?view=transactions" },
        { key: "review", label: "Exceptions", href: "/app/tax?status=review" },
      ]} />
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

      {!reviewOnly && <>
        <dl className="metric-strip" aria-label="Tax filing overview">
          <div><dt>Shared templates</dt><dd>{filingWorkspace.templates.length}</dd></div>
          <div><dt>Mapped client scopes</dt><dd>{mappedScopes}</dd></div>
          <div><dt>Filing workpapers</dt><dd>{filingWorkspace.filings.length}</dd></div>
          <div><dt>Reconciliation review</dt><dd>{filingReviewCount}</dd></div>
        </dl>

        {view === "prepare" && <TaxFilingWorkspace workspace={filingWorkspace} />}

        {view === "templates" && <section className="panel" aria-labelledby="tax-template-rules-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Template-owned controls</p>
              <h2 id="tax-template-rules-title">Fields, formulas and validation rules</h2>
              <p>Rules travel with the template version—not with a client mapping—so every client is evaluated consistently.</p>
            </div>
            <span className="attention-count">{filingWorkspace.templates.reduce((total, template) => total + template.definition.validations.length, 0)}</span>
          </div>
          <div className="tax-card-grid">
            {filingWorkspace.templates.map((template) => <article key={template.id}>
              <div><strong>{template.name}</strong><small>{template.authority} · {template.jurisdiction} · form {template.formCode} · version {template.version}</small></div>
              <dl>
                <div><dt>Fields</dt><dd>{template.definition.fields.length}</dd></div>
                <div><dt>Rules</dt><dd>{template.definition.validations.length}</dd></div>
              </dl>
              <CompactDisclosure summary="Template instructions" className="inline-disclosure"><p>{template.definition.instructions}</p></CompactDisclosure>
              <details className="mapping-details">
                <summary>Review embedded rules</summary>
                <ul className="checklist large-checklist">
                  {template.definition.validations.map((rule) => <li key={rule.key}>
                    <span className="check-open" aria-hidden="true">{rule.type === "PERCENTAGE_RANGE" ? "%" : rule.type === "THRESHOLD" ? "≤" : "✓"}</span>
                    <div><strong>{rule.label}</strong><small>{rule.description}</small></div>
                    <span className="status-pill status-neutral">{rule.severity}</span>
                  </li>)}
                </ul>
              </details>
              <a className="text-link" href={template.sourceUri} target="_blank" rel="noreferrer">Official source <span aria-hidden="true">↗</span></a>
            </article>)}
          </div>
          <p className="panel-note">Shared templates are immutable, reviewed platform artifacts published with a deployment. Client account mappings never change the shared definition.</p>
        </section>}

        {view === "history" && <section className="panel" aria-labelledby="filing-history-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Immutable workpapers</p>
              <h2 id="filing-history-title">Prepared and imported returns</h2>
            </div>
            <span className="attention-count">{filingWorkspace.filings.length}</span>
          </div>
          {filingWorkspace.filings.length ? <div className="table-scroll" tabIndex={0} aria-label="Tax filing workpapers; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Prepared returns and historical filing reconciliations</caption>
              <thead><tr><th>Period / source</th><th>Client scope</th><th>Template</th><th>Result</th><th>Exceptions</th><th>Reconciliation detail</th></tr></thead>
              <tbody>{filingWorkspace.filings.map((filing) => {
                const variances = filing.reconciliation.filter((field) => field.status !== "MATCHED");
                const failedRules = filing.validations.filter((rule) => rule.status === "FAIL");
                const currency = filingWorkspace.templates.find((template) => template.id === filing.templateId)?.currencyCode ?? "CAD";
                return <ExpandableTableRow key={filing.id} columns={6} label={`comparison for ${filing.entityCode} ${filing.periodStart}–${filing.periodEnd}`} cells={<>
                  <td><strong>{filing.periodStart} – {filing.periodEnd}</strong><small>{filing.filingType === "PREPARED" ? "Prepared declaration" : `Historical · ${filing.externalReference ?? "No reference"}`}</small></td>
                  <td><strong>{filing.entityCode}</strong><small>{filing.ledgerCode}</small></td>
                  <td><strong>{filing.templateName}</strong><small>Version {filing.templateVersion}</small></td>
                  <td><StatusPill status={filing.status} /></td>
                  <td><strong>{variances.length} field{variances.length === 1 ? "" : "s"}</strong><small>{failedRules.length} rule exception{failedRules.length === 1 ? "" : "s"}</small></td>
                  </>}>
                      <div className="table-scroll" tabIndex={0} aria-label={`Workpaper comparison for ${filing.entityCode}`}>
                        <table>
                          <thead><tr><th>Line</th><th>System</th><th>Filed</th><th>Difference</th><th>Status</th></tr></thead>
                          <tbody>{filing.reconciliation.map((field) => <tr key={field.fieldKey}>
                            <td><strong>{field.code}</strong><small>{field.label}</small></td>
                            <td className="amount-cell">{formatMoney(field.calculatedValue, currency)}</td>
                            <td className="amount-cell">{field.reportedValue === null ? "—" : formatMoney(field.reportedValue, currency)}</td>
                            <td className="amount-cell">{field.difference === null ? "—" : formatMoney(field.difference, currency)}</td>
                            <td><StatusPill status={field.status} /></td>
                          </tr>)}</tbody>
                        </table>
                      </div>
                </ExpandableTableRow>;
              })}</tbody>
            </table>
          </div> : <EmptyState title="No filing workpapers yet">Prepare a return or load a historical filing after mapping the template’s account-backed fields.</EmptyState>}
          <p className="panel-note">A workpaper records the template version, mapping version, posted-ledger calculation, reported values, differences, and rule outcomes used at that moment. It does not transmit a filing to a tax authority.</p>
        </section>}
      </>}



      {(view === "transactions" || reviewOnly) && <section className="panel" aria-labelledby="tax-determinations-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Transaction tax evidence</p>
            <h2 id="tax-determinations-title">{reviewOnly ? "Manual review required" : "Recorded transaction decisions"}</h2>
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
      </section>}
    </div>
  );
}
export const metadata = { title: "Tax returns & review" };
