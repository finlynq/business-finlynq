import { OrganizationSettings } from "@/app/_components/organization-settings.client";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { loadOrganizationAdministration } from "@/modules/identity/organization-administration";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function SettingsPage() {
  const principal = await requireWorkspacePrincipal("/app/settings");
  const workspace = await loadOrganizationAdministration(principal);

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Business administration"
        title="Organization settings"
        description="Maintain the business profile, invite team members, assign fixed roles, and control active access without deleting identity history."
        actions={<Link className="primary-button" href="/app/settings/accounting">Accounting configuration</Link>}
      />
      {workspace.isDemo && (
        <DemoNotice>
          This page has the same organization and access controls as a standard account, but the demo is shared, all members and invitations are synthetic, email delivery is suppressed, and the seeded company resets nightly.
        </DemoNotice>
      )}
      <OrganizationSettings workspace={workspace} />
    </div>
  );
}
import Link from "next/link";
