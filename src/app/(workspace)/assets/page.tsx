import { AssetWorkspace } from "@/app/_components/asset-workspace.client";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { loadAssetWorkspace } from "@/modules/assets/service";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function AssetsPage() {
  const principal = await requireWorkspacePrincipal("/app/assets");
  const workspace = await loadAssetWorkspace(principal);
  return <div className="page-content">
    <PageHeader
      eyebrow="Asset, intangible and prepaid subledgers"
      title="Assets and prepaids"
      description="Track asset costs, remaining balances and recognition schedules. Compare the register with the ledger, then prepare journals for amounts due."
    />
    {workspace.isDemo && <DemoNotice>Synthetic asset and prepaid records reset nightly. Journal drafts still follow the normal period and posting controls.</DemoNotice>}
    <AssetWorkspace workspace={workspace} />
  </div>;
}
export const metadata = { title: "Assets and prepaids" };
