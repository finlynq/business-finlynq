"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./journal-register-action.module.css";

type Result = Readonly<{ error?: unknown; status?: unknown; idempotentReplay?: unknown }>;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : fallback;
}

export function JournalAdminAction({
  journalId,
  journalNumber,
  kind,
  requiresMfaStepUp,
}: Readonly<{
  journalId: string;
  journalNumber: string;
  kind: "unpost" | "delete";
  requiresMfaStepUp: boolean;
}>) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [otp, setOtp] = useState("");
  const [needsMfa, setNeedsMfa] = useState(requiresMfaStepUp);
  const [confirmed, setConfirmed] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!confirmed || normalizedReason.length < 10) {
      setMessage({ kind: "error", text: "Confirm the action and provide an audit reason of at least 10 characters." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (needsMfa) {
        if (!/^\d{6}$/.test(otp)) {
          throw new Error("Enter the current six-digit FinLynQ authenticator code.");
        }
        const verification = await fetch("/api/auth/mfa/step-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otp }),
        });
        if (!verification.ok) {
          throw new Error(await errorMessage(verification, "MFA verification failed."));
        }
        setNeedsMfa(false);
        setOtp("");
      }

      const requestKey = idempotencyKey || crypto.randomUUID();
      setIdempotencyKey(requestKey);
      const response = await fetch(
        `/api/ledger/journals/${encodeURIComponent(journalId)}/${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: normalizedReason, idempotencyKey: requestKey }),
        },
      );
      const result = await response.json().catch(() => ({})) as Result;
      const expectedStatus = kind === "unpost" ? "DRAFT" : "DELETED";
      if (!response.ok || result.status !== expectedStatus) {
        if (response.status === 428) setNeedsMfa(true);
        throw new Error(typeof result.error === "string"
          ? result.error
          : `Journal ${journalNumber} could not be ${kind === "unpost" ? "unposted" : "deleted"}.`);
      }
      setConfirmed(false);
      setIdempotencyKey("");
      setMessage({
        kind: "success",
        text: kind === "unpost"
          ? `Journal ${journalNumber} is now a draft. Its former posting number and action remain in the audit trail.`
          : `Journal ${journalNumber} was removed from normal views. Its immutable tombstone and evidence remain in the audit trail.`,
      });
      router.refresh();
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "The journal administration result is unknown. Retry without changing the reason.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.action}>
      <details className={styles.details}>
        <summary className={styles.summary}>{kind === "unpost" ? "Unpost" : "Delete"}</summary>
        <form className={styles.form} onSubmit={(event) => { void submit(event); }} noValidate>
          <p className={styles.warning}>{kind === "unpost"
            ? "This removes the journal from posted balances and returns it to draft. Closed periods, reconciliations, reversals, and source-ledger dependencies block the action."
            : "This removes the journal from normal views but retains its lines and an immutable deletion tombstone for audit."}</p>
          {needsMfa && (
            <label className={styles.field}>
              <span>FinLynQ authenticator code</span>
              <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} required />
            </label>
          )}
          <label className={styles.field}>
            <span>Audit reason</span>
            <textarea value={reason} rows={3} minLength={10} maxLength={500} onChange={(event) => { setReason(event.target.value); setIdempotencyKey(""); }} disabled={busy} required />
          </label>
          <label className={styles.confirmation}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />
            <span>I understand this is an owner accounting control and the action is permanently audited.</span>
          </label>
          {message && <p className={`${styles.feedback} ${message.kind === "success" ? styles.success : styles.error}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
          <button type="submit" className={`primary-button compact-button ${styles.submit}`} disabled={busy || !confirmed}>
            {busy ? "Working…" : needsMfa ? "Verify and continue" : kind === "unpost" ? "Confirm unpost" : "Confirm deletion"}
          </button>
        </form>
      </details>
    </div>
  );
}
