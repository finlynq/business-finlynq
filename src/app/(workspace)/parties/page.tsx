import { redirect } from "next/navigation";
import { currentPrincipal } from "@/modules/identity/session";
import { loadTenantPartyDirectory } from "@/modules/ledger/tenant-workspace";
import { loadPartyAccountCreationOptions } from "@/modules/parties/party-workspace";
import { normalizeRegisterPage } from "@/modules/workspace/register-pagination";
import { PartyAccountAttachForm } from "../../_components/party-account-attach-form.client";
import { PartyCreateForm } from "../../_components/party-create-form.client";
import { RegisterPaginationNav } from "../../_components/register-pagination";
import styles from "../../_components/party-directory.module.css";
import { DemoNotice, EmptyState, PageHeader } from "../../_components/ui";

function addressLine(address: Readonly<{
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}>): string {
  return [
    address.line1,
    address.line2,
    `${address.city}, ${address.region} ${address.postalCode}`,
    address.countryCode,
  ].filter(Boolean).join(" · ");
}

export default async function PartiesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) redirect("/login?next=%2Fapp%2Fparties&reason=expired");
  const parameters = await searchParams;
  const query = parameters.q?.trim() ?? "";
  const page = normalizeRegisterPage(parameters.page);
  const [directory, accountOptions] = await Promise.all([
    loadTenantPartyDirectory(principal, query, page),
    loadPartyAccountCreationOptions(principal),
  ]);
  return (
    <div className="page-content">
      <PageHeader eyebrow="Unified master data" title="Organization address book" description="Create each person or business once for the organization, then attach customer or supplier accounts for every legal entity that trades with it. Party names and addresses remain envelope-encrypted." />
      {directory.demoOnly && <DemoNotice>These are encrypted synthetic records in the shared writable demo. Everyone sees changes until they reset nightly.</DemoNotice>}
      {directory.readiness === "READY" && directory.canManage && (
        <PartyCreateForm />
      )}
      {directory.readiness === "ENCRYPTION_SETUP_REQUIRED" ? (
        <EmptyState title="Encryption setup is required">Provision the organization data-encryption key before saving or reading party master data.</EmptyState>
      ) : (
        <section className={styles.directoryPanel} aria-labelledby="party-directory-title">
          <div className={styles.directoryHeading}>
            <div>
              <p className="eyebrow">Shared across legal entities</p>
              <h2 id="party-directory-title">Party directory</h2>
              <p>{directory.parties.length} organization part{directory.parties.length === 1 ? "y" : "ies"}</p>
            </div>
            <form className={styles.searchForm} method="get">
              <label>
                <span>Party number or exact encrypted name</span>
                <input name="q" defaultValue={query} maxLength={200} placeholder="P-000184 or exact name" />
              </label>
              <button className="secondary-button" type="submit">Search</button>
            </form>
          </div>
          {query && <p className="panel-note">Encrypted names use exact-match search. Party numbers support prefix search.</p>}
          {directory.parties.length ? (
            <>
              <div className="table-scroll" tabIndex={0}>
                <table>
                <caption className="sr-only">Organization parties with legal-entity customer and supplier accounts and encrypted addresses</caption>
                <thead>
                  <tr>
                    <th scope="col">Party</th>
                    <th scope="col">Accounting roles by entity</th>
                    <th scope="col">Addresses</th>
                    <th scope="col">Manage roles</th>
                  </tr>
                </thead>
                <tbody>
                  {directory.parties.map((party) => (
                    <tr key={party.id}>
                      <td className={styles.partyCell}>
                        <div className={styles.partyIdentity}>
                          <span className="party-avatar" aria-hidden="true">{party.displayName.slice(0, 2).toUpperCase()}</span>
                          <div>
                            <strong>{party.displayName}</strong>
                            <small>{party.partyNumber} · {party.active ? "Active" : "Inactive"}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {party.accounts.length ? (
                          <ul className={styles.accountList}>
                            {party.accounts.map((account) => (
                              <li key={account.id}>
                                <span>
                                  <span className={styles.roleBadge}>{account.role === "CUSTOMER" ? "Customer" : "Supplier"}</span>
                                  <span className={styles.accountNumber}>{account.accountNumber}</span>
                                </span>
                                <span className={styles.accountMeta}>
                                  {account.entityCode} · {account.entityName} · {account.transactionCurrency ?? "Any currency"} · control {account.controlAccountCode}
                                  {!account.active && " · Inactive"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : <span className={styles.emptyValue}>No legal-entity roles</span>}
                      </td>
                      <td>
                        {party.addresses.length ? (
                          <ul className={styles.addressList}>
                            {party.addresses.map((address) => (
                              <li key={address.id}>
                                <strong>{address.kind.replaceAll("_", " ")}</strong>
                                <span className={styles.addressMeta}>{addressLine(address)}</span>
                                <span className={styles.addressMeta}>Valid from {address.validFrom}{address.validTo ? ` through ${address.validTo}` : ""}</span>
                              </li>
                            ))}
                          </ul>
                        ) : <span className={styles.emptyValue}>No address recorded</span>}
                      </td>
                      <td>
                        {directory.canManage ? (
                          <details className={styles.attachDetails}>
                            <summary>Add customer / supplier accounting role</summary>
                            <PartyAccountAttachForm
                              partyId={party.id}
                              partyName={party.displayName}
                              accountOptions={accountOptions}
                            />
                          </details>
                        ) : <span className={styles.emptyValue}>Read only</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
              <RegisterPaginationNav
                basePath="/app/parties"
                pagination={directory.pagination}
                parameters={{ q: query || undefined }}
              />
            </>
          ) : (
            <EmptyState title="No party found">{query ? "Try an exact encrypted name or a party-number prefix." : "Create the first encrypted customer or supplier party."}</EmptyState>
          )}
        </section>
      )}
    </div>
  );
}
