import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
import { loadTenantPartyDirectory } from "@/modules/ledger/tenant-workspace";
import { loadPartyAccountCreationOptions } from "@/modules/parties/party-workspace";
import { PartyCreateForm } from "../../_components/party-create-form.client";
import { DemoNotice, EmptyState, PageHeader } from "../../_components/ui";

export default async function PartiesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login?next=%2Fapp%2Fparties&reason=expired");
  const query = (await searchParams).q?.trim() ?? "";
  const [directory, accountOptions] = await Promise.all([
    loadTenantPartyDirectory(principal, query),
    loadPartyAccountCreationOptions(principal),
  ]);
  return (
    <div className="page-content">
      <PageHeader eyebrow="Unified master data" title="Parties & roles" description="Party names and addresses use organization envelope encryption; exact-name lookup uses a keyed blind index." />
      {directory.demoOnly && <DemoNotice>These are encrypted synthetic records in your isolated writable sandbox. Your changes reset automatically after the session.</DemoNotice>}
      {directory.readiness === "READY" && directory.canManage && (
        <PartyCreateForm accountOptions={accountOptions} />
      )}
      {query && <p className="form-footnote">Encrypted names use exact-match search. Party numbers support prefix search.</p>}
      {directory.readiness === "ENCRYPTION_SETUP_REQUIRED" ? (
        <EmptyState title="Encryption setup is required">Provision the organization data-encryption key before saving or reading party master data.</EmptyState>
      ) : directory.parties.length ? (
        <ul className="party-directory">{directory.parties.map((party) => (
          <li key={party.id}>
            <span className="party-avatar" aria-hidden="true">{party.displayName.slice(0, 2).toUpperCase()}</span>
            <div><h2>{party.displayName}</h2><p>{party.partyNumber}</p><div className="role-list"><span>{party.active ? "Active" : "Inactive"}</span></div></div>
          </li>
        ))}</ul>
      ) : (
        <EmptyState title="No party found">{query ? "Try an exact encrypted name or a party-number prefix." : "Create the first encrypted customer or supplier party."}</EmptyState>
      )}
    </div>
  );
}
