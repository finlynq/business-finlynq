"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FiscalPeriodCreationResult } from "@/modules/ledger/accounting-configuration";
import type { PeriodControlWorkspaceDto } from "@/modules/ledger/tenant-workspace";

export function PeriodCreationForm({
  workspace,
  defaultFiscalYear,
}: {
  workspace: PeriodControlWorkspaceDto;
  defaultFiscalYear: number;
}) {
  const router = useRouter();
  const [ledgerId, setLedgerId] = useState(workspace.ledgers[0]?.id ?? "");
  const [fiscalYear, setFiscalYear] = useState(String(defaultFiscalYear));
  const [reason, setReason] = useState("");
  const [otp, setOtp] = useState("");
  const [stepUpReady, setStepUpReady] = useState(workspace.recentStepUp);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // Retain the same key after a lost response or expired MFA; changed commands
  // receive a new key so retries cannot accidentally create a different year.
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [conflicts, setConflicts] = useState<FiscalPeriodCreationResult["conflicts"]>([]);

  const clearResult = () => {
    setMessage(null);
    setConflicts([]);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !workspace.canCreate || !ledgerId) return;
    clearResult();
    const year = Number(fiscalYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2200 || reason.trim().length < 8) {
      setMessage({ kind: "error", text: "Choose a fiscal year from 2000 to 2200 and provide a reason of at least 8 characters." });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (!workspace.demoOnly && !stepUpReady) {
        if (!/^\d{6}$/.test(otp)) {
          setMessage({ kind: "error", text: "Enter your current six-digit authenticator code." });
          return;
        }
        const stepUp = await fetch("/api/auth/mfa/step-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otp }),
        });
        const payload = await stepUp.json().catch(() => ({})) as { error?: string };
        if (!stepUp.ok) throw new Error(payload.error ?? "MFA verification failed.");
        setStepUpReady(true);
        setOtp("");
      }
      const fields = {
        ledgerId,
        fiscalYear: year,
        periodPattern: "MONTHLY" as const,
        initialState: "OPEN" as const,
        reason: reason.trim(),
      };
      const fingerprint = JSON.stringify(fields);
      if (command.current?.fingerprint !== fingerprint) {
        command.current = { fingerprint, key: crypto.randomUUID() };
      }
      const response = await fetch("/api/ledger/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: command.current.key }),
      });
      const payload = await response.json() as FiscalPeriodCreationResult & { error?: string; code?: string };
      if (response.status === 428) {
        setStepUpReady(false);
        setOtp("");
      }
      if (response.status === 409 && payload.accepted === false && Array.isArray(payload.conflicts)) {
        setConflicts(payload.conflicts);
        setMessage({ kind: "error", text: "No periods were created. Existing dates or definitions conflict with this monthly calendar." });
        return;
      }
      if (!response.ok || !payload.accepted) {
        throw new Error(payload.error ?? "Periods could not be created.");
      }
      const { created, existing } = payload.summary;
      setMessage({
        kind: "success",
        text: payload.idempotentReplay
          ? `Request already completed: ${created} created, ${existing} already existing for ${year}.`
          : `${created} periods created; ${existing} already existing for ${year}.`,
      });
      router.refresh();
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "The request could not be completed. You can safely retry it.",
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="panel form-panel" aria-labelledby="add-periods-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Fiscal calendar</p>
          <h2 id="add-periods-title">Add periods</h2>
          <p>Create January–December monthly periods in OPEN state. Matching periods are preserved, including their current states. Conflicting calendars are rejected without creating any periods.</p>
        </div>
      </div>
      {!workspace.canCreate ? (
        <p className="validation-message">Period creation requires an organization with writes enabled and the ledger.period.create permission.</p>
      ) : workspace.ledgers.length === 0 ? (
        <p className="validation-message">No active ledgers are available. <Link href="/app/settings/accounting">Configure a legal entity and ledger first.</Link></p>
      ) : (
        <form className="close-form" onSubmit={(event) => { void create(event); }} aria-label="Add fiscal periods">
          <label>Ledger
            <select value={ledgerId} disabled={busy} onChange={(event) => { setLedgerId(event.target.value); clearResult(); }} required>
              {workspace.ledgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.entityCode} · {ledger.ledgerCode} · {ledger.currency}</option>)}
            </select>
          </label>
          <label>Fiscal year
            <input type="number" min={2000} max={2200} step={1} value={fiscalYear} disabled={busy} onChange={(event) => { setFiscalYear(event.target.value); clearResult(); }} required />
          </label>
          <label>Creation reason
            <textarea value={reason} minLength={8} maxLength={500} disabled={busy} onChange={(event) => { setReason(event.target.value); clearResult(); }} placeholder="Why is this fiscal calendar needed?" required />
          </label>
          {!workspace.demoOnly && !stepUpReady && <label>Authenticator code
            <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} disabled={busy} required />
            <small>Need an authenticator? <Link href="/app/account#mfa-enrollment">Open Account &amp; security</Link>.</small>
          </label>}
          {workspace.demoOnly && <p className="validation-message">These changes affect the shared public demo and are reset nightly.</p>}
          {message && <p role={message.kind === "error" ? "alert" : "status"} className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`}>{message.text}</p>}
          {conflicts.length > 0 && <ul aria-label="Conflicting periods">{conflicts.map((conflict) => (
            <li key={conflict.periodId}>{conflict.label}: {conflict.startsOn} – {conflict.endsOn} ({conflict.rejectionCode === "OVERLAPPING_PERIOD" ? "overlapping dates" : "incompatible definition"})</li>
          ))}</ul>}
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Adding periods…" : "Add periods"}</button>
          </div>
        </form>
      )}
    </section>
  );
}
