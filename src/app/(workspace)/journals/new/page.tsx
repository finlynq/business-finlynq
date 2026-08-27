import { JournalDraftForm } from "../../../_components/journal-draft-form.client";
import { RealJournalDraftForm } from "../../../_components/real-journal-draft-form.client";
import { loadManualJournalOptions } from "@/modules/ledger/tenant-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import { BackLink, DemoNotice, PageHeader } from "../../../_components/ui";

export default async function NewJournalPage() {
  const principal = await requireWorkspacePrincipal("/app/journals/new");
  if (principalCanWrite(principal)) {
    const options = await loadManualJournalOptions(principal);
    const selectedPeriod = options.entities[0]?.periods[0];
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
          <RealJournalDraftForm options={options} initialAccountingDate={initialAccountingDate} />
        </section>
      </div>
    );
  }
  return (
    <div className="page-content">
      <BackLink href="/app/journals">Back to journals</BackLink>
      <PageHeader eyebrow="General ledger · Manual journal" title="Validate a journal draft" description="Build and balance a local preview. Validation does not create, approve, or post a journal." />
      <DemoNotice>Only <code>ledger.manual</code> belongs here. Invoices and supplier bills must be adjusted in their source modules.</DemoNotice>
      <section className="panel form-panel"><JournalDraftForm /></section>
    </div>
  );
}
