"use client";

import { useId, useMemo, useState } from "react";
import { exact } from "@/kernel/money";
import { demoCurrentActor } from "@/modules/demo/dashboard-data";
import { validateDemoManualJournalPreview } from "@/modules/demo/workspace";
import type { DemoManualJournalPreviewInput, DemoManualJournalPreviewResult } from "@/modules/demo/types";

type DraftLine = {
  id: number;
  account: string;
  memo: string;
  debit: string;
  credit: string;
};

const accounts = [
  ["", "Select an account"],
  ["1000", "1000 · Cash"],
  ["1400", "1400 · Prepaid expenses"],
  ["2300", "2300 · Accrued liabilities"],
  ["4100", "4100 · Service revenue"],
  ["6100", "6100 · Operating expenses"],
] as const;

function previewAmount(value: string): ReturnType<typeof exact> {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return exact(0);

  try {
    return exact(normalized);
  } catch {
    return exact(0);
  }
}

function formatExactAmount(value: ReturnType<typeof exact>, currency: string): string {
  const [whole, fraction] = value.toFixed(2).split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${groupedWhole}.${fraction}`;
}

export function JournalDraftForm() {
  const formId = useId();
  const [entity, setEntity] = useState("CA01");
  const [purpose, setPurpose] = useState<DemoManualJournalPreviewInput["purpose"]>("ROUTINE");
  const [accountingDate, setAccountingDate] = useState("2026-08-26");
  const [description, setDescription] = useState("");
  const [nextLineId, setNextLineId] = useState(3);
  const [lines, setLines] = useState<DraftLine[]>([
    { id: 1, account: "", memo: "", debit: "", credit: "" },
    { id: 2, account: "", memo: "", debit: "", credit: "" },
  ]);
  const [result, setResult] = useState<DemoManualJournalPreviewResult | null>(null);
  const currency = entity === "CA01" ? "CAD" : "USD";
  const canPostAdjustment = demoCurrentActor.permissions.includes("ledger.journal.post_adjustment");

  const totals = useMemo(() => lines.reduce(
    (sum, line) => ({
      debit: sum.debit.plus(previewAmount(line.debit)),
      credit: sum.credit.plus(previewAmount(line.credit)),
    }),
    { debit: exact(0), credit: exact(0) },
  ), [lines]);

  const updateLine = (id: number, field: keyof Omit<DraftLine, "id">, value: string) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [field]: value } : line));
    setResult(null);
  };

  const addLine = () => {
    setLines((current) => [...current, { id: nextLineId, account: "", memo: "", debit: "", credit: "" }]);
    setNextLineId((value) => value + 1);
  };

  const removeLine = (id: number) => {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((line) => line.id !== id));
    setResult(null);
  };

  const validate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResult(validateDemoManualJournalPreview({
      entityCode: entity,
      accountingDate,
      description,
      purpose,
      canPostAdjustment,
      lines: lines.map((line) => ({
        accountCode: line.account,
        accountName: accounts.find(([code]) => code === line.account)?.[1],
        debitFunctional: line.debit.trim() || "0",
        creditFunctional: line.credit.trim() || "0",
        memo: line.memo,
      })),
    }));
  };

  return (
    <form className="journal-form" onSubmit={validate} noValidate>
      <div className="form-grid form-grid-three">
        <label>
          <span>Legal entity</span>
          <select value={entity} onChange={(event) => { setEntity(event.target.value); setResult(null); }}>
            <option value="CA01">CA01 · Canada · CAD</option>
            <option value="US01">US01 · United States · USD</option>
          </select>
        </label>
        <label>
          <span>Accounting date</span>
          <input type="date" value={accountingDate} onChange={(event) => { setAccountingDate(event.target.value); setResult(null); }} required />
        </label>
        <label>
          <span>Purpose</span>
          <select value={purpose} onChange={(event) => { setPurpose(event.target.value as DemoManualJournalPreviewInput["purpose"]); setResult(null); }}>
            <option value="ROUTINE">Routine</option>
            <option value="ADJUSTING">Adjusting</option>
            <option value="TAX_ADJUSTMENT">Tax adjustment</option>
          </select>
        </label>
      </div>
      <label className="full-field">
        <span>Description</span>
        <input
          type="text"
          value={description}
          maxLength={240}
          onChange={(event) => { setDescription(event.target.value); setResult(null); }}
          placeholder="Explain the business purpose"
          aria-describedby={`${formId}-description-help`}
        />
        <small id={`${formId}-description-help`}>Manual journals cannot use AR/AP control accounts or edit source-owned documents.</small>
      </label>

      <div className="journal-lines-heading">
        <div><span className="eyebrow">Exact-decimal preview</span><h2>Journal lines</h2></div>
        <button type="button" className="secondary-button" onClick={addLine}>＋ Add line</button>
      </div>
      <div className="journal-lines">
        {lines.map((line, index) => (
          <fieldset className="journal-line" key={line.id}>
            <legend>Line {index + 1}</legend>
            <label className="account-field">
              <span>Account</span>
              <select value={line.account} onChange={(event) => updateLine(line.id, "account", event.target.value)}>
                {accounts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>Memo</span>
              <input type="text" value={line.memo} onChange={(event) => updateLine(line.id, "memo", event.target.value)} placeholder="Optional" />
            </label>
            <label>
              <span>Debit ({currency})</span>
              <input inputMode="decimal" value={line.debit} onChange={(event) => updateLine(line.id, "debit", event.target.value)} placeholder="0.00" />
            </label>
            <label>
              <span>Credit ({currency})</span>
              <input inputMode="decimal" value={line.credit} onChange={(event) => updateLine(line.id, "credit", event.target.value)} placeholder="0.00" />
            </label>
            <button type="button" className="icon-button remove-line" aria-label={`Remove line ${index + 1}`} disabled={lines.length <= 2} onClick={() => removeLine(line.id)}>×</button>
          </fieldset>
        ))}
      </div>
      <div className="journal-totals" aria-label="Draft totals">
        <span>Debit <strong>{formatExactAmount(totals.debit, currency)}</strong></span>
        <span>Credit <strong>{formatExactAmount(totals.credit, currency)}</strong></span>
        <span>Difference <strong>{formatExactAmount(totals.debit.minus(totals.credit).abs(), currency)}</strong></span>
      </div>

      {result && !result.valid && (
        <div className="validation-message validation-error" role="alert">
          <strong>Draft preview has {result.issues.length} validation issue{result.issues.length === 1 ? "" : "s"}.</strong>
          <ul>{result.issues.map((issue, index) => <li key={`${issue.code}-${issue.line ?? "journal"}-${index}`}>{issue.line ? `Line ${issue.line}: ` : ""}{issue.message}</li>)}</ul>
        </div>
      )}
      {result?.valid && <p className="validation-message validation-success" role="status"><strong>Validation passed.</strong> Balanced preview: {result.currency} {result.totalDebit} debits and credits. Nothing was saved.</p>}

      <div className="form-actions">
        <button type="submit" className="primary-button">Validate draft</button>
        <button type="button" className="secondary-button" disabled aria-describedby={`${formId}-write-gate`}>Save draft unavailable</button>
      </div>
      <p id={`${formId}-write-gate`} className="form-footnote">Saving and posting require a signed tenant session, encrypted persistence, authorization, and <code>BUSINESS_WRITES_ENABLED=true</code>.</p>
    </form>
  );
}
