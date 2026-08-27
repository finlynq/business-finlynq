import { demoDashboard, demoTaxExceptions } from "@/modules/demo/dashboard-data";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TenantModuleUnavailable } from "../../_components/tenant-module-unavailable";
import { DemoNotice, PageHeader, StatusPill } from "../../_components/ui";

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/tax");
  if (principal.sessionMode !== "demo") return <TenantModuleUnavailable moduleName="Tax" />;
  const reviewOnly = (await searchParams).status === "review";
  const appliedTaxDecisions = demoDashboard.taxDecisions.filter((tax) => tax.status === "APPLIED");
  return (
    <div className="page-content">
      <PageHeader eyebrow="Tax decision engine" title={reviewOnly ? "Tax exceptions" : "Tax packs & exceptions"} description="Jurisdiction packs return explicit evidence-backed outcomes; unsupported facts never silently become zero tax." />
      <DemoNotice>Ontario HST and Washington sales-tax examples are reference fixtures, not a filing service. Official-rate ingestion and return reconciliation remain later milestones.</DemoNotice>
      {!reviewOnly && <section aria-labelledby="tax-pack-title"><div className="section-heading"><div><p className="eyebrow">Pinned reference outcomes</p><h2 id="tax-pack-title">Applied tax packs</h2></div></div><div className="tax-card-grid">{appliedTaxDecisions.map((tax) => <article key={tax.jurisdiction}><div><strong>{tax.jurisdiction}</strong><small>{tax.pack}</small></div><dl><div><dt>Rate</dt><dd>{tax.rate}</dd></div><div><dt>On 100.00</dt><dd>{tax.result}</dd></div></dl><p>{tax.note}</p><StatusPill status={tax.status} /></article>)}</div></section>}
      <section className="panel" aria-labelledby="exceptions-title"><div className="panel-heading"><div><p className="eyebrow">Close blockers</p><h2 id="exceptions-title">Manual review required</h2></div><span className="attention-count">{demoTaxExceptions.length}</span></div><ul className="exception-list">{demoTaxExceptions.map((exception) => <li id={`tax-${exception.id}`} key={exception.id}><div><strong>{exception.sourceDocument}</strong><span>{exception.entityCode} · {exception.jurisdiction}</span></div><p>{exception.reviewReason}<small>{exception.packKey} · {exception.packVersion}</small></p><StatusPill status={exception.status} /></li>)}</ul><p className="panel-note">Resolving or overriding these decisions requires an authorized, audited source workflow that is not enabled in the demo.</p></section>
    </div>
  );
}
