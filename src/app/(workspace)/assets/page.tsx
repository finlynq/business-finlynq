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
      description="Maintain mapped registers, deterministic straight-line schedules, lifecycle evidence, and balanced journal drafts. Posted schedule journals drive the register-to-GL roll-forward."
    />
    {workspace.isDemo && <DemoNotice>Synthetic asset and prepaid records reset nightly. Journal drafts still follow the normal period and posting controls.</DemoNotice>}
    <AssetWorkspace workspace={workspace} />
  </div>;
}
