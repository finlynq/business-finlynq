import { RecoveryApprovalForm } from "../../../../../_components/recovery-approval-form.client";
import { PageHeader } from "../../../../../_components/ui";

export default function RecoveryApprovalPage() {
  return (
    <div className="page-content">
      <PageHeader eyebrow="Security · Account recovery" title="Approve account recovery" description="A different recovery administrator must verify this request. Approval requires a fresh TOTP code and is recorded in the immutable authentication log." />
      <section className="panel form-panel" aria-labelledby="recovery-approval-title">
        <div className="panel-heading"><div><p className="eyebrow">Step-up required</p><h2 id="recovery-approval-title">Verify and approve</h2></div></div>
        <RecoveryApprovalForm />
      </section>
    </div>
  );
}
