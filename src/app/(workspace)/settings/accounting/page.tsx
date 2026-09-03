import Link from "next/link";
import { AccountingSettings } from "@/app/_components/accounting-settings.client";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { loadAccountingConfiguration } from "@/modules/ledger/accounting-configuration";
import { loadAccountingHierarchies } from "@/modules/ledger/accounting-hierarchies";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function AccountingSettingsPage() {
  const principal = await requireWorkspacePrincipal("/app/settings/accounting");
  const [configuration, hierarchies] = await Promise.all([
    loadAccountingConfiguration(principal),
    loadAccountingHierarchies(principal),
  ]);
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Accounting administration"
        title="Accounting configuration"
        description="Manage legal entities, account dimensions, currencies, effective-dated exchange rates, and tax-pack capability without rewriting posted history."
        actions={<Link className="secondary-button" href="/app/settings">Organization & members</Link>}
      />
      {principal.sessionMode === "demo" && <DemoNotice>Configuration changes are shared with every demo visitor and return to the seeded setup during the nightly reset.</DemoNotice>}
      <AccountingSettings
        configuration={configuration}
        hierarchies={hierarchies}
        isDemo={principal.sessionMode === "demo"}
      />
    </div>
  );
}
