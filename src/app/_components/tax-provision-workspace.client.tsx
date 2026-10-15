"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { provisionAssumptionsSchema, type ProvisionAssumptions } from "@/modules/tax/provision-model";
import type { listProvisions, provisionWorkspaceOptions, previewProvision, ProvisionCalculationRow } from "@/modules/tax/provision-service";
import type { ProvisionAssumptionRow } from "@/modules/tax/provision-sources";
import { TaxReviewValues } from "./tax-draft-review.client";
import { ProvisionAssumptionsEditor, emptyProvisionAssumptions } from "./provision-assumptions-editor.client";
type Data = Awaited<ReturnType<typeof listProvisions>>;
type Options = Awaited<ReturnType<typeof provisionWorkspaceOptions>>;
export function TaxProvisionWorkspace({ data, options, writable }: {
    data: Data;
    options: Options;
    writable: boolean;
}) {
    const router = useRouter(), [ledgerId, setLedgerId] = useState(options.ledgers[0]?.id ?? ""), [year, setYear] = useState(new Date().getUTCFullYear()), [yearStart, setYearStart] = useState(""), [yearEnd, setYearEnd] = useState(""), [assumptions, setAssumptions] = useState<ProvisionAssumptions>(emptyProvisionAssumptions), [selected, setSelected] = useState<ProvisionAssumptionRow | null>(null), [dirty, setDirty] = useState(true), [periodId, setPeriodId] = useState(""), [throughDate, setThroughDate] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [preview, setPreview] = useState<Awaited<ReturnType<typeof previewProvision>> | null>(null);
    const request = useRef({ fingerprint: "", key: "" });
    const ledger = options.ledgers.find(l => l.id === ledgerId), current = data.assumptions.filter(a => a.ledger_id === ledgerId && a.fiscal_year === year).sort((a, b) => b.version - a.version)[0], periods = options.periods.filter(p => p.ledgerId === ledgerId && p.fiscalYear === year), combinations = options.combinations.filter(c => c.ledgerId === ledgerId);
    const canConfigure = writable && options.capabilities.configure, canPrepare = writable && options.capabilities.prepare, canDraft = canPrepare && options.capabilities.draft;
    const edited = (next: ProvisionAssumptions) => { setAssumptions(next); setDirty(true); setPreview(null); };
    async function post(path: string, body: Record<string, unknown>) { const fingerprint = JSON.stringify({ path, body }); if (request.current.fingerprint !== fingerprint)
        request.current = { fingerprint, key: crypto.randomUUID() }; const response = await fetch(`/api/tax/provision/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotencyKey: request.current.key }) }); const result = await response.json(); if (!response.ok)
        throw new Error(result.error ?? "The provision action could not be completed."); return result; }
    async function action(work: () => Promise<void>) { if (busy)
        return; setBusy(true); setError(""); try {
        await work();
        router.refresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "The provision action failed.");
    }
    finally {
        setBusy(false);
    } }
    function load(row: ProvisionAssumptionRow) { setSelected(row); setLedgerId(row.ledger_id); setYear(row.fiscal_year); setYearStart(row.year_start); setYearEnd(row.year_end); setAssumptions(provisionAssumptionsSchema.parse(row.payload)); setDirty(false); setPreview(null); setPeriodId(""); setThroughDate(""); }
    async function saveAssumptions(mode: "SAVE" | "REVIEW") {
        const parsed = provisionAssumptionsSchema.safeParse(assumptions);
        if (!parsed.success)
            throw new Error(parsed.error.issues.map(i => `${i.path.join(" · ")}: ${i.message}`).join("; "));
        const result = await post("assumptions", { action: mode, legalEntityId: ledger?.entityId, ledgerId, fiscalYear: year, yearStart, yearEnd, expectedVersion: selected?.version ?? current?.version ?? 0, payload: parsed.data, reason });
        setSelected(result.assumptions);
        setDirty(false);
        setPreview(null);
    }
    async function check(input = { assumptionsId: selected?.id ?? "", periodId, throughDate }) { const response = await fetch(`/api/tax/provision/preview?${new URLSearchParams(input)}`, { cache: "no-store" }); const result = await response.json(); if (!response.ok)
        throw new Error(result.error ?? "Provision sources could not be checked."); setPreview(result); return result; }
    async function saveCalculation() { if (!selected)
        return; const expectedVersion = Math.max(0, ...data.calculations.filter(c => c.ledger_id === ledgerId && c.through_date === throughDate).map(c => c.version)); await post("calculations", { assumptionsId: selected.id, periodId, throughDate, expectedVersion, reason }); await check(); }
    async function event(calc: ProvisionCalculationRow, mode: "REVIEW" | "DRAFT") { const latest = data.events.filter(e => e.calculation_id === calc.id).at(-1); await post("events", { calculationId: calc.id, action: mode, expectedVersion: latest?.version ?? 0, sourceHash: calc.source_hash, reason }); }
    return <>
  <p>Prepare a provisional current-tax estimate from posted books and reviewed tax-year assumptions. A draft journal requires a separate action and normal approval and posting. Deferred tax, return submission and payments are outside this calculation.</p>
  {error && <p role="alert">{error}</p>}
  <section className="panel"><h2>Assumptions and fiscal scope</h2>
   <label>Saved assumptions<select value={selected?.id ?? ""} onChange={e => { const row = data.assumptions.find(a => a.id === e.target.value); if (row)
        load(row);
    else {
        setSelected(null);
        setAssumptions(emptyProvisionAssumptions());
        setDirty(true);
    } }}><option value="">New assumptions</option>{data.assumptions.map(a => <option key={a.id} value={a.id}>{options.ledgers.find(l => l.id === a.ledger_id)?.label} · {a.fiscal_year} · v{a.version} {a.state}</option>)}</select></label>
   <fieldset disabled={!canConfigure || busy}><legend>Editable assumption inputs</legend><div className="form-grid" onChange={() => { setDirty(true); setPreview(null); }}>
    <label>Company and ledger<select value={ledgerId} onChange={e => { setLedgerId(e.target.value); setSelected(null); setPeriodId(""); setAssumptions(emptyProvisionAssumptions()); }}>{options.ledgers.map(l => <option key={l.id} value={l.id}>{l.label} · {l.currency}</option>)}</select></label>
    <label>Fiscal tax year<input type="number" min={1900} max={2500} value={year} onChange={e => { setYear(Number(e.target.value)); setSelected(null); setPeriodId(""); }}/></label>
    <label>Fiscal year starts<input type="date" value={yearStart} onChange={e => setYearStart(e.target.value)}/></label><label>Fiscal year ends<input type="date" value={yearEnd} onChange={e => setYearEnd(e.target.value)}/></label>
    <label>Current-tax expense combination<select value={assumptions.expenseCombinationId ?? ""} onChange={e => edited({ ...assumptions, expenseCombinationId: e.target.value || null })}><option value="">Select reviewed expense</option>{combinations.filter(c => c.accountClass === "EXPENSE").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <label>Current-tax payable combination<select value={assumptions.payableCombinationId ?? ""} onChange={e => edited({ ...assumptions, payableCombinationId: e.target.value || null })}><option value="">Select reviewed liability</option>{combinations.filter(c => c.accountClass === "LIABILITY").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <fieldset><legend>Every current-tax expense account to exclude from book income</legend>{combinations.filter((c, i, all) => c.accountClass === "EXPENSE" && all.findIndex(x => x.accountId === c.accountId) === i).map(c => <label key={c.accountId}><input type="checkbox" checked={assumptions.expenseAccountIds.includes(c.accountId)} onChange={e => edited({ ...assumptions, expenseAccountIds: e.target.checked ? [...assumptions.expenseAccountIds, c.accountId] : assumptions.expenseAccountIds.filter(id => id !== c.accountId) })}/>{c.label}</label>)}</fieldset>
    <ProvisionAssumptionsEditor value={assumptions} onChange={edited}/>
   </div></fieldset>
   <label>Reason for the next save, review or generation<input minLength={8} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}/></label>
   {selected && <p>Version {selected.version} · {selected.state} · recorded by {selected.created_by} at {new Date(selected.created_at).toISOString()}. {dirty ? "Inputs changed; save before review or calculation." : "Saved inputs displayed."}</p>}
   {canConfigure && <div className="form-actions"><button disabled={busy || reason.trim().length < 8} onClick={() => void action(() => saveAssumptions("SAVE"))}>Save assumptions draft</button><button disabled={busy || dirty || selected?.state !== "DRAFT" || selected.id !== current?.id || reason.trim().length < 8} onClick={() => void action(() => saveAssumptions("REVIEW"))}>Review exact assumptions</button></div>}
  </section>
  <section className="panel"><h2>Calculate and inspect</h2><div className="form-grid">
   <label>Accounting period<select value={periodId} onChange={e => { setPeriodId(e.target.value); setThroughDate(periods.find(p => p.id === e.target.value)?.endsOn ?? ""); setPreview(null); }}><option value="">Select period</option>{periods.map(p => <option key={p.id} value={p.id}>{p.label} · {p.state}</option>)}</select></label>
   <label>YTD through date<input type="date" value={throughDate} onChange={e => { setThroughDate(e.target.value); setPreview(null); }}/></label></div>
   <div className="form-actions"><button disabled={busy || dirty || !selected || !periodId || !throughDate} onClick={() => void action(async () => { await check(); })}>Inspect current sources</button>{canPrepare && <button disabled={busy || dirty || !selected || !periodId || !throughDate || reason.trim().length < 8} onClick={() => void action(saveCalculation)}>Save immutable calculation</button>}</div>
   {preview && <><h3>{preview.snapshot.ready ? "Ready for review" : "Calculation blocked"}</h3><p>YTD current tax {preview.snapshot.currency} {preview.snapshot.ytdCurrentTax} · prior current-year provisions {preview.snapshot.priorPostedProvision} · incremental adjustment {preview.snapshot.incrementalAdjustment}</p>{preview.snapshot.blockers.length > 0 && <ul>{preview.snapshot.blockers.map(b => <li key={b}>{b}</li>)}</ul>}<details><summary>Exact current sources, assumptions and liability roll-forward</summary><TaxReviewValues value={preview}/></details></>}
  </section>
  <section className="panel"><h2>Saved calculations and journal lineage</h2>{data.calculations.length === 0 && <p>No saved provision calculations.</p>}{data.calculations.map(calc => {
            const events = data.events.filter(e => e.calculation_id === calc.id), latest = events.at(-1), snapshot = calc.snapshot;
            return <article key={calc.id}><h3>{snapshot.scope.entityName} · {snapshot.scope.ledgerCode} · through {calc.through_date} · v{calc.version}</h3><p>{calc.id} · {snapshot.ready ? "Ready when captured" : "Blocked when captured"} · adjustment {snapshot.currency} {snapshot.incrementalAdjustment}</p>
   <details><summary>Immutable calculation, evidence and review history</summary><TaxReviewValues value={snapshot}/><TaxReviewValues value={events}/></details>
   {latest?.action === "DRAFT" ? <p>{latest.journal_id ? <a href={`/app/journals/${latest.journal_id}`}>Journal {latest.journal_id} · {latest.journal_status}{latest.journal_deleted ? " · deleted unposted draft" : ""}</a> : "Zero adjustment: no journal generated."}</p> : <div className="form-actions"><button disabled={busy} onClick={() => void action(async () => { const result = await check({ assumptionsId: calc.assumptions_id, periodId: calc.period_id, throughDate: calc.through_date }); if (result.sourceHash !== calc.source_hash)
                throw new Error("This saved calculation is stale. Save and review current sources."); })}>Check source freshness</button>{canPrepare && <button disabled={busy || !snapshot.ready || reason.trim().length < 8} onClick={() => void action(() => event(calc, "REVIEW"))}>Review this calculation</button>}{canDraft && <button disabled={busy || latest?.action !== "REVIEW" || reason.trim().length < 8} onClick={() => void action(() => event(calc, "DRAFT"))}>Generate unposted journal</button>}</div>}
  </article>;
        })}</section>
 </>;
}
