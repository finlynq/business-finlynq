import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/_components/ui";
import { PlatformGuidanceEditor } from "@/app/_components/platform-guidance-editor.client";
import { listPlatformGuidanceForAdmin } from "@/modules/agent-guidance/service";
import { platformAdministratorAuthorization } from "@/modules/identity/platform-administration";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function PlatformGuidancePage({ searchParams }: {
  searchParams: Promise<{ path?: string }>;
}) {
  const principal = await requireWorkspacePrincipal("/app/platform/guidance");
  if (!await platformAdministratorAuthorization(principal)) notFound();
  const files = await listPlatformGuidanceForAdmin(principal);
  const requested = (await searchParams).path;
  const selected = requested === "new" ? null
    : files.find((file) => file.path === requested) ?? files.find((file) => file.path === "index.md") ?? files[0] ?? null;
  return <div className="page-content">
    <PageHeader eyebrow="Platform administration" title="Shared agent guidance"
      description="Maintain the standard Markdown files available to every organization. A fresh platform administrator MFA step-up is required to save a version."
      actions={<Link className="secondary-button" href="/app/platform">Platform overview</Link>} />
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Shared library</p><h2>Files</h2></div>
      <Link className="secondary-button" href="/app/platform/guidance?path=new">New file</Link></div>
      <div className="table-shell"><table><thead><tr><th>Path</th><th>Summary</th><th>Version</th></tr></thead><tbody>
        {files.map((file) => <tr key={file.path}><td><Link href={`/app/platform/guidance?path=${encodeURIComponent(file.path)}`}>{file.path}</Link></td>
          <td>{file.summary}</td><td>{file.version}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Plain Markdown</p><h2>{selected?.path ?? "New file"}</h2></div></div>
      <PlatformGuidanceEditor key={selected ? `${selected.path}:${selected.version}` : "new"} file={selected} />
    </section>
  </div>;
}

export const metadata = { title: "Shared agent guidance" };
