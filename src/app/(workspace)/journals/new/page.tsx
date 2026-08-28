import { RealJournalDraftForm } from "../../../_components/real-journal-draft-form.client";
import { loadManualJournalOptions } from "@/modules/ledger/tenant-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import { BackLink, PageHeader } from "../../../_components/ui";

export default async function NewJournalPage() {
  const principal = await requireWorkspacePrincipal("/app/journals/new");
  const [options, entityContext] = await Promise.all([
    loadManualJournalOptions(principal),
    currentWorkspaceEntityContext(principal),
  ]);
  const selectedEntity = options.entities.find((entity) => (
    entity.id === entityContext.selectedEntity?.id
  )) ?? options.entities[0];
  const selectedPeriod = selectedEntity?.periods[0];
  const today = principal.sessionMode === "demo"
    ? demoAccountingDate()
    : new Date().toISOString().slice(0, 10);
  const initialAccountingDate = selectedPeriod
    ? today < selectedPeriod.startsOn
      ? selectedPeriod.startsOn
      : today > selectedPeriod.endsOn ? selectedPeriod.endsOn : today
    : today;
  return (
    <div className="page-content">
      <BackLink href="/app/journals">Back to journals</BackLink>
      <PageHeader
        eyebrow="General ledger · Manual journal"
        title="Create a manual journal"
        description="Save a balanced journal with exact-decimal amounts. The ledger policy determines whether it remains a draft or auto-posts."
      />
      <section className="panel form-panel">
        <RealJournalDraftForm
          options={options}
          initialAccountingDate={initialAccountingDate}
          initialEntityId={selectedEntity?.id ?? null}
        />
      </section>
    </div>
  );
}
