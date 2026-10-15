import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { listProvisions, provisionWorkspaceOptions } from "@/modules/tax/provision-service";
import { TaxProvisionWorkspace } from "@/app/_components/tax-provision-workspace.client";
import { PageHeader } from "@/app/_components/ui";
export default async function ProvisionPage() { const principal = await requireWorkspacePrincipal("/app/tax/provision"); const [data, options] = await Promise.all([listProvisions(principal), provisionWorkspaceOptions(principal)]); return <div className="page-content"><PageHeader eyebrow="Tax review" title="Current income-tax provision" description="Review assumptions, explain the book-to-tax bridge and generate an exact incremental draft." actions={<a className="secondary-button" href="/app/tax">Tax workspace</a>}/><TaxProvisionWorkspace data={data} options={options} writable={principalCanWrite(principal)}/></div>; }
