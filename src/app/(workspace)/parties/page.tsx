import { demoDashboard } from "@/modules/demo/dashboard-data";
import { DemoNotice, EmptyState, PageHeader } from "../../_components/ui";

export default async function PartiesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim().toLocaleLowerCase() ?? "";
  const parties = demoDashboard.parties.filter((party) => !query || `${party.party} ${party.name} ${party.roles.join(" ")} ${party.entity}`.toLocaleLowerCase().includes(query));
  return (
    <div className="page-content">
      <PageHeader eyebrow="Unified master data" title="Parties & roles" description="A party can hold independent customer, supplier, and intercompany relationships without entering the chart-of-account key." />
      <DemoNotice>Names shown here are sample data. Production names, addresses, tax IDs, and bank details require organization envelope encryption and blind-index search.</DemoNotice>
      {parties.length ? <ul className="party-directory">{parties.map((party) => <li key={party.party}><span className="party-avatar" aria-hidden="true">{party.name.slice(0, 2).toUpperCase()}</span><div><h2>{party.name}</h2><p>{party.party} · {party.entity}</p><div className="role-list">{party.roles.map((role) => <span key={role}>{role}</span>)}</div></div><strong>{party.balance}</strong></li>)}</ul> : <EmptyState title="No party found">Try another party, customer, supplier, or intercompany number.</EmptyState>}
    </div>
  );
}
