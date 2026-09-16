"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TaxFilingField, TaxMappingBalanceBasis } from "@/modules/tax/filing-template";
import type { TaxFilingWorkspaceDto } from "@/modules/tax/filing-workspace";
import styles from "./tax-filing-workspace.module.css";

type Feedback = Readonly<{ kind: "success" | "error"; message: string }>;

const balanceBasisLabels: Readonly<Record<TaxMappingBalanceBasis, string>> = {
  DEBITS: "Debit activity",
  CREDITS: "Credit activity",
  NET_DEBIT: "Net debit",
  NET_CREDIT: "Net credit",
  ABSOLUTE_NET: "Absolute net",
};

function currentTemplate(workspace: TaxFilingWorkspaceDto, templateId: string) {
  return workspace.templates.find((template) => template.id === templateId) ?? workspace.templates[0] ?? null;
}

function currentLedger(workspace: TaxFilingWorkspaceDto, ledgerId: string) {
  return workspace.ledgers.find((ledger) => ledger.ledgerId === ledgerId) ?? workspace.ledgers[0] ?? null;
}

function mappingSelections(
  workspace: TaxFilingWorkspaceDto,
  templateId: string,
  ledgerId: string,
) {
  const template = currentTemplate(workspace, templateId);
  const mappings = workspace.mappings.filter(
    (mapping) => mapping.ledgerId === ledgerId && mapping.templateId === templateId,
  );
  const accounts: Record<string, string[]> = {};
  const bases: Record<string, TaxMappingBalanceBasis> = {};
  for (const field of template?.definition.fields.filter((candidate) => candidate.kind === "ACCOUNT") ?? []) {
    const fieldMappings = mappings.filter((mapping) => mapping.fieldKey === field.key);
    accounts[field.key] = fieldMappings.map((mapping) => mapping.glAccountId);
    bases[field.key] = fieldMappings[0]?.balanceBasis ?? field.defaultBalanceBasis ?? "NET_DEBIT";
  }
  return { accounts, bases };
}

function csvRows(serialized: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character === '"') {
      if (quoted && serialized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && serialized[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("The CSV contains an unterminated quoted value.");
  return rows;
}

function fieldLookup(fields: readonly TaxFilingField[]) {
  const lookup = new Map<string, string>();
  for (const field of fields) {
    lookup.set(field.key.toLowerCase(), field.key);
    lookup.set(field.code.toLowerCase().replaceAll(" ", ""), field.key);
  }
  return (value: string) => lookup.get(value.trim().toLowerCase().replaceAll(" ", ""));
}

export function parseTaxFilingCsv(
  serialized: string,
  fields: readonly TaxFilingField[],
): Record<string, string> {
  const rows = csvRows(serialized);
  if (rows.length < 2) throw new Error("The CSV needs a header and at least one value row.");
  const resolve = fieldLookup(fields);
  const values: Record<string, string> = {};
  const firstHeader = rows[0]?.[0]?.trim().toLowerCase();
  if (["field", "field_key", "code", "line"].includes(firstHeader ?? "")) {
    for (const row of rows.slice(1)) {
      const key = resolve(row[0] ?? "");
      if (!key || !(row[1] ?? "").trim()) continue;
      values[key] = row[1]!.replaceAll("$", "").replaceAll(",", "").trim();
    }
  } else {
    const valueRow = rows[1] ?? [];
    for (const [index, header] of (rows[0] ?? []).entries()) {
      const key = resolve(header);
      const value = valueRow[index]?.replaceAll("$", "").replaceAll(",", "").trim();
      if (key && value) values[key] = value;
    }
  }
  if (Object.keys(values).length === 0) {
    throw new Error("No template field keys or line codes were recognized in the CSV.");
  }
  return values;
}

function idempotencyCommand() {
  return { fingerprint: "", key: crypto.randomUUID() };
}

export function TaxFilingWorkspace({ workspace }: { workspace: TaxFilingWorkspaceDto }) {
  const router = useRouter();
  const initialTemplateId = workspace.templates[0]?.id ?? "";
  const initialLedgerId = workspace.ledgers.find(
    (candidate) => candidate.currencyCode === workspace.templates[0]?.currencyCode,
  )?.ledgerId ?? workspace.ledgers[0]?.ledgerId ?? "";
  const initialSelections = mappingSelections(workspace, initialTemplateId, initialLedgerId);
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [accountSelections, setAccountSelections] = useState<Record<string, string[]>>(
    () => initialSelections.accounts,
  );
  const [basisSelections, setBasisSelections] = useState<Record<string, TaxMappingBalanceBasis>>(
    () => initialSelections.bases,
  );
  const [mappingReason, setMappingReason] = useState("");
  const [mappingFeedback, setMappingFeedback] = useState<Feedback | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const mappingCommand = useRef(idempotencyCommand());

  const [filingType, setFilingType] = useState<"PREPARED" | "HISTORICAL_IMPORT">("PREPARED");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [sourceFileName, setSourceFileName] = useState("");
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [reportedValues, setReportedValues] = useState<Record<string, string>>({});
  const [filingFeedback, setFilingFeedback] = useState<Feedback | null>(null);
  const [filingBusy, setFilingBusy] = useState(false);
  const filingCommand = useRef(idempotencyCommand());

  const template = currentTemplate(workspace, templateId);
  const ledger = currentLedger(workspace, ledgerId);
  const accountFields = useMemo(
    () => template?.definition.fields.filter((field) => field.kind === "ACCOUNT") ?? [],
    [template],
  );
  const manualFields = useMemo(
    () => template?.definition.fields.filter((field) => field.kind === "MANUAL") ?? [],
    [template],
  );
  const ledgerAccounts = useMemo(
    () => workspace.accounts.filter((account) => account.ledgerId === ledgerId),
    [workspace.accounts, ledgerId],
  );
  const latestMappings = useMemo(
    () => workspace.mappings.filter((mapping) => mapping.ledgerId === ledgerId && mapping.templateId === templateId),
    [workspace.mappings, ledgerId, templateId],
  );

  const selectScope = (nextTemplateId: string, nextLedgerId: string) => {
    const selections = mappingSelections(workspace, nextTemplateId, nextLedgerId);
    setTemplateId(nextTemplateId);
    setLedgerId(nextLedgerId);
    setAccountSelections(selections.accounts);
    setBasisSelections(selections.bases);
    setMappingFeedback(null);
    setManualValues({});
    setReportedValues({});
    mappingCommand.current = idempotencyCommand();
    filingCommand.current = idempotencyCommand();
  };

  const selectTemplate = (nextTemplateId: string) => {
    const next = currentTemplate(workspace, nextTemplateId);
    const nextLedgerId = next && ledger?.currencyCode !== next.currencyCode
      ? workspace.ledgers.find((candidate) => candidate.currencyCode === next.currencyCode)?.ledgerId ?? ""
      : ledgerId;
    selectScope(nextTemplateId, nextLedgerId);
  };

  const saveMappings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!template || !ledger || mappingBusy) return;
    const mappings = accountFields.flatMap((field) => (accountSelections[field.key] ?? []).map((glAccountId) => ({
      fieldKey: field.key,
      glAccountId,
      balanceBasis: basisSelections[field.key] ?? field.defaultBalanceBasis ?? "NET_DEBIT",
      multiplier: "1",
    })));
    const fields = {
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      templateId: template.id,
      mappings,
      reason: mappingReason.trim(),
    };
    const fingerprint = JSON.stringify(fields);
    if (mappingCommand.current.fingerprint !== fingerprint) {
      mappingCommand.current = { fingerprint, key: crypto.randomUUID() };
    }
    setMappingBusy(true);
    setMappingFeedback(null);
    try {
      const response = await fetch("/api/tax/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: mappingCommand.current.key }),
      });
      const payload = await response.json() as { error?: string; version?: number };
      if (!response.ok) throw new Error(payload.error ?? "The account mapping could not be saved.");
      setMappingFeedback({ kind: "success", message: `Mapping version ${payload.version ?? "new"} saved. Future filings will retain this exact version.` });
      setMappingReason("");
      router.refresh();
    } catch (error) {
      setMappingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The account mapping could not be saved." });
    } finally {
      setMappingBusy(false);
    }
  };

  const loadCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !template) return;
    try {
      const values = parseTaxFilingCsv(await file.text(), template.definition.fields);
      setReportedValues(values);
      setSourceFileName(file.name);
      setExternalReference((current) => current || file.name.replace(/\.csv$/i, ""));
      setFilingFeedback({ kind: "success", message: `${Object.keys(values).length} reported values loaded from ${file.name}.` });
    } catch (error) {
      setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The CSV could not be read." });
    } finally {
      event.target.value = "";
    }
  };

  const createFiling = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!template || !ledger || filingBusy) return;
    const fields = {
      legalEntityId: ledger.legalEntityId,
      ledgerId: ledger.ledgerId,
      templateId: template.id,
      filingType,
      periodStart,
      periodEnd,
      manualValues: Object.fromEntries(Object.entries(manualValues).filter(([, value]) => value.trim() !== "")),
      reportedValues: filingType === "HISTORICAL_IMPORT"
        ? Object.fromEntries(Object.entries(reportedValues).filter(([, value]) => value.trim() !== ""))
        : {},
      ...(filingType === "HISTORICAL_IMPORT" ? {
        externalReference: externalReference.trim(),
        ...(sourceFileName ? { sourceFileName } : {}),
      } : {}),
    };
    const fingerprint = JSON.stringify(fields);
    if (filingCommand.current.fingerprint !== fingerprint) {
      filingCommand.current = { fingerprint, key: crypto.randomUUID() };
    }
    setFilingBusy(true);
    setFilingFeedback(null);
    try {
      const response = await fetch("/api/tax/filings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, idempotencyKey: filingCommand.current.key }),
      });
      const payload = await response.json() as {
        error?: string;
        status?: string;
        varianceCount?: number;
        failedValidationCount?: number;
      };
      if (!response.ok) throw new Error(payload.error ?? "The filing workpaper could not be created.");
      setFilingFeedback({
        kind: "success",
        message: `${filingType === "PREPARED" ? "Return prepared" : "Historical filing reconciled"}: ${payload.status?.replaceAll("_", " ") ?? "saved"}, ${payload.varianceCount ?? 0} variances, ${payload.failedValidationCount ?? 0} rule exceptions.`,
      });
      router.refresh();
    } catch (error) {
      setFilingFeedback({ kind: "error", message: error instanceof Error ? error.message : "The filing workpaper could not be created." });
    } finally {
      setFilingBusy(false);
    }
  };

  if (!template || !ledger) {
    return <p className="validation-message validation-error">Configure an active ledger and install a tax template before using filing reconciliation.</p>;
  }

  const mappingReady = accountFields.filter((field) => field.required)
    .every((field) => (accountSelections[field.key] ?? []).length > 0);

  return (
    <div className={styles.workspace}>
      <section className={styles.scopeBar} aria-label="Tax filing scope">
        <label><span>Template</span>
          <select value={templateId} onChange={(event) => selectTemplate(event.target.value)}>
            {workspace.templates.map((option) => <option key={option.id} value={option.id}>{option.name} · v{option.version}</option>)}
          </select>
        </label>
        <label><span>Client company / ledger</span>
          <select value={ledgerId} onChange={(event) => selectScope(templateId, event.target.value)}>
            {workspace.ledgers.filter((option) => option.currencyCode === template.currencyCode).map((option) => (
              <option key={option.ledgerId} value={option.ledgerId}>{option.entityCode} · {option.ledgerCode} · {option.currencyCode}</option>
            ))}
          </select>
        </label>
        <div className={styles.scopeStatus}>
          <span>Mapping</span>
          <strong className={mappingReady ? styles.ready : styles.needsAttention}>
            {mappingReady ? `Ready · v${latestMappings[0]?.mappingVersion ?? "new"}` : "Required fields missing"}
          </strong>
        </div>
      </section>

      <div className="equal-columns dashboard-columns">
        <section className="panel form-panel" aria-labelledby="tax-mapping-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Client-specific setup</p>
              <h2 id="tax-mapping-title">Map template fields</h2>
              <p>Choose one or more accounts per field. Saving creates a new immutable mapping version.</p>
            </div>
          </div>
          <form className="close-form" onSubmit={(event) => { void saveMappings(event); }}>
            <div className={styles.mappingList}>
              {accountFields.map((field) => <fieldset key={field.key} className={styles.mappingField}>
                <legend><span className="code-chip">{field.code}</span> {field.label}{field.required ? " *" : ""}</legend>
                <p>{field.description}</p>
                <label><span>Ledger accounts</span>
                  <select
                    multiple
                    size={Math.min(5, Math.max(3, ledgerAccounts.length))}
                    value={accountSelections[field.key] ?? []}
                    disabled={!workspace.canManageMappings || mappingBusy}
                    onChange={(event) => setAccountSelections((current) => ({
                      ...current,
                      [field.key]: Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                    }))}
                  >
                    {ledgerAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.displayName} · {account.accountClass}</option>)}
                  </select>
                  <small>Use Ctrl/Cmd to select multiple accounts.</small>
                </label>
                <label><span>Balance treatment</span>
                  <select
                    value={basisSelections[field.key] ?? field.defaultBalanceBasis ?? "NET_DEBIT"}
                    disabled={!workspace.canManageMappings || mappingBusy}
                    onChange={(event) => setBasisSelections((current) => ({
                      ...current,
                      [field.key]: event.target.value as TaxMappingBalanceBasis,
                    }))}
                  >
                    {Object.entries(balanceBasisLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </fieldset>)}
            </div>
            <label><span>Change reason</span>
              <textarea value={mappingReason} minLength={8} maxLength={500} required disabled={!workspace.canManageMappings || mappingBusy} onChange={(event) => setMappingReason(event.target.value)} placeholder="Why does this account mapping apply to this client?" />
            </label>
            {!workspace.canManageMappings && <p className="validation-message">Your role can view tax workpapers but cannot change client mappings.</p>}
            {mappingFeedback && <p role={mappingFeedback.kind === "error" ? "alert" : "status"} className={`validation-message ${mappingFeedback.kind === "error" ? "validation-error" : "validation-success"}`}>{mappingFeedback.message}</p>}
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!workspace.canManageMappings || mappingBusy || !mappingReady}>{mappingBusy ? "Saving…" : "Save mapping version"}</button>
            </div>
          </form>
        </section>

        <section className="panel form-panel" aria-labelledby="tax-filing-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Prepare or reconcile</p>
              <h2 id="tax-filing-title">Tax return workpaper</h2>
              <p>Calculate from posted ledger activity or compare a historical return with the system.</p>
            </div>
          </div>
          <form className="close-form" onSubmit={(event) => { void createFiling(event); }}>
            <div className={styles.modeSwitch} role="group" aria-label="Filing workflow">
              <button type="button" className={filingType === "PREPARED" ? styles.activeMode : ""} onClick={() => { setFilingType("PREPARED"); setFilingFeedback(null); }}>Prepare declaration</button>
              <button type="button" className={filingType === "HISTORICAL_IMPORT" ? styles.activeMode : ""} onClick={() => { setFilingType("HISTORICAL_IMPORT"); setFilingFeedback(null); }}>Load historical filing</button>
            </div>
            <div className="form-grid form-grid-three">
              <label><span>Period start</span><input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} required disabled={filingBusy} /></label>
              <label><span>Period end</span><input type="date" value={periodEnd} min={periodStart || undefined} onChange={(event) => setPeriodEnd(event.target.value)} required disabled={filingBusy} /></label>
              <label><span>Currency</span><input value={template.currencyCode} readOnly /></label>
            </div>

            {manualFields.length > 0 && <fieldset className={styles.valueGroup}>
              <legend>Manual return adjustments</legend>
              <p>Enter supported adjustments not derived from mapped ledger accounts. Leave unused lines at zero.</p>
              <div className={styles.valueGrid}>{manualFields.map((field) => <label key={field.key}>
                <span><span className="code-chip">{field.code}</span> {field.label}</span>
                <input inputMode="decimal" value={manualValues[field.key] ?? ""} placeholder="0.00" disabled={filingBusy} onChange={(event) => setManualValues((current) => ({ ...current, [field.key]: event.target.value }))} />
              </label>)}</div>
            </fieldset>}

            {filingType === "HISTORICAL_IMPORT" && <>
              <div className="form-grid form-grid-three">
                <label><span>Filing reference</span><input value={externalReference} maxLength={200} required disabled={filingBusy} onChange={(event) => setExternalReference(event.target.value)} placeholder="CRA confirmation or internal reference" /></label>
                <label className={styles.fileField}><span>Load CSV</span><input type="file" accept=".csv,text/csv" disabled={filingBusy} onChange={(event) => { void loadCsv(event); }} /><small>Use <code>field,value</code> rows or line codes as column headers.</small></label>
                <label><span>Loaded source</span><input value={sourceFileName || "Manual entry"} readOnly /></label>
              </div>
              <fieldset className={styles.valueGroup}>
                <legend>Values reported on the historical return</legend>
                <p>Imported values remain editable for review. Field keys and CRA line codes are both accepted in CSV files.</p>
                <div className={styles.valueGrid}>{template.definition.fields.filter((field) => field.reconcile).map((field) => <label key={field.key}>
                  <span><span className="code-chip">{field.code}</span> {field.label}</span>
                  <input inputMode="decimal" value={reportedValues[field.key] ?? ""} placeholder="Not reported" disabled={filingBusy} onChange={(event) => setReportedValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                </label>)}</div>
              </fieldset>
            </>}

            <p className="form-footnote">Calculations use posted journal lines in the selected date range and mapping version. The resulting workpaper is immutable and does not submit data to {template.authority}.</p>
            {!workspace.canPrepareFilings && <p className="validation-message">Your role can view tax workpapers but cannot prepare or import filings.</p>}
            {filingFeedback && <p role={filingFeedback.kind === "error" ? "alert" : "status"} className={`validation-message ${filingFeedback.kind === "error" ? "validation-error" : "validation-success"}`}>{filingFeedback.message}</p>}
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!workspace.canPrepareFilings || filingBusy || !mappingReady}>{filingBusy ? "Calculating…" : filingType === "PREPARED" ? "Prepare return" : "Reconcile historical filing"}</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
