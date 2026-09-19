import { EmptyState, PageHeader } from "./ui";
import Link from "next/link";

export function TenantModuleUnavailable({ moduleName }: { moduleName: string }) {
  return (
    <div className="page-content">
      <PageHeader eyebrow="Workspace access" title={`${moduleName} access is unavailable`} description="Your current workspace role does not provide access to this module." actions={<Link className="secondary-button" href="/app">Return to overview</Link>} />
      <EmptyState title="Ask your organization administrator">An administrator can review your membership and assign the permissions you need to work with this module.</EmptyState>
    </div>
  );
}
