import { demoDashboard } from "@/modules/demo/dashboard-data";

const navigation = [
  ["OV", "Overview", "#overview"],
  ["GL", "General ledger", "#journals"],
  ["AR", "Receivables", "#parties"],
  ["AP", "Payables", "#parties"],
  ["TX", "Tax", "#tax"],
  ["RP", "Reports", "#entities"],
  ["CT", "Controls", "#controls"],
] as const;

function StatusPill({ status }: { status: string }) {
  const tone = status === "POSTED" || status === "APPLIED" ? "success" : "review";
  return <span className={`status-pill status-${tone}`}>{status}</span>;
}

export default function Home() {
  const { organization } = demoDashboard;

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">F</span>
          <div>
            <strong>Finlynq</strong>
            <span>Business</span>
          </div>
        </div>

        <div className="workspace-card">
          <span className="eyebrow">Workspace</span>
          <strong>{organization.name}</strong>
          <span className="demo-chip">{organization.environment}</span>
        </div>

        <nav>
          <p className="nav-label">Workspace</p>
          <ul className="nav-list">
            {navigation.map(([icon, label, href], index) => (
              <li key={label}>
                <a href={href} className={index === 0 ? "active" : undefined}>
                  <span className="nav-icon" aria-hidden="true">{icon}</span>
                  <span>{label}</span>
                  {label === "Controls" && <span className="nav-count">2</span>}
                </a>
              </li>
            ))}
          </ul>

          <p className="nav-label nav-label-spaced">Connections</p>
          <ul className="nav-list">
            <li>
              <a href="#automation">
                <span className="nav-icon" aria-hidden="true">AI</span>
                <span>AI & MCP</span>
                <span className="draft-only">Draft</span>
              </a>
            </li>
          </ul>
        </nav>

        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">HA</div>
          <div>
            <strong>Demo owner</strong>
            <span>Accountant · can post</span>
          </div>
          <button className="icon-button" aria-label="Open account menu">•••</button>
        </div>
      </aside>

      <main id="main-content" className="main-shell">
        <header className="topbar">
          <div>
            <p className="breadcrumb">Northstar Demo Group / Overview</p>
            <h1>Good morning</h1>
            <p className="subtitle">Here’s the accounting position for {organization.currentDate}.</p>
          </div>
          <div className="topbar-actions">
            <button className="search-button" aria-label="Search">
              <span aria-hidden="true">⌕</span>
              <span>Search parties, journals, invoices</span>
              <kbd>⌘ K</kbd>
            </button>
            <button className="secondary-button">Export trial balance</button>
            <button className="primary-button">＋ New journal</button>
          </div>
        </header>

        <div className="content" id="overview">
          <section className="attention-banner" aria-labelledby="attention-title">
            <div className="attention-icon" aria-hidden="true">!</div>
            <div>
              <strong id="attention-title">Two tax decisions need review before close</strong>
              <p>Unknown treatment never defaults to zero. Resolve the source facts or record an approved override.</p>
            </div>
            <a href="#tax">Review exceptions <span aria-hidden="true">→</span></a>
          </section>

          <section aria-labelledby="position-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Position</p>
                <h2 id="position-title">At a glance</h2>
              </div>
              <span className="no-consolidation">Currencies shown separately · no implicit translation</span>
            </div>
            <div className="metric-grid">
              {demoDashboard.metrics.map((metric) => (
                <article className="metric-card" key={metric.label}>
                  <div className={`metric-signal signal-${metric.tone}`} aria-hidden="true" />
                  <p>{metric.label}</p>
                  <div className="metric-values">
                    {metric.values.map((value) => <strong key={value}>{value}</strong>)}
                  </div>
                  <span>{metric.note}</span>
                </article>
              ))}
            </div>
          </section>

          <section id="entities" aria-labelledby="entities-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Legal entities</p>
                <h2 id="entities-title">Primary ledgers</h2>
              </div>
              <button className="text-button">Manage entities</button>
            </div>

            <div className="entity-grid">
              {demoDashboard.entities.map((entity) => (
                <article className="entity-card" key={entity.code}>
                  <div className="entity-card-header">
                    <span className="entity-code">{entity.code}</span>
                    <span className={`period-badge period-${entity.periodTone}`}>
                      <span aria-hidden="true" />{entity.periodState}
                    </span>
                  </div>
                  <h3>{entity.name}</h3>
                  <p>{entity.location} · {entity.profile}</p>
                  <div className="entity-balance">
                    <span>Trial balance</span>
                    <strong>{entity.currency} {entity.trialBalance}</strong>
                  </div>
                  <dl className="entity-details">
                    <div><dt>Open AR</dt><dd>{entity.openReceivables}</dd></div>
                    <div><dt>Open AP</dt><dd>{entity.openPayables}</dd></div>
                    <div><dt>Period</dt><dd>{entity.period}</dd></div>
                  </dl>
                  <div className="close-progress-row">
                    <span>Close readiness</span><strong>{entity.closeProgress}%</strong>
                  </div>
                  <div className="progress-track" aria-label={`${entity.closeProgress}% close readiness`}>
                    <span style={{ width: `${entity.closeProgress}%` }} />
                  </div>
                </article>
              ))}
            </div>
          </section>

          <div className="two-column-grid">
            <section className="panel" id="journals" aria-labelledby="journals-title">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Immutable ledger</p>
                  <h2 id="journals-title">Recent journals</h2>
                </div>
                <button className="text-button">View all</button>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Recent journal activity</caption>
                  <thead>
                    <tr>
                      <th>Journal</th><th>Source / owner</th><th>Amount</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoDashboard.journals.map((journal) => (
                      <tr key={`${journal.entity}-${journal.number}-${journal.source}`}>
                        <td>
                          <strong>{journal.number}</strong>
                          <span>{journal.date} · {journal.entity} · {journal.type}</span>
                        </td>
                        <td>
                          <strong>{journal.source}</strong>
                          <span>{journal.owner} · {journal.typeKey}</span>
                        </td>
                        <td className="amount-cell">{journal.amount}</td>
                        <td><StatusPill status={journal.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="immutability-note">
                <span aria-hidden="true">↺</span>
                <p><strong>Corrections preserve history.</strong> Posted items route back to their owner module and create a full linked reversal or replacement.</p>
              </div>
            </section>

            <section className="panel" id="controls" aria-labelledby="close-title">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Period control</p>
                  <h2 id="close-title">August close</h2>
                </div>
                <span className="days-chip">5 days left</span>
              </div>
              <div className="period-flow" aria-label="Period states">
                {[
                  ["1", "Open", "complete"],
                  ["2", "Adjustment", "current"],
                  ["3", "Hard closed", "future"],
                  ["4", "Sealed", "future"],
                ].map(([step, label, state]) => (
                  <div className={`period-step ${state}`} key={label}>
                    <span>{state === "complete" ? "✓" : step}</span>
                    <strong>{label}</strong>
                  </div>
                ))}
              </div>
              <ul className="checklist">
                {demoDashboard.closeChecklist.map((item) => (
                  <li key={item.label}>
                    <span className={item.done ? "check-done" : "check-open"} aria-hidden="true">
                      {item.done ? "✓" : "·"}
                    </span>
                    <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                  </li>
                ))}
              </ul>
              <div className="control-actions">
                <button className="secondary-button">View close package</button>
                <button className="primary-button">Request hard close</button>
              </div>
              <p className="control-footnote">Hard close requires permission, reason, step-up authentication, and an append-only audit event.</p>
            </section>
          </div>

          <section className="panel account-panel" aria-labelledby="account-title">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Typed account classification</p>
                <h2 id="account-title">Account key preview</h2>
              </div>
              <span className="schema-chip">13 fixed fields · 8 custom slots</span>
            </div>
            <code className="canonical-key">{demoDashboard.accountExample.canonicalKey}</code>
            <div className="segment-grid">
              {demoDashboard.accountExample.segments.map(([label, value]) => (
                <div className={value.includes("Hidden") ? "segment hidden-segment" : "segment"} key={label}>
                  <span>{label}</span><strong>{value}</strong>
                </div>
              ))}
            </div>
            <p className="panel-note">Null stays null in PostgreSQL and renders as reserved <code>0000</code>. Party and address numbers are deliberately outside this key.</p>
          </section>

          <div className="two-column-grid lower-grid">
            <section className="panel" id="parties" aria-labelledby="parties-title">
              <div className="panel-header">
                <div><p className="eyebrow">Unified address book</p><h2 id="parties-title">Parties & roles</h2></div>
                <button className="text-button">Open address book</button>
              </div>
              <ul className="party-list">
                {demoDashboard.parties.map((party) => (
                  <li key={party.party}>
                    <span className="party-avatar" aria-hidden="true">{party.name.slice(0, 2).toUpperCase()}</span>
                    <div className="party-primary">
                      <strong>{party.name}</strong>
                      <span>{party.party} · {party.entity}</span>
                    </div>
                    <div className="role-list">
                      {party.roles.map((role) => <span key={role}>{role}</span>)}
                    </div>
                    <strong className="party-balance">{party.balance}</strong>
                  </li>
                ))}
              </ul>
              <p className="panel-note">One Party may be both customer and supplier; AR and AP remain separate open-item ledgers.</p>
            </section>

            <section className="panel" id="tax" aria-labelledby="tax-title">
              <div className="panel-header">
                <div><p className="eyebrow">Versioned decisions</p><h2 id="tax-title">Tax packs</h2></div>
                <span className="verified-chip">Official rates pinned</span>
              </div>
              <div className="tax-list">
                {demoDashboard.taxDecisions.map((tax) => (
                  <article key={tax.jurisdiction}>
                    <div>
                      <span className="tax-mark" aria-hidden="true">%</span>
                      <div><strong>{tax.jurisdiction}</strong><small>{tax.pack}</small></div>
                    </div>
                    <dl>
                      <div><dt>Rate</dt><dd>{tax.rate}</dd></div>
                      <div><dt>On 100.00</dt><dd>{tax.result}</dd></div>
                    </dl>
                    <p>{tax.note}</p>
                    <StatusPill status={tax.status} />
                  </article>
                ))}
              </div>
            </section>
          </div>

          <section className="automation-panel" id="automation" aria-labelledby="automation-title">
            <div>
              <span className="automation-mark" aria-hidden="true">AI</span>
              <div>
                <p className="eyebrow">Controlled automation</p>
                <h2 id="automation-title">AI can prepare the work—not approve itself</h2>
                <p>MCP v0 reads authorized ledger data and creates idempotent drafts. It cannot post, self-approve, reopen periods, change roles, or delete history.</p>
              </div>
            </div>
            <div className="automation-scopes">
              <span>ledger:read</span><span>open-items:read</span><span>journal-draft:create</span>
            </div>
          </section>
        </div>

        <footer className="app-footer">
          <span>Business Finlynq foundation · AGPL-3.0-or-later</span>
          <span>Demo data · not financial advice</span>
        </footer>
      </main>
    </div>
  );
}
