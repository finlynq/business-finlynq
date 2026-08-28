"use client";

import { useId, useMemo, useState } from "react";
import { exact } from "@/kernel/money";
import type { ManualJournalOptionsDto } from "@/modules/ledger/tenant-workspace";

type DraftLine = Readonly<{
  id: number;
  accountCombinationId: string;
  memo: string;
  debit: string;
  credit: string;
}>;
type SaveResult = Readonly<{
  journalId: string;
  status: "DRAFT" | "POSTED";
  journalNumber: number | null;
  idempotentReplay: boolean;
  autoPosted: boolean;
}>;

const purposes = [
  ["ROUTINE", "Routine"],
  ["ADJUSTING", "Adjusting"],
  ["OPENING", "Opening"],
  ["CLOSING", "Closing"],
  ["REVALUATION", "Revaluation"],
  ["TAX_ADJUSTMENT", "Tax adjustment"],
] as const;

function money(value: string): ReturnType<typeof exact> | null {
  const normalized = value.trim() || "0";
  if (!/^\d+(?:\.\d{1,9})?$/.test(normalized)) return null;
  try {
    return exact(normalized);
  } catch {
    return null;
  }
}

function formatAmount(value: ReturnType<typeof exact>, currency: string): string {
  const [whole, fraction] = value.toFixed(2).split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function emptyLines(): DraftLine[] {
  return [
    { id: 1, accountCombinationId: "", memo: "", debit: "", credit: "" },
    { id: 2, accountCombinationId: "", memo: "", debit: "", credit: "" },
  ];
}

export function RealJournalDraftForm({
  options,
  initialAccountingDate,
  initialEntityId,
}: {
  options: ManualJournalOptionsDto;
  initialAccountingDate: string;
  initialEntityId?: string | null;
}) {
  const formId = useId();
  // The server validates this presentation preference against the tenant's
  // active entity set. Finding it again in the authorized DTO keeps the client
  // default from becoming an accounting or authorization boundary.
  const initialEntity = options.entities.find((entity) => entity.id === initialEntityId)
    ?? options.entities[0];
  const [entityId, setEntityId] = useState(initialEntity?.id ?? "");
  const [periodId, setPeriodId] = useState(initialEntity?.periods[0]?.id ?? "");
  const [accountingDate, setAccountingDate] = useState(initialAccountingDate);
  const [purpose, setPurpose] = useState<(typeof purposes)[number][0]>("ROUTINE");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(emptyLines);
  const [nextLineId, setNextLineId] = useState(3);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  const entity = options.entities.find((candidate) => candidate.id === entityId) ?? initialEntity;
  const currency = entity?.currency ?? "";
  const totals = useMemo(() => lines.reduce(
    (sum, line) => ({
      debit: sum.debit.plus(money(line.debit) ?? exact(0)),
      credit: sum.credit.plus(money(line.credit) ?? exact(0)),
    }),
    { debit: exact(0), credit: exact(0) },
  ), [lines]);

  const markChanged = () => {
    setMessage(null);
    setIdempotencyKey("");
  };
  const updateLine = (id: number, field: keyof Omit<DraftLine, "id">, value: string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [field]: value } : line));
    markChanged();
  };
  const changeEntity = (nextEntityId: string) => {
    const nextEntity = options.entities.find((candidate) => candidate.id === nextEntityId);
    setEntityId(nextEntityId);
    setPeriodId(nextEntity?.periods[0]?.id ?? "");
    setLines(emptyLines());
    setNextLineId(3);
    markChanged();
  };
  const addLine = () => {
    if (lines.length >= 200) return;
    setLines((current) => [...current, {
      id: nextLineId,
      accountCombinationId: "",
      memo: "",
      debit: "",
      credit: "",
    }]);
    setNextLineId((current) => current + 1);
    markChanged();
  };
  const removeLine = (id: number) => {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((line) => line.id !== id));
    markChanged();
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!entity || !periodId || !accountingDate || !description.trim()) {
      setMessage({ kind: "error", text: "Choose an entity and period, then provide the accounting date and business purpose." });
      return;
    }
    if (lines.some((line) => !line.accountCombinationId || money(line.debit) === null || money(line.credit) === null)) {
      setMessage({ kind: "error", text: "Each line needs an account and valid exact-decimal debit and credit values." });
      return;
    }
    if (totals.debit.isZero() || !totals.debit.equals(totals.credit)) {
      setMessage({ kind: "error", text: "The journal must have equal, non-zero functional debits and credits." });
      return;
    }
    const requestKey = idempotencyKey || crypto.randomUUID();
    setIdempotencyKey(requestKey);
    setBusy(true);
    try {
      const response = await fetch("/api/ledger/journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ledgerId: entity.ledgerId,
          legalEntityId: entity.id,
          periodId,
          accountingDate,
          purpose,
          description: description.trim(),
          idempotencyKey: requestKey,
          lines: lines.map((line) => ({
            accountCombinationId: line.accountCombinationId,
            debitFunctional: line.debit.trim() || "0",
            creditFunctional: line.credit.trim() || "0",
            transactionCurrency: entity.currency,
            debitTransaction: line.debit.trim() || "0",
            creditTransaction: line.credit.trim() || "0",
            fxRate: "1",
            fxRateSource: "functional-currency",
            fxRateEffectiveAt: `${accountingDate}T12:00:00.000Z`,
            memo: line.memo.trim() || undefined,
          })),
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<SaveResult> & { error?: unknown };
      if (!response.ok) {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string" ? payload.error : "The journal could not be saved.",
        });
        return;
      }
      const result = payload as SaveResult;
      const identifier = result.journalNumber === null ? result.journalId : `journal ${result.journalNumber}`;
      setMessage({
        kind: "success",
        text: result.status === "POSTED"
          ? `${identifier} was saved and auto-posted by the ledger policy.`
          : `${identifier} was saved as a draft for an authorized poster.`,
      });
      setDescription("");
      setLines(emptyLines());
      setNextLineId(3);
      setIdempotencyKey("");
    } catch {
      setMessage({ kind: "error", text: "The save result is unknown. Retry without changing the form so the same idempotency key is used." });
    } finally {
      setBusy(false);
    }
  };

  if (!entity) {
    return <p className="validation-message validation-error" role="alert">No active primary ledger is configured for this organization.</p>;
  }

  return (
    <form className="journal-form" onSubmit={save} noValidate>
      <div className="form-grid form-grid-three">
        <label>
          <span>Legal entity</span>
          <select value={entity.id} onChange={(event) => changeEntity(event.target.value)} disabled={busy}>
            {options.entities.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.code} · {candidate.currency}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Fiscal period</span>
          <select value={periodId} onChange={(event) => { setPeriodId(event.target.value); markChanged(); }} disabled={busy}>
            <option value="">Select a period</option>
            {entity.periods.map((period) => (
              <option key={period.id} value={period.id}>{period.label} · {period.state.replace("_", " ")}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Accounting date</span>
          <input type="date" value={accountingDate} onChange={(event) => { setAccountingDate(event.target.value); markChanged(); }} required disabled={busy} />
        </label>
        <label>
          <span>Purpose</span>
          <select value={purpose} onChange={(event) => { setPurpose(event.target.value as (typeof purposes)[number][0]); markChanged(); }} disabled={busy}>
            {purposes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <label className="full-field">
        <span>Description</span>
        <input
          type="text"
          value={description}
          maxLength={500}
          onChange={(event) => { setDescription(event.target.value); markChanged(); }}
          placeholder="Explain the business purpose"
          aria-describedby={`${formId}-description-help`}
          disabled={busy}
        />
        <small id={`${formId}-description-help`}>Manual journals cannot use AR/AP control accounts. Source-owned entries must be corrected in their source module.</small>
      </label>

      <div className="journal-lines-heading">
        <div><span className="eyebrow">Exact-decimal entry</span><h2>Journal lines</h2></div>
        <button type="button" className="secondary-button" onClick={addLine} disabled={busy || lines.length >= 200}>＋ Add line</button>
      </div>
      <div className="journal-lines">
        {lines.map((line, index) => (
          <fieldset className="journal-line" key={line.id} disabled={busy}>
            <legend>Line {index + 1}</legend>
            <label className="account-field">
              <span>Account</span>
              <select value={line.accountCombinationId} onChange={(event) => updateLine(line.id, "accountCombinationId", event.target.value)}>
                <option value="">Select an account</option>
                {entity.accounts.map((account) => (
                  <option key={account.combinationId} value={account.combinationId}>{account.code} · {account.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Memo</span>
              <input type="text" maxLength={500} value={line.memo} onChange={(event) => updateLine(line.id, "memo", event.target.value)} placeholder="Optional" />
            </label>
            <label>
              <span>Debit ({currency})</span>
              <input inputMode="decimal" value={line.debit} onChange={(event) => updateLine(line.id, "debit", event.target.value)} placeholder="0.00" />
            </label>
            <label>
              <span>Credit ({currency})</span>
              <input inputMode="decimal" value={line.credit} onChange={(event) => updateLine(line.id, "credit", event.target.value)} placeholder="0.00" />
            </label>
            <button type="button" className="icon-button remove-line" aria-label={`Remove line ${index + 1}`} disabled={lines.length <= 2 || busy} onClick={() => removeLine(line.id)}>×</button>
          </fieldset>
        ))}
      </div>
      <div className="journal-totals" aria-label="Draft totals">
        <span>Debit <strong>{formatAmount(totals.debit, currency)}</strong></span>
        <span>Credit <strong>{formatAmount(totals.credit, currency)}</strong></span>
        <span>Difference <strong>{formatAmount(totals.debit.minus(totals.credit).abs(), currency)}</strong></span>
      </div>

      {message && (
        <p className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`} role={message.kind === "error" ? "alert" : "status"}>
          <strong>{message.kind === "success" ? "Saved." : "Not saved."}</strong> {message.text}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={options.readOnly || busy || entity.periods.length === 0 || entity.accounts.length < 2}>
          {busy ? "Saving…" : "Save journal"}
        </button>
      </div>
      <p className="form-footnote">
        {options.readOnly
          ? "Your current role cannot create manual journal drafts."
          : "The ledger posting policy decides whether a valid journal remains a draft or auto-posts in the same transaction."}
      </p>
    </form>
  );
}
