import Link from "next/link";
import { PageHeader } from "@/app/_components/ui";
import { SettingsNavigation } from "@/app/_components/route-tabs";
import { listGuidanceForPage, readGuidanceForPage, type GuidanceScope } from "@/modules/agent-guidance/service";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function GuidanceSettingsPage({ searchParams }: {
  searchParams: Promise<{ scope?: string; path?: string }>;
}) {
  const principal = await requireWorkspacePrincipal("/app/settings/guidance");
  const files = await listGuidanceForPage(principal);
  const requested = await searchParams;
  const selected = files.find((file) => file.scope === requested.scope && file.path === requested.path)
    ?? files.find((file) => file.scope === "client" && file.path === "index.md")
    ?? files.find((file) => file.scope === "platform" && file.path === "index.md")
    ?? files[0];
  const file = selected
    ? await readGuidanceForPage(principal, selected.scope as GuidanceScope, selected.path)
    : null;

  return <div className="page-content">
    <PageHeader eyebrow="Organization guidance" title="Agent guidance files"
      description="Read the plain Markdown files shared with your Finlynq agent. Client files persist across conversations; the agent can update them through an authorized connection." />
    <SettingsNavigation active="guidance" />
    <section className="panel" aria-labelledby="guidance-files-title">
      <div className="panel-heading"><div><p className="eyebrow">File library</p><h2 id="guidance-files-title">Shared and client files</h2></div></div>
      {files.length ? <div className="table-shell"><table><thead><tr><th>File</th><th>Scope</th><th>Summary</th><th>Version</th></tr></thead>
        <tbody>{files.map((entry) => <tr key={`${entry.scope}:${entry.path}`}>
          <td><Link href={`/app/settings/guidance?scope=${entry.scope}&path=${encodeURIComponent(entry.path)}`}>{entry.path}</Link></td>
          <td>{entry.scope === "platform" ? "Finlynq standard" : "Your organization"}</td><td>{entry.summary}</td><td>{entry.version}</td>
        </tr>)}</tbody></table></div>
        : <p className="panel-note">No guidance files are available yet.</p>}
    </section>
    {file && <section className="panel" aria-labelledby="guidance-file-title">
      <div className="panel-heading"><div><p className="eyebrow">{file.scope === "platform" ? "Finlynq standard" : "Your organization"} · version {file.version}</p>
        <h2 id="guidance-file-title">{file.path}</h2></div>
        <Link className="secondary-button" href={`/api/organization/guidance/file?scope=${file.scope}&path=${encodeURIComponent(file.path)}`} target="_blank">Open plain Markdown</Link>
      </div>
      <p className="panel-note">{file.summary}</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflowX: "auto" }}>{file.content}</pre>
    </section>}
  </div>;
}

export const metadata = { title: "Agent guidance files" };
