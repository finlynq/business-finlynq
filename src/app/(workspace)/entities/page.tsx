import { loadEntitySummaries } from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";
import { SettingsNavigation } from "@/app/_components/route-tabs";

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
      <PageHeader eyebrow="Organization setup" title="Legal entities" description="Active legal entities with their persisted accounting framework, primary ledger, functional currency, and current period state." actions={<Link className="primary-button" href="/app/settings/accounting#legal-entities">＋ Add legal entity</Link>} />
      <SettingsNavigation active="entities" />
      {principal.sessionMode === "demo" && (
        <DemoNotice>
          This is one shared writable demo company. Changes are visible to every demo visitor until the seeded business is restored nightly.
        </DemoNotice>
      )}
      <form className="subledger-toolbar" method="get" aria-label="Find legal entities">
        <label className="full-field"><span>Find an entity</span><input type="search" name="q" defaultValue={query} placeholder="Name, code, country or currency" maxLength={100} /></label>
        <button className="secondary-button" type="submit">Search</button>
        {query && <Link className="text-link" href="/app/entities">Clear search</Link>}
      </form>
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
import Link from "next/link";
export const metadata = { title: "Legal entities" };
