"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MutationFeedback } from "@/app/_components/mutation-feedback.client";
import type { JournalWorkflowAction, JournalWorkflowEligibility } from "@/modules/ledger/journal-workflow-eligibility";
import styles from "./journal-register-action.module.css";

const labels: Record<JournalWorkflowAction, string> = {
  submit: "Submit for approval", approve: "Approve journal", post: "Post journal",
  withdraw: "Withdraw submission", reject: "Return for correction",
};
const explanations: Record<JournalWorkflowAction, string> = {
  submit: "This freezes the journal for review. An authorized reviewer can then approve its exact contents.",
  approve: "Approve the frozen journal you reviewed. Posting remains a separate action for an authorized user.",
  post: "Posting assigns a permanent journal number and freezes every line. Corrections require the appropriate audited correction workflow.",
  withdraw: "Return this submission to draft for correction. Existing approval evidence stays in the audit trail and cannot authorize a later version.",
  reject: "Return this submission to its creator for correction. Your decision and reason remain in the audit trail, and the revised journal requires a new review.",
};
const actionsByStatus: Record<string, readonly JournalWorkflowAction[]> = {
  DRAFT: ["submit", "post"], SUBMITTED: ["approve", "post", "withdraw", "reject"], APPROVED: ["post"],
};
const completedStatus: Record<JournalWorkflowAction, string> = {
  submit: "SUBMITTED", approve: "APPROVED", post: "POSTED", withdraw: "DRAFT", reject: "DRAFT",
};

export type JournalWorkflowControlsProps = Readonly<{
  journalId: string;
  journalNumber: string;
  workflow: JournalWorkflowEligibility | null;
}>;

type WorkflowResult = Readonly<{ error?: unknown; code?: unknown; status?: unknown; journalNumber?: unknown; idempotentReplay?: unknown }>;

function WorkflowAction({ journalId, journalNumber, workflow, action }: Omit<JournalWorkflowControlsProps, "workflow"> & { workflow: JournalWorkflowEligibility; action: JournalWorkflowAction }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || completed) return;
    const normalizedReason = reason.trim();
    if (!confirmed || normalizedReason.length < 10 || !workflow.contentHash || !workflow.actions[action].allowed) {
      setMessage({ kind: "error", text: "Confirm the action and provide an audit reason of at least 10 characters." });
      return;
    }
    const recovery = action === "withdraw" || action === "reject";
    const requestKey = recovery ? idempotencyKey || crypto.randomUUID() : undefined;
    if (requestKey) setIdempotencyKey(requestKey);
    const body = {
      expectedContentHash: workflow.contentHash,
      ...(action !== "submit" && workflow.approvalVersion !== null ? { expectedApprovalVersion: workflow.approvalVersion } : {}),
      reason: normalizedReason,
      ...(requestKey ? { idempotencyKey: requestKey } : {}),
    };
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/ledger/journals/${encodeURIComponent(journalId)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as WorkflowResult;
      const replayedRecovery = recovery && result.idempotentReplay === true;
      if (!response.ok || (!replayedRecovery && result.status !== completedStatus[action])
        || (action === "post" && (typeof result.journalNumber !== "number" || result.journalNumber <= 0))) {
        setMessage({ kind: "error", text: typeof result.error === "string" ? result.error : "The journal action could not be completed. Refresh its current state before trying again." });
        if (response.status === 409 || response.status === 403) router.refresh();
        return;
      }
      setCompleted(true);
      setConfirmed(false);
      setIdempotencyKey("");
      setMessage({ kind: "success", text: replayedRecovery && result.status !== "DRAFT"
        ? "This recovery request was already recorded. Current journal details have been refreshed."
        : action === "post"
        ? `Journal ${result.journalNumber} was posted.`
        : action === "submit" ? "Journal submitted for independent review."
          : action === "approve" ? "Journal approved. An authorized user can now post it."
            : "Journal returned to draft. Correct it and submit a new version for review." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "The result is unknown. Retry this unchanged action to check its outcome, or refresh the journal." });
    } finally {
      setBusy(false);
    }
  }

  return <details className={styles.details}>
    <summary className={styles.summary}>{labels[action]}</summary>
    <form className={styles.form} onSubmit={(event) => { void submit(event); }} noValidate aria-label={`${labels[action]} ${journalNumber}`}>
      <p className={styles.warning}>{explanations[action]}</p>
      <label className={styles.field}><span>Audit reason</span><textarea value={reason} rows={3} minLength={10} maxLength={500} disabled={busy || completed} required
        onChange={(event) => { setReason(event.target.value); setIdempotencyKey(""); setConfirmed(false); }} /></label>
      <label className={styles.confirmation}><input type="checkbox" checked={confirmed} disabled={busy || completed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I reviewed this journal and confirm this action and its audit reason.</span></label>
      {message && <MutationFeedback kind={message.kind} message={message.text} onDismiss={() => setMessage(null)} />}
      <button className={`primary-button compact-button ${styles.submit}`} type="submit" disabled={busy || completed || !confirmed || reason.trim().length < 10}>
        {busy ? "Working…" : completed ? "Completed" : `Confirm ${labels[action].toLowerCase()}`}
      </button>
    </form>
  </details>;
}

export function JournalWorkflowControls(props: JournalWorkflowControlsProps) {
  const router = useRouter();
  const { workflow } = props;
  if (!workflow) return <div className={styles.workflow}><p className={styles.workflowReason}>Journal actions are unavailable. Refresh to load the current workflow.</p><button type="button" className="secondary-button compact-button" onClick={() => router.refresh()}>Refresh journal</button></div>;
  const actions = actionsByStatus[workflow.status] ?? [];
  if (!actions.length) return null;
  return <div className={styles.workflow} aria-label="Journal workflow">
    {workflow.independentApprovalRequired && workflow.status !== "APPROVED" && <p className={styles.workflowReason}>
      {workflow.actorIsCreator
        ? "You created this journal. A different user with journal approval permission must review and approve it before posting."
        : "A user with journal approval permission, other than the journal creator, must approve this journal before posting."}
    </p>}
    {actions.map((action) => workflow.actions[action].allowed
      ? <WorkflowAction key={`${action}:${workflow.status}:${workflow.contentHash}:${workflow.approvalVersion}`} {...props} workflow={workflow} action={action} />
      : <p key={action} className={styles.workflowReason} data-reason-code={workflow.actions[action].reasonCode}>
        <strong>{labels[action]}:</strong> {workflow.actions[action].reason ?? "This action is unavailable for the current journal."}
      </p>)}
  </div>;
}
