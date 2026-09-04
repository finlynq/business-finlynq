import Link from "next/link";
import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { mutationContext } from "@/modules/workspace/write-policy";
import { configuredProviders } from "@/modules/document-storage/provider";
import { listStorageConnections } from "@/modules/document-storage/connections";
import { listDocumentInbox } from "@/modules/document-storage/inbox";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { DocumentInbox } from "@/app/_components/document-inbox.client";

export const dynamic = "force-dynamic";
export default async function DocumentInboxPage({ searchParams }: { searchParams: Promise<{ storage?: string }> }) {
  const outcome = (await searchParams).storage;
  const principal = await requireWorkspacePrincipal("/app/settings/documents");
  const real = principal.sessionMode === "real";
  const context = mutationContext(principal, randomUUID());
  const data = real ? await Promise.all([
    listStorageConnections(context), listDocumentInbox(context),
    withTenantTransaction(context, async (client) => {
      const entities = (await client.query<{ id: string; display_name: string }>("SELECT id,display_name FROM legal_entities WHERE organization_id=$1 AND active ORDER BY display_name", [principal.organizationId])).rows;
      const permissions = (await client.query<{ admin: boolean; payables: boolean; receivables: boolean }>("SELECT app.current_actor_has_permission('organization.settings.manage') AS admin,app.current_actor_has_permission('payables.manage') AS payables,app.current_actor_has_permission('receivables.manage') AS receivables")).rows[0];
      return { entities, permissions };
    }),
  ]) : null;
  return <main className="page-content">
    <PageHeader eyebrow="Documents" title="Document inbox" description="Drop invoices into your connected drive, then use your AI client to prepare drafts and organize the originals."
      actions={<Link className="secondary-button" href="/app/settings/mcp">AI & MCP connections</Link>} />
    {!real && <DemoNotice>Connect cloud storage from a real organization. The shared demo does not access personal files.</DemoNotice>}
    {data && <DocumentInbox initialOutcome={outcome} initialConnections={data[0]} initialInbox={data[1]} entities={data[2].entities} permissions={data[2].permissions} providers={configuredProviders()} />}
  </main>;
}
