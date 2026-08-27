"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { TenantJournalReversalPeriodDto } from "@/modules/ledger/tenant-workspace";
import styles from "./journal-register-action.module.css";

type PostAction = Readonly<{
  kind: "post";
  expectedContentHash: string;
}>;

type ReverseAction = Readonly<{
  kind: "reverse";
  periods: readonly TenantJournalReversalPeriodDto[];
}>;

export type JournalRegisterActionProps = Readonly<{
  journalId: string;
  journalNumber: string;
  journalDescription: string;
  action: PostAction | ReverseAction;
}>;

type MutationResponse = Readonly<{
  error?: unknown;
  journalNumber?: unknown;
  status?: unknown;
}>;

function reversalDescription(journalNumber: string, description: string): string {
  const prefix = `Reversal of journal ${journalNumber}`;
  const normalized = description.trim();
  return `${prefix}${normalized ? `: ${normalized}` : ""}`.slice(0, 500);
}

export function JournalRegisterAction({
  journalId,
  journalNumber,
  journalDescription,
  action,
}: JournalRegisterActionProps) {
  const router = useRouter();
  const firstPeriod = action.kind === "reverse" ? action.periods[0] : undefined;
  const [periodId, setPeriodId] = useState(firstPeriod?.id ?? "");
  const [accountingDate, setAccountingDate] = useState(firstPeriod?.defaultAccountingDate ?? "");
  const [description, setDescription] = useState(
    action.kind === "reverse" ? reversalDescription(journalNumber, journalDescription) : "",
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  const selectedPeriod = useMemo(
    () => action.kind === "reverse"
      ? action.periods.find((period) => period.id === periodId)
      : undefined,
    [action, periodId],
  );

  const changeReversalCommand = () => {
    setMessage(null);
    setIdempotencyKey("");
  };

  const selectPeriod = (nextPeriodId: string) => {
    if (action.kind !== "reverse") return;
    const nextPeriod = action.periods.find((period) => period.id === nextPeriodId);
    setPeriodId(nextPeriodId);
    setAccountingDate(nextPeriod?.defaultAccountingDate ?? "");
    changeReversalCommand();
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!confirmed) {
      setMessage({ kind: "error", text: "Confirm that you understand this accounting action before continuing." });
      return;
    }

    let endpoint = `/api/ledger/journals/${encodeURIComponent(journalId)}/post`;
    let body: Readonly<Record<string, unknown>> = {
      expectedContentHash: action.kind === "post" ? action.expectedContentHash : undefined,
    };
    if (action.kind === "reverse") {
      const normalizedReason = reason.trim();
      const normalizedDescription = description.trim();
      if (!selectedPeriod || accountingDate < selectedPeriod.startsOn || accountingDate > selectedPeriod.endsOn) {
        setMessage({ kind: "error", text: "Select an allowed reversal period and an accounting date inside it." });
        return;
      }
      if (normalizedReason.length < 10 || !normalizedDescription) {
        setMessage({ kind: "error", text: "Provide a reversal description and an audit reason of at least 10 characters." });
        return;
      }
      const requestKey = idempotencyKey || crypto.randomUUID();
      setIdempotencyKey(requestKey);
      endpoint = `/api/ledger/journals/${encodeURIComponent(journalId)}/reverse`;
      body = {
        periodId: selectedPeriod.id,
        accountingDate,
        description: normalizedDescription,
        reason: normalizedReason,
        idempotencyKey: requestKey,
      };
    }

    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as MutationResponse;
      if (!response.ok || payload.status !== "POSTED" ||
          typeof payload.journalNumber !== "number" || payload.journalNumber <= 0) {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string"
            ? payload.error
            : `The journal could not be ${action.kind === "post" ? "posted" : "reversed"}.`,
        });
        return;
      }
      setConfirmed(false);
      setIdempotencyKey("");
      setMessage({
        kind: "success",
        text: action.kind === "post"
          ? `Journal ${payload.journalNumber} was posted and is now immutable.`
          : `Reversal journal ${payload.journalNumber} was posted and linked to journal ${journalNumber}.`,
      });
      router.refresh();
    } catch {
      setMessage({
        kind: "error",
        text: action.kind === "reverse"
          ? "The result is unknown. Retry the unchanged reversal to reuse its idempotency key."
          : "The posting result is unknown. Refresh the register before retrying this journal.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.action}>
      <details className={styles.details}>
        <summary className={styles.summary}>{action.kind === "post" ? "Post draft" : "Reverse"}</summary>
        <form className={styles.form} onSubmit={submit} noValidate>
          <p className={styles.warning}>
            {action.kind === "post"
              ? "Posting assigns a permanent journal number and freezes every line. Corrections require a linked reversal."
              : "This posts a full opposite journal. The original remains immutable and both records stay in the audit trail."}
          </p>
          {action.kind === "reverse" && (
            <>
              <label className={styles.field}>
                <span>Reversal period</span>
                <select value={periodId} onChange={(event) => selectPeriod(event.target.value)} disabled={busy}>
                  {action.periods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.entityCode} · {period.label} · {period.state.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Accounting date</span>
                <input
                  type="date"
                  value={accountingDate}
                  min={selectedPeriod?.startsOn}
                  max={selectedPeriod?.endsOn}
                  onChange={(event) => { setAccountingDate(event.target.value); changeReversalCommand(); }}
                  disabled={busy}
                  required
                />
              </label>
              <label className={styles.field}>
                <span>Reversal description</span>
                <input
                  value={description}
                  maxLength={500}
                  onChange={(event) => { setDescription(event.target.value); changeReversalCommand(); }}
                  disabled={busy}
                  required
                />
              </label>
              <label className={styles.field}>
                <span>Audit reason</span>
                <textarea
                  value={reason}
                  rows={3}
                  minLength={10}
                  maxLength={500}
                  onChange={(event) => { setReason(event.target.value); changeReversalCommand(); }}
                  disabled={busy}
                  placeholder="Explain why the full reversal is required."
                  required
                />
              </label>
            </>
          )}
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={busy}
            />
            <span>
              I understand there is no delete or in-place edit after this action.
            </span>
          </label>
          {message && (
            <p
              className={`${styles.feedback} ${message.kind === "success" ? styles.success : styles.error}`}
              role={message.kind === "error" ? "alert" : "status"}
            >
              {message.text}
            </p>
          )}
          <button type="submit" className={`primary-button compact-button ${styles.submit}`} disabled={busy || !confirmed}>
            {busy ? "Working…" : action.kind === "post" ? "Confirm posting" : "Post full reversal"}
          </button>
        </form>
      </details>
    </div>
  );
}
