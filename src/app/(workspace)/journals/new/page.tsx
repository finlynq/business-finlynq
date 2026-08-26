import { JournalDraftForm } from "../../../_components/journal-draft-form.client";
import { BackLink, DemoNotice, PageHeader } from "../../../_components/ui";

export default function NewJournalPage() {
  return (
    <div className="page-content">
      <BackLink href="/journals">Back to journals</BackLink>
      <PageHeader eyebrow="General ledger · Manual journal" title="Validate a journal draft" description="Build and balance a local preview. Validation does not create, approve, or post a journal." />
      <DemoNotice>Only <code>ledger.manual</code> belongs here. Invoices and supplier bills must be adjusted in their source modules.</DemoNotice>
      <section className="panel form-panel"><JournalDraftForm /></section>
    </div>
  );
}
