import { loadEntitySummaries } from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

export default async function EntitiesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/entities");
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const entities = (await loadEntitySummaries(principal)).filter((entity) => !query || [
    entity.code,
    entity.displayName,
    entity.countryCode,
    entity.regionCode,
    entity.accountingProfile,
    entity.ledgerCode,
    entity.functionalCurrency,
  ].join(" ").toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Organization setup" title="Legal entities" description="Active legal entities with their persisted accounting framework, primary ledger, functional currency, and current period state." />
      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This is your isolated writable sandbox. Transaction changes persist for this browser until the seeded business is restored nightly.
        </DemoNotice>
      )}
      {entities.length ? <div className="entity-grid">{entities.map((entity) => (
        <article className="entity-card" key={entity.id}>
          <div className="entity-card-heading"><span className="code-chip">{entity.code}</span><StatusPill status={entity.periodState ?? "NO PERIOD"} /></div>
          <h2>{entity.displayName}</h2><p>{entity.regionCode}, {entity.countryCode}</p>
          <dl className="stacked-details">
            <div><dt>Accounting profile</dt><dd>{entity.accountingProfile.replaceAll("_", " ")}</dd></div>
            <div><dt>Primary ledger</dt><dd>{entity.ledgerCode}</dd></div>
            <div><dt>Functional currency</dt><dd>{entity.functionalCurrency}</dd></div>
            <div><dt>Current period</dt><dd>{entity.periodLabel ?? "Not configured"}</dd></div>
          </dl>
        </article>
      ))}</div> : <EmptyState title="No entity found">Try another code or entity name from global search.</EmptyState>}
    </div>
  );
}
