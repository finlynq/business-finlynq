import { demoDashboard } from "@/modules/demo/dashboard-data";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { TenantModuleUnavailable } from "../../_components/tenant-module-unavailable";
import { DemoNotice, EmptyState, PageHeader, StatusPill } from "../../_components/ui";

export default async function EntitiesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await requireWorkspacePrincipal("/app/entities");
  if (principal.sessionMode !== "demo") return <TenantModuleUnavailable moduleName="Legal entities" />;
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const entities = demoDashboard.entities.filter((entity) => !query || `${entity.code} ${entity.name} ${entity.location}`.toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Organization setup" title="Legal entities" description="Entity, framework, functional currency, ledger, and period state are shown from the read-only demo fixture." />
      <DemoNotice>Configuration changes are intentionally unavailable until authenticated organization setup and encrypted persistence are complete.</DemoNotice>
      {entities.length ? <div className="entity-grid">{entities.map((entity) => (
        <article className="entity-card" key={entity.code}>
          <div className="entity-card-heading"><span className="code-chip">{entity.code}</span><StatusPill status={entity.periodState} /></div>
          <h2>{entity.name}</h2><p>{entity.location}</p>
          <dl className="stacked-details"><div><dt>Accounting profile</dt><dd>{entity.profile}</dd></div><div><dt>Functional currency</dt><dd>{entity.currency}</dd></div><div><dt>Primary ledger period</dt><dd>{entity.period}</dd></div></dl>
        </article>
      ))}</div> : <EmptyState title="No entity found">Try another code or entity name from global search.</EmptyState>}
    </div>
  );
}
