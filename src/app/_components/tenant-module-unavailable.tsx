import { EmptyState, PageHeader } from "./ui";

export function TenantModuleUnavailable({ moduleName }: { moduleName: string }) {
  return (
    <div className="page-content">
      <PageHeader eyebrow="Tenant workspace" title={`${moduleName} is not enabled`} description="This module has not yet been connected to organization-scoped persistence for real accounts." />
      <EmptyState title="No shared preview records are shown">The public Northstar fixtures are isolated to demo sessions. Complete this module&apos;s durable workflow before enabling it here.</EmptyState>
    </div>
  );
}
