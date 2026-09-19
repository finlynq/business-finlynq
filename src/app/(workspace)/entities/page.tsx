import { EntityRegister } from "../../_components/entity-register";
import { loadEntitySummaries } from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { DemoNotice, EmptyState, PageHeader } from "../../_components/ui";
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
      {entities.length ? <EntityRegister entities={entities} /> : <EmptyState title="No entity found">Try another code or entity name from global search.</EmptyState>}
    </div>
  );
}
import Link from "next/link";
export const metadata = { title: "Legal entities" };
