import { JournalDraftForm } from "../../../_components/journal-draft-form.client";
import { RealJournalDraftForm } from "../../../_components/real-journal-draft-form.client";
import { loadManualJournalOptions } from "@/modules/ledger/tenant-workspace";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { BackLink, DemoNotice, PageHeader } from "../../../_components/ui";

export default async function NewJournalPage() {
  const principal = await requireWorkspacePrincipal("/app/journals/new");
  if (principal.sessionMode === "real") {
    const options = await loadManualJournalOptions(principal);
    return (
      <div className="page-content">
        <BackLink href="/app/journals">Back to journals</BackLink>
        <PageHeader
          eyebrow="General ledger · Manual journal"
          title="Create a manual journal"
          description="Save a balanced journal with exact-decimal amounts. The ledger policy determines whether it remains a draft or auto-posts."
        />
        <section className="panel form-panel">
          <RealJournalDraftForm options={options} initialAccountingDate={new Date().toISOString().slice(0, 10)} />
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
