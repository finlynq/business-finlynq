import Link from "next/link";
import { demoDashboard } from "@/modules/demo/dashboard-data";
import { PageHeader, StatusPill } from "../../_components/ui";

export default function OverviewPage() {
  return (
    <div className="page-content">
      <PageHeader
        eyebrow={`${demoDashboard.organization.name} · Overview`}
        title="Accounting overview"
        description={`Sample position as of ${demoDashboard.organization.currentDate}. Currencies remain separate and no transactions can be saved.`}
        actions={(
          <>
            <Link className="secondary-button" href="/app/reports/trial-balance.csv">Export trial balance</Link>
            <Link className="primary-button" href="/app/journals/new">＋ New journal</Link>
          </>
        )}
      />

      <section className="attention-banner" aria-labelledby="attention-title">
        <span className="attention-icon" aria-hidden="true">!</span>
        <div>
          <strong id="attention-title">Two tax decisions need review before close</strong>
          <p>Unknown treatment never defaults to zero. Review the demo exceptions before considering period close.</p>
        </div>
        <Link href="/app/tax?status=review">Review exceptions <span aria-hidden="true">→</span></Link>
      </section>

      <section aria-labelledby="position-title">
        <div className="section-heading">
          <div><p className="eyebrow">Position</p><h2 id="position-title">At a glance</h2></div>
          <span className="subtle-label">Currencies shown separately · no implicit translation</span>
        </div>
        <div className="metric-grid">
          {demoDashboard.metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <span className={`metric-signal signal-${metric.tone}`} aria-hidden="true" />
              <p>{metric.label}</p>
              <div>{metric.values.map((value) => <strong key={value}>{value}</strong>)}</div>
              <span>{metric.note}</span>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="entities-title">
        <div className="section-heading">
          <div><p className="eyebrow">Legal entities</p><h2 id="entities-title">Primary ledgers</h2></div>
          <Link className="text-link" href="/app/entities">Manage entities</Link>
        </div>
        <div className="entity-grid">
          {demoDashboard.entities.map((entity) => (
            <article className="entity-card" key={entity.code}>
              <div className="entity-card-heading"><span className="code-chip">{entity.code}</span><StatusPill status={entity.periodState} /></div>
              <h3>{entity.name}</h3>
              <p>{entity.location} · {entity.profile}</p>
              <div className="balance-callout"><span>Trial balance</span><strong>{entity.currency} {entity.trialBalance}</strong></div>
              <dl className="detail-grid">
                <div><dt>Open AR</dt><dd>{entity.openReceivables}</dd></div>
                <div><dt>Open AP</dt><dd>{entity.openPayables}</dd></div>
                <div><dt>Period</dt><dd>{entity.period}</dd></div>
              </dl>
              <div className="progress-label"><span>Close readiness</span><strong>{entity.closeProgress}%</strong></div>
              <div className="progress-track" role="progressbar" aria-label={`${entity.name} close readiness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={entity.closeProgress}>
                <span style={{ width: `${entity.closeProgress}%` }} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="dashboard-columns">
        <section className="panel" aria-labelledby="journals-title">
          <div className="panel-heading"><div><p className="eyebrow">Immutable ledger</p><h2 id="journals-title">Recent journals</h2></div><Link className="text-link" href="/app/journals">View all</Link></div>
          <div className="table-scroll" tabIndex={0} aria-label="Recent journal table; scroll horizontally if needed">
            <table>
              <caption className="sr-only">Recent journal activity</caption>
              <thead><tr><th scope="col">Journal</th><th scope="col">Source / owner</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
              <tbody>{demoDashboard.journals.map((journal) => (
                <tr key={`${journal.entity}-${journal.number}-${journal.source}`}>
                  <td><strong>{journal.number}</strong><small>{journal.date} · {journal.entity} · {journal.type}</small></td>
                  <td><strong>{journal.source}</strong><small>{journal.owner} · {journal.typeKey}</small></td>
                  <td className="amount-cell">{journal.amount}</td>
                  <td><StatusPill status={journal.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="panel-note"><strong>Corrections preserve history.</strong> Posted source entries route back to their owner module.</p>
        </section>

        <section className="panel" aria-labelledby="close-title">
          <div className="panel-heading"><div><p className="eyebrow">Period control</p><h2 id="close-title">August close</h2></div><StatusPill status="BLOCKED" /></div>
          <p className="panel-note">Period state is controlled independently for each legal entity and ledger.</p>
          <ul className="checklist" aria-label="Period state by legal entity">
            {demoDashboard.entities.map((entity) => (
              <li key={entity.code}>
                <span className={entity.periodState === "OPEN" ? "check-open" : "check-done"} aria-hidden="true">{entity.periodState === "OPEN" ? "1" : "2"}</span>
                <div><strong>{entity.code} · {entity.period}</strong><small>{entity.name}</small></div>
                <StatusPill status={entity.periodState} />
              </li>
            ))}
          </ul>
          <ul className="checklist">{demoDashboard.closeChecklist.map((item) => (
            <li key={item.label}><span className={item.done ? "check-done" : "check-open"} aria-hidden="true">{item.done ? "✓" : "·"}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>
          ))}</ul>
          <div className="panel-actions">
            <Link className="secondary-button" href="/app/controls/period-close">View close package</Link>
            <Link className="primary-button" href="/app/controls/period-close#request">Request hard close</Link>
          </div>
        </section>
      </div>

      <section className="panel account-key-panel" aria-labelledby="account-key-title">
        <div className="panel-heading"><div><p className="eyebrow">Typed account classification</p><h2 id="account-key-title">Account key preview</h2></div><span className="code-chip">13 fields · 8 custom slots</span></div>
        <code className="canonical-key">{demoDashboard.accountExample.canonicalKey}</code>
        <div className="segment-grid">{demoDashboard.accountExample.segments.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <p className="panel-note">Null remains null in PostgreSQL and renders as reserved <code>0000</code>. Party and address numbers stay outside this key.</p>
      </section>

      <div className="dashboard-columns equal-columns">
        <section className="panel" aria-labelledby="parties-title">
          <div className="panel-heading"><div><p className="eyebrow">Unified address book</p><h2 id="parties-title">Parties & roles</h2></div><Link className="text-link" href="/app/parties">Open address book</Link></div>
          <ul className="party-list">{demoDashboard.parties.map((party) => (
            <li key={party.party}><span className="party-avatar" aria-hidden="true">{party.name.slice(0, 2).toUpperCase()}</span><div><strong>{party.name}</strong><small>{party.party} · {party.entity}</small></div><span>{party.roles.join(" · ")}</span><strong>{party.balance}</strong></li>
          ))}</ul>
        </section>
        <section className="panel" aria-labelledby="tax-title">
          <div className="panel-heading"><div><p className="eyebrow">Versioned decisions</p><h2 id="tax-title">Tax packs</h2></div><Link className="text-link" href="/app/tax">View tax</Link></div>
          <div className="tax-card-grid">{demoDashboard.taxDecisions.map((tax) => (
            <article key={tax.jurisdiction}><div><strong>{tax.jurisdiction}</strong><small>{tax.pack}</small></div><dl><div><dt>Rate</dt><dd>{tax.rate}</dd></div><div><dt>On 100.00</dt><dd>{tax.result}</dd></div></dl><p>{tax.note}</p><StatusPill status={tax.status} /></article>
          ))}</div>
        </section>
      </div>
    </div>
  );
}
