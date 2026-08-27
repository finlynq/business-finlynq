"use client";

import { useMemo, useState } from "react";
import type { PeriodControlWorkspaceDto } from "@/modules/ledger/tenant-workspace";

type Period = PeriodControlWorkspaceDto["periods"][number];
type PeriodState = Period["state"];

function targets(period: Period, permissions: Pick<PeriodControlWorkspaceDto, "canClose" | "canReopen" | "canSeal">): PeriodState[] {
  if (period.state === "OPEN") return permissions.canClose ? ["ADJUSTMENT_ONLY"] : [];
  if (period.state === "ADJUSTMENT_ONLY") {
    return [
      ...(permissions.canClose ? ["HARD_CLOSED" as const] : []),
      ...(permissions.canReopen ? ["OPEN" as const] : []),
    ];
  }
  if (period.state === "HARD_CLOSED") {
    return [
      ...(permissions.canReopen ? ["ADJUSTMENT_ONLY" as const, "OPEN" as const] : []),
      ...(permissions.canSeal ? ["SEALED" as const] : []),
    ];
  }
  return [];
}

function privilegedTransition(fromState: PeriodState, toState: PeriodState): boolean {
  return toState === "SEALED" || toState === "OPEN" ||
    (fromState === "HARD_CLOSED" && toState === "ADJUSTMENT_ONLY");
}

export function PeriodTransitionForm({ workspace }: { workspace: PeriodControlWorkspaceDto }) {
  const [periods, setPeriods] = useState<Period[]>([...workspace.periods]);
  const [selectedId, setSelectedId] = useState(workspace.periods[0]?.id ?? "");
  const selected = periods.find((period) => period.id === selectedId);
  const availableTargets = useMemo(
    () => selected ? targets(selected, workspace) : [],
    [selected, workspace],
  );
  const [toState, setToState] = useState<PeriodState | "">(
    workspace.periods[0] ? targets(workspace.periods[0], workspace)[0] ?? "" : "",
  );
  const [reason, setReason] = useState("");
  const [otp, setOtp] = useState("");
  const [demoConfirmed, setDemoConfirmed] = useState(false);
  const [stepUpReady, setStepUpReady] = useState(workspace.recentStepUp);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  const changeCommand = () => {
    setMessage(null);
    setIdempotencyKey("");
  };
  const selectPeriod = (periodId: string) => {
    const period = periods.find((candidate) => candidate.id === periodId);
    setSelectedId(periodId);
    setToState(period ? targets(period, workspace)[0] ?? "" : "");
    setReason("");
    setOtp("");
    setDemoConfirmed(false);
    changeCommand();
  };
  const needsStepUp = Boolean(selected && toState && privilegedTransition(selected.state, toState));
  const blockedByDrafts = Boolean(selected && (toState === "HARD_CLOSED" || toState === "SEALED") && selected.unpostedJournalCount > 0);

  const transition = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!selected || !toState || reason.trim().length < 20) {
      setMessage({ kind: "error", text: "Select a permitted transition and provide a reason of at least 20 characters." });
      return;
    }
    if (blockedByDrafts) {
      setMessage({ kind: "error", text: "Resolve or move every unposted journal before hard close or seal." });
      return;
    }
    setBusy(true);
    try {
      if (needsStepUp && !stepUpReady) {
        if (workspace.demoOnly && !demoConfirmed) {
          setMessage({ kind: "error", text: "Confirm that this privileged action is only a nightly-reset sandbox simulation." });
          return;
        }
        if (!workspace.demoOnly && !/^\d{6}$/.test(otp)) {
          setMessage({ kind: "error", text: "Enter the current six-digit authenticator code for this privileged transition." });
          return;
        }
        const stepUpResponse = await fetch(workspace.demoOnly ? "/api/auth/demo-step-up" : "/api/auth/mfa/step-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workspace.demoOnly ? { confirmed: true } : { otp }),
        });
        const stepUpPayload = await stepUpResponse.json().catch(() => ({})) as { error?: unknown };
        if (!stepUpResponse.ok) {
          setMessage({
            kind: "error",
            text: typeof stepUpPayload.error === "string" ? stepUpPayload.error : "Privileged confirmation could not be completed.",
          });
          return;
        }
        setStepUpReady(true);
      }

      const requestKey = idempotencyKey || crypto.randomUUID();
      setIdempotencyKey(requestKey);
      const response = await fetch(`/api/ledger/periods/${selected.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: selected.version,
          toState,
          reason: reason.trim(),
          idempotencyKey: requestKey,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: unknown;
        state?: PeriodState;
        version?: number;
      };
      if (!response.ok || !payload.state || typeof payload.version !== "number") {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string" ? payload.error : "The period could not be changed.",
        });
        return;
      }
      const updated: Period = { ...selected, state: payload.state, version: payload.version };
      setPeriods((current) => current.map((period) => period.id === updated.id ? updated : period));
      const nextTargets = targets(updated, workspace);
      setToState(nextTargets[0] ?? "");
      setReason("");
      setOtp("");
      setDemoConfirmed(false);
      setIdempotencyKey("");
      setMessage({ kind: "success", text: `${updated.entityCode} ${updated.label} is now ${updated.state.replace("_", " ")}.` });
    } catch {
      setMessage({ kind: "error", text: "The result is unknown. Retry the unchanged request to reuse its idempotency key." });
    } finally {
      setBusy(false);
    }
  };

  if (periods.length === 0) {
    return <p className="validation-message validation-error" role="alert">No fiscal periods are configured for an active primary ledger.</p>;
  }

  return (
    <div className="close-layout">
      <section className="panel" aria-labelledby="period-list-title">
        <div className="panel-heading"><div><p className="eyebrow">Tenant ledger periods</p><h2 id="period-list-title">Period states</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Entity</th><th>Period</th><th>Dates</th><th>State</th><th>Unposted</th></tr></thead>
            <tbody>{periods.map((period) => (
              <tr key={period.id}>
                <td><strong>{period.entityCode}</strong><small>{period.ledgerCode} · {period.currency}</small></td>
                <td>{period.label}</td>
                <td>{period.startsOn} – {period.endsOn}</td>
                <td><span className={`status-pill ${period.state === "OPEN" ? "status-success" : period.state === "ADJUSTMENT_ONLY" ? "status-warning" : "status-neutral"}`}>{period.state.replace("_", " ")}</span></td>
                <td>{period.unpostedJournalCount}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel form-panel" aria-labelledby="transition-title">
        <div className="panel-heading"><div><p className="eyebrow">Controlled transition</p><h2 id="transition-title">Change a period state</h2></div></div>
        <form className="close-form" onSubmit={transition} noValidate>
          <label>
            <span>Fiscal period</span>
            <select value={selectedId} onChange={(event) => selectPeriod(event.target.value)} disabled={busy}>
              {periods.map((period) => <option key={period.id} value={period.id}>{period.entityCode} · {period.label} · {period.state.replace("_", " ")}</option>)}
            </select>
          </label>
          <label>
            <span>New state</span>
            <select value={toState} onChange={(event) => { setToState(event.target.value as PeriodState); setOtp(""); setDemoConfirmed(false); changeCommand(); }} disabled={busy || availableTargets.length === 0}>
              {availableTargets.length === 0 && <option value="">No permitted transition</option>}
              {availableTargets.map((state) => <option key={state} value={state}>{state.replace("_", " ")}</option>)}
            </select>
          </label>
          <label>
            <span>Audit reason</span>
            <textarea value={reason} onChange={(event) => { setReason(event.target.value); changeCommand(); }} rows={4} minLength={20} maxLength={500} disabled={busy} placeholder="Explain why this controlled state change is required." />
          </label>
          {needsStepUp && !stepUpReady && (
            workspace.demoOnly ? (
              <label className="checkbox-field">
                <input type="checkbox" checked={demoConfirmed} onChange={(event) => setDemoConfirmed(event.target.checked)} disabled={busy} />
                <span>This simulates privileged confirmation only inside my disposable sandbox. It is not real MFA.</span>
              </label>
            ) : (
              <label>
                <span>Authenticator code</span>
                <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} disabled={busy} />
                <small>Reopening and irreversible sealing require a current MFA step-up.</small>
              </label>
            )
          )}
          {selected?.state === "SEALED" && <p className="validation-message validation-error">A sealed period is immutable and cannot be reopened by the application.</p>}
          {blockedByDrafts && <p className="validation-message validation-error">{selected?.unpostedJournalCount} unposted journal{selected?.unpostedJournalCount === 1 ? "" : "s"} must be resolved first.</p>}
          {toState === "SEALED" && <p className="validation-message validation-error"><strong>Irreversible action.</strong> Sealing permanently prevents application reopening.</p>}
          {message && <p className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
          <div className="form-actions">
            <button type="submit" className="primary-button" disabled={busy || !toState || availableTargets.length === 0 || blockedByDrafts}>{busy ? "Applying…" : "Apply controlled transition"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
