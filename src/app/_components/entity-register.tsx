import type { EntitySummary } from "@/modules/reporting/tenant-reporting";
import { StatusPill } from "./ui";

export function EntityRegister({ entities }: { entities: readonly EntitySummary[] }) {
  return <div className="entity-register">
    <div className="panel table-scroll entity-register-table" tabIndex={0} aria-label="Legal entities and primary ledgers">
      <table><caption className="sr-only">Legal entities, functional currencies and current fiscal periods</caption>
        <thead><tr><th scope="col">Entity</th><th scope="col">Jurisdiction / framework</th><th scope="col">Primary ledger</th><th scope="col">Currency</th><th scope="col">Current period</th><th scope="col">State</th></tr></thead>
        <tbody>{entities.map((entity) => <tr key={entity.id}>
          <td><strong>{entity.code} · {entity.displayName}</strong></td>
          <td>{entity.regionCode}, {entity.countryCode}<small>{entity.accountingProfile.replaceAll("_", " ")}</small></td>
          <td>{entity.ledgerCode}</td><td>{entity.functionalCurrency}</td><td>{entity.periodLabel ?? "Not configured"}</td><td><StatusPill status={entity.periodState ?? "NO PERIOD"} /></td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="entity-register-cards">{entities.map((entity) => <article className="entity-card" key={entity.id}>
      <div className="entity-card-heading"><strong>{entity.code}</strong><StatusPill status={entity.periodState ?? "NO PERIOD"} /></div>
      <h2>{entity.displayName}</h2><p>{entity.regionCode}, {entity.countryCode} · {entity.accountingProfile.replaceAll("_", " ")}</p>
      <dl className="detail-grid stacked-details"><div><dt>Ledger / currency</dt><dd>{entity.ledgerCode} · {entity.functionalCurrency}</dd></div><div><dt>Current period</dt><dd>{entity.periodLabel ?? "Not configured"}</dd></div></dl>
    </article>)}</div>
  </div>;
}
