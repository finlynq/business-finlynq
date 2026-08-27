import Link from "next/link";
import { formatMoney } from "@/kernel/money";
import {
  loadAccountingOverview,
  loadEntitySummaries,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

function displayAmount(currency: string, amount: string): string {
  return formatMoney(amount, currency);
}

export default async function OverviewPage() {
  const principal = await requireWorkspacePrincipal("/app");
  const overview = await loadAccountingOverview(principal);
  const entities = overview.access.ledger ? await loadEntitySummaries(principal) : [];
  const metrics = [
    ...(overview.access.receivables ? [{
      label: "Open receivables",
      values: overview.openReceivables.length
        ? overview.openReceivables.map(({ currency, amount }) => displayAmount(currency, amount))
        : ["No open balance"],
      note: "Customer open items, kept separate by transaction currency",
      tone: "blue",
    }] : []),
    ...(overview.access.payables ? [{
      label: "Open payables",
      values: overview.openPayables.length
        ? overview.openPayables.map(({ currency, amount }) => displayAmount(currency, amount))
        : ["No open balance"],
      note: "Supplier open items, kept separate by transaction currency",
      tone: "amber",
    }] : []),
    ...(overview.access.ledger ? [{
      label: "Journal workflow",
      values: [`${overview.postedJournalCount} posted`, `${overview.unpostedJournalCount} unposted`],
      note: "Draft, submitted, and approved journals remain unposted",
      tone: "purple",
    }] : []),
    ...(overview.access.tax ? [{
      label: "Tax review",
      values: [
        `${overview.taxDecisionCount} recorded`,
        `${overview.manualReviewTaxCount} review`,
      ],
      note: overview.manualReviewTaxCount ? "Manual review remains required" : "No tax review exceptions",
      tone: "green",
    }] : []),
  ];

  return (
    <div className="page-content">
      <PageHeader
        eyebrow={`${principal.organizationName} · Overview`}
        title="Accounting overview"
        description="Live balances and workflow counts from your organization ledger and subledgers. Currencies are never combined implicitly."
        actions={overview.access.ledger ? (
          <>
            <Link className="secondary-button" href="/app/reports/trial-balance.csv">Export trial balance</Link>
            <Link className="primary-button" href="/app/journals/new">＋ New journal</Link>
          </>
        ) : undefined}
      />

      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This is your isolated writable sandbox. This browser returns to the same business after logout or session expiry; the seeded setup is restored nightly. <Link href="/signup">Create a permanent business account</Link>.
        </DemoNotice>
      )}

      {overview.access.tax && overview.manualReviewTaxCount > 0 && (
        <section className="attention-banner" aria-labelledby="attention-title">
          <span className="attention-icon" aria-hidden="true">!</span>
          <div>
            <strong id="attention-title">Tax decisions require review</strong>
            <p>Unsupported tax facts are held for review instead of silently defaulting to zero.</p>
          </div>
          <Link href="/app/tax?status=review">Review exceptions <span aria-hidden="true">→</span></Link>
        </section>
      )}

      <section aria-labelledby="position-title">
        <div className="section-heading">
          <div><p className="eyebrow">Position</p><h2 id="position-title">At a glance</h2></div>
          <span className="subtle-label">Persisted tenant data · currencies shown separately</span>
        </div>
        {metrics.length ? <div className="metric-grid">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <span className={`metric-signal signal-${metric.tone}`} aria-hidden="true" />
              <p>{metric.label}</p>
              <div>{metric.values.map((value) => <strong key={value}>{value}</strong>)}</div>
              <span>{metric.note}</span>
            </article>
          ))}
        </div> : (
          <EmptyState title="No accounting summary permissions">
            Ask an organization administrator to assign access to the ledger, receivables, payables, or tax workspace.
          </EmptyState>
        )}
      </section>

      {overview.access.ledger && <section aria-labelledby="entities-title">
        <div className="section-heading">
          <div><p className="eyebrow">Legal entities</p><h2 id="entities-title">Primary ledgers</h2></div>
          <Link className="text-link" href="/app/entities">View entities</Link>
        </div>
        {entities.length ? (
          <div className="entity-grid">
            {entities.map((entity) => (
              <article className="entity-card" key={entity.id}>
                <div className="entity-card-heading">
                  <span className="code-chip">{entity.code}</span>
                  <StatusPill status={entity.periodState ?? "NO PERIOD"} />
                </div>
                <h3>{entity.displayName}</h3>
                <p>{entity.regionCode}, {entity.countryCode} · {entity.accountingProfile.replaceAll("_", " ")}</p>
                <dl className="stacked-details">
                  <div><dt>Primary ledger</dt><dd>{entity.ledgerCode}</dd></div>
                  <div><dt>Functional currency</dt><dd>{entity.functionalCurrency}</dd></div>
                  <div><dt>Current period</dt><dd>{entity.periodLabel ?? "Not configured"}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="No legal entities configured">
            Add an active legal entity and primary ledger to begin accounting.
          </EmptyState>
        )}
      </section>}

      {overview.access.ledger && <div className="dashboard-columns equal-columns">
        <section className="panel" aria-labelledby="journal-workflow-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Immutable ledger</p><h2 id="journal-workflow-title">Journal workflow</h2></div>
            <Link className="text-link" href="/app/journals">View journals</Link>
          </div>
          <div style={{ padding: "18px 20px 0" }}>
            <dl className="detail-grid">
              <div><dt>Posted</dt><dd>{overview.postedJournalCount}</dd></div>
              <div><dt>Awaiting posting</dt><dd>{overview.unpostedJournalCount}</dd></div>
              <div><dt>Total active workflow</dt><dd>{overview.postedJournalCount + overview.unpostedJournalCount}</dd></div>
            </dl>
          </div>
          <p className="panel-note"><strong>Corrections preserve history.</strong> Posted source entries are corrected through their owning module.</p>
        </section>

        <section className="panel" aria-labelledby="period-control-title">
          <div className="panel-heading">
            <div><p className="eyebrow">Period control</p><h2 id="period-control-title">Entity ledger states</h2></div>
            <Link className="text-link" href="/app/controls/period-close">Open controls</Link>
          </div>
          {entities.length ? (
            <ul className="checklist" aria-label="Period state by legal entity">
              {entities.map((entity) => (
                <li key={entity.id}>
                  <span className={entity.periodState === "OPEN" ? "check-open" : "check-done"} aria-hidden="true">·</span>
                  <div><strong>{entity.code} · {entity.periodLabel ?? "No period"}</strong><small>{entity.ledgerCode} · {entity.functionalCurrency}</small></div>
                  <StatusPill status={entity.periodState ?? "NOT CONFIGURED"} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">No primary ledger period is configured.</p>
          )}
        </section>
      </div>}
    </div>
  );
}
