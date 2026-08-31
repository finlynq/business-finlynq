import Link from "next/link";
import { demoClosePackages } from "@/modules/demo/dashboard-data";
import { loadPeriodControlWorkspace } from "@/modules/ledger/tenant-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { CloseReadinessForm } from "../../../_components/close-readiness-form.client";
import { PeriodTransitionForm } from "../../../_components/period-transition-form.client";
import { DemoNotice, PageHeader, StatusPill } from "../../../_components/ui";

export default async function PeriodClosePage() {
  const principal = await requireWorkspacePrincipal("/app/controls/period-close");
  // A real organization always reads its own period history. Write activation
  // controls the capabilities in the tenant DTO; it must never substitute
  // synthetic demo records for a disabled organization's accounting history.
  if (principal.sessionMode === "real" || principalCanWrite(principal)) {
    const workspace = await loadPeriodControlWorkspace(principal);
    return (
      <div className="page-content">
        <PageHeader
          eyebrow="Controls · Fiscal periods"
          title="Period controls"
          description="Move periods through controlled close states. Reopening and irreversible sealing require current MFA, permission, a reason, and an optimistic version check."
        />
        <aside className="demo-notice" aria-label="Period control warning">
          <span aria-hidden="true">i</span>
          <p>OPEN moves to ADJUSTMENT ONLY before HARD CLOSED. SEALED is irreversible, and unposted journals block hard close and seal.</p>
        </aside>
        <PeriodTransitionForm workspace={workspace} />
      </div>
    );
  }
  const blockers = demoClosePackages.flatMap((closePackage) => closePackage.blockers.map((blocker) => `${closePackage.entityCode} · ${blocker.label}: ${blocker.detail}`));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Controls · August 2026" title="Period-close package" description="Review readiness evidence and preview the hard-close request requirements. No period state can change in this demo." actions={<Link className="secondary-button" href="/app/tax?status=review">Review tax blockers</Link>} />
      <DemoNotice>Hard close requires permission, a reason, step-up authentication, one locked transaction, and an append-only audit event. None is bypassed by this preview.</DemoNotice>
      <div className="close-layout">
        <div className="close-packages">{demoClosePackages.map((closePackage) => <section className="panel" aria-labelledby={`close-readiness-${closePackage.entityCode}`} key={closePackage.id}>
          <div className="panel-heading"><div><p className="eyebrow">{closePackage.entityCode} · {closePackage.currency} · {closePackage.periodLabel}</p><h2 id={`close-readiness-${closePackage.entityCode}`}>{closePackage.readinessPercent}% ready</h2></div><StatusPill status="BLOCKED" /></div>
          <ol className="period-flow" aria-label={`${closePackage.entityCode} period states`}><li className={closePackage.periodState === "OPEN" ? "current" : "complete"} aria-current={closePackage.periodState === "OPEN" ? "step" : undefined}><span aria-hidden="true">{closePackage.periodState === "OPEN" ? "1" : "✓"}</span><strong>Open</strong></li><li className={closePackage.periodState === "ADJUSTMENT_ONLY" ? "current" : ""} aria-current={closePackage.periodState === "ADJUSTMENT_ONLY" ? "step" : undefined}><span>2</span><strong>Adjustment</strong></li><li><span>3</span><strong>Hard closed</strong></li><li><span>4</span><strong>Sealed</strong></li></ol>
          <ul className="checklist large-checklist">{closePackage.checks.map((item) => <li key={item.key}><span className={item.status === "PASS" ? "check-done" : "check-open"} aria-hidden="true">{item.status === "PASS" ? "✓" : "·"}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><StatusPill status={item.status} /></li>)}</ul>
        </section>)}</div>
        <aside className="panel audit-panel" aria-labelledby="audit-title"><div className="panel-heading"><div><p className="eyebrow">Required controls</p><h2 id="audit-title">What a real request adds</h2></div></div><ul><li>Active <code>period.close</code> permission</li><li>Fresh step-up authentication</li><li>Reason and immutable actor identity</li><li>Locked period row and blocker recheck</li><li>Hash-chained audit and outbox events</li></ul></aside>
      </div>
      <section className="panel form-panel" id="request" aria-labelledby="request-title"><div className="panel-heading"><div><p className="eyebrow">No-side-effect preview</p><h2 id="request-title">Check a hard-close request</h2></div></div><CloseReadinessForm blockers={blockers} /></section>
    </div>
  );
}
