import Link from "next/link";
import { DemoNotice, PageHeader } from "../../_components/ui";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

const capabilities = [
  { label: "Daily work", description: "Read accounting records, prepare documents and perform permitted workflows with your current role." },
  { label: "Accounting setup", description: "Choose separate access for accounts, entities, parties, currencies and tax mappings." },
  { label: "Write confirmations", description: "Review requested changes or configure direct write access with the required authentication." },
];

export default async function AutomationPage() {
  const principal = await requireWorkspacePrincipal("/app/automation");
  return (
    <div className="page-content">
      <PageHeader eyebrow="Controlled automation" title="AI & MCP access" description="Connect your accounting workspace to a compatible AI client, with separate controls for daily work and setup."
        actions={<><Link className="secondary-button" href="/docs/remote-mcp">Connection guide</Link><Link className="primary-button" href="/app/settings/mcp">Manage AI connections</Link></>} />
      {principal.sessionMode === "demo" && <DemoNotice>External AI connections are disabled in the shared demo. A real organization can manage connections in AI & MCP settings.</DemoNotice>}
      <section className="panel scope-panel" aria-labelledby="automation-access-title">
        <div className="panel-heading"><div><p className="eyebrow">Your connection, your controls</p><h2 id="automation-access-title">Choose what each client can do</h2></div></div>
        <ul>{capabilities.map((capability) => <li key={capability.label}><strong>{capability.label}</strong><span>{capability.description}</span></li>)}</ul>
        <p className="panel-note">Accounting permissions and workflow checks apply to demo and standard accounts. Remote connections are available only to eligible real accounts.</p>
      </section>
      <section className="automation-callout"><span className="automation-mark" aria-hidden="true">AI</span><div><h2>Keep review and accountability visible</h2><p>Connected clients operate within your membership, connection settings and live permissions. Review pending confirmations or disconnect a client in AI & MCP settings.</p></div></section>
    </div>
  );
}
export const metadata = { title: "AI & MCP access" };
