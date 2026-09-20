"use client";

import { CompactDisclosure } from "./compact-disclosure.client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MutationFeedback } from "@/app/_components/mutation-feedback.client";

type Category = Readonly<{
  id: string;
  legalEntityId: string;
  ledgerId: string;
  kind: "TANGIBLE" | "INTANGIBLE" | "PREPAID";
  code: string;
  displayName: string;
  version: number;
  active: boolean;
  current: boolean;
}>;
type Asset = Readonly<{
  id: string;
  assetNumber: string;
  displayName: string;
  kind: string;
  classification: string;
  status: string;
  acquisitionDate: string;
  inServiceOn: string;
  scheduleEndOn: string | null;
  cost: string;
  residualValue: string;
  recognizedToDate: string;
  remainingBalance: string;
  categoryCode: string;
  categoryName: string;
  currency: string;
}>;
type Schedule = Readonly<{
  id: string;
  assetId: string;
  assetNumber: string;
  sequenceNumber: number;
  periodStartOn: string;
  periodEndOn: string;
  dueOn: string;
  amount: string;
  status: string;
  journalEntryId: string | null;
}>;
type Account = Readonly<{
  id: string;
  legalEntityId: string;
  ledgerId: string;
  entityCode: string;
  ledgerCode: string;
  code: string;
  displayName: string;
  class: string;
}>;
type Reconciliation = Readonly<{
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  currency: string;
  grossCost: string;
  recognized: string;
  registerNet: string;
  glNet: string;
  variance: string;
}>;

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request failed.");
  return result;
}

export function AssetWorkspace({ workspace }: {
  workspace: Readonly<{
    categories: readonly Category[];
    assets: readonly Asset[];
    schedules: readonly Schedule[];
    accounts: readonly Account[];
    reconciliation: readonly Reconciliation[];
    canManageCategories: boolean;
    canDraftSchedules: boolean;
    isDemo: boolean;
  }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Readonly<{ kind: "success" | "error"; message: string }> | null>(null);
  const [selectedLedgerId, setSelectedLedgerId] = useState(
    workspace.categories[0]?.ledgerId ?? workspace.accounts[0]?.ledgerId ?? "",
  );
  const ledgerScopes = useMemo(() => Array.from(new Map(workspace.accounts.map((account) => [
    account.ledgerId,
    { ledgerId: account.ledgerId, legalEntityId: account.legalEntityId, entityCode: account.entityCode, ledgerCode: account.ledgerCode },
  ])).values()), [workspace.accounts]);
  const categoryAccounts = useMemo(() => workspace.accounts.filter((account) =>
    account.ledgerId === selectedLedgerId), [workspace.accounts, selectedLedgerId]);
  const activeCategories = useMemo(() => workspace.categories.filter((category) => category.active && category.current), [workspace.categories]);

  async function submitCategory(formData: FormData) {
    setBusy("category"); setFeedback(null);
    try {
      const kind = String(formData.get("kind"));
      const impairmentAccountCombinationId = String(formData.get("impairmentAccountCombinationId") || "");
      const disposalAccountCombinationId = String(formData.get("disposalAccountCombinationId") || "");
      await postJson("/api/assets/categories", {
        legalEntityId: String(formData.get("legalEntityId")),
        ledgerId: String(formData.get("ledgerId")),
        kind,
        code: String(formData.get("code")),
        displayName: String(formData.get("displayName")),
        costAccountCombinationId: String(formData.get("costAccountCombinationId")),
        ...(kind === "PREPAID" ? {} : { contraAccountCombinationId: String(formData.get("contraAccountCombinationId")) }),
        expenseAccountCombinationId: String(formData.get("expenseAccountCombinationId")),
        ...(impairmentAccountCombinationId ? { impairmentAccountCombinationId } : {}),
        ...(disposalAccountCombinationId ? { disposalAccountCombinationId } : {}),
        effectiveFrom: new Date().toISOString().slice(0, 10),
        reason: String(formData.get("reason")),
        idempotencyKey: crypto.randomUUID(),
      });
      setFeedback({ kind: "success", message: "Category created." }); router.refresh();
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Category creation failed." }); }
    finally { setBusy(null); }
  }

  async function submitAsset(formData: FormData) {
    setBusy("asset"); setFeedback(null);
    try {
      const categoryId = String(formData.get("categoryId"));
      const category = activeCategories.find((item) => item.id === categoryId);
      if (!category) throw new Error("Choose an asset category.");
      const indefinite = formData.get("classification") === "INDEFINITE_LIFE";
      await postJson("/api/assets/register", {
        categoryId,
        assetNumber: String(formData.get("assetNumber")),
        displayName: String(formData.get("displayName")),
        classification: indefinite ? "INDEFINITE_LIFE" : "FINITE_LIFE",
        acquisitionDate: String(formData.get("acquisitionDate")),
        inServiceOn: String(formData.get("inServiceOn")),
        cost: String(formData.get("cost")),
        residualValue: String(formData.get("residualValue") || "0"),
        ...(indefinite ? {} : category.kind === "PREPAID"
          ? { scheduleEndOn: String(formData.get("scheduleEndOn")) }
          : { usefulLifeMonths: Number(formData.get("usefulLifeMonths")) }),
        recognitionFrequency: "MONTHLY",
        sourceReference: String(formData.get("sourceReference") || "Manual asset register entry"),
        idempotencyKey: crypto.randomUUID(),
      });
      setFeedback({ kind: "success", message: "Register record and deterministic schedule created." }); router.refresh();
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Asset creation failed." }); }
    finally { setBusy(null); }
  }

  async function draftSchedule(id: string) {
    setBusy(id); setFeedback(null);
    try {
      await postJson(`/api/assets/schedules/${encodeURIComponent(id)}/draft`, { idempotencyKey: id });
      setFeedback({ kind: "success", message: "Balanced journal draft created. Review and post it in General ledger." }); router.refresh();
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Schedule journal failed." }); }
    finally { setBusy(null); }
  }

  async function submitLifecycle(formData: FormData) {
    const assetId = String(formData.get("assetId"));
    setBusy("lifecycle"); setFeedback(null);
    try {
      const amount = String(formData.get("amount") || "").trim();
      await postJson(`/api/assets/${encodeURIComponent(assetId)}/lifecycle`, {
        eventType: String(formData.get("eventType")),
        effectiveOn: String(formData.get("effectiveOn")),
        ...(amount ? { amount } : {}),
        reason: String(formData.get("reason")),
        idempotencyKey: crypto.randomUUID(),
      });
      setFeedback({ kind: "success", message: "Lifecycle evidence and any required balanced journal draft were created." }); router.refresh();
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Lifecycle update failed." }); }
    finally { setBusy(null); }
  }

  return <>
    {feedback && <MutationFeedback {...feedback} onDismiss={() => setFeedback(null)} />}
    <section className="metric-grid" aria-label="Asset register overview">
      {(["TANGIBLE", "INTANGIBLE", "PREPAID"] as const).map((kind) => <article className="metric-card" key={kind}>
        <p>{kind === "TANGIBLE" ? "Tangible assets" : kind === "INTANGIBLE" ? "Intangible assets" : "Prepaid expenses"}</p>
        <div><strong>{workspace.assets.filter((asset) => asset.kind === kind).length}</strong></div>
        <span>{workspace.schedules.filter((line) => workspace.assets.find((asset) => asset.id === line.assetId)?.kind === kind && line.status === "DUE").length} schedule entries due</span>
      </article>)}
    </section>

    {workspace.canDraftSchedules && workspace.assets.some((asset) => !["DISPOSED", "RETIRED", "TERMINATED"].includes(asset.status)) && <CompactDisclosure summary="Record a lifecycle event"><section className="panel" aria-labelledby="asset-lifecycle-title">
      <div className="panel-heading"><div><p className="eyebrow">Controlled adjustments</p><h2 id="asset-lifecycle-title">Record a lifecycle event</h2></div></div>
      <form className="settings-form" action={(data) => void submitLifecycle(data)}>
        <label><span>Register record</span><select name="assetId" required>{workspace.assets.filter((asset) => !["DISPOSED", "RETIRED", "TERMINATED"].includes(asset.status)).map((asset) => <option key={asset.id} value={asset.id}>{asset.assetNumber} · {asset.displayName}</option>)}</select></label>
        <label><span>Event</span><select name="eventType"><option value="IMPAIRED">Impairment</option><option value="TRANSFERRED">Transfer (history only)</option><option value="DISPOSED">Disposal</option><option value="RETIRED">Retirement</option><option value="TERMINATED">Early termination</option><option value="ADJUSTED">Adjustment</option><option value="REVERSED">Adjustment reversal</option></select></label>
        <label><span>Effective date</span><input name="effectiveOn" type="date" required /></label>
        <label><span>Amount (required for impairment/adjustment)</span><input name="amount" inputMode="decimal" /></label>
        <label><span>Permanent reason</span><input name="reason" required minLength={5} maxLength={500} /></label>
        <button className="primary-button" disabled={busy !== null}>{busy === "lifecycle" ? "Recording…" : "Record lifecycle event"}</button>
      </form>
    </section></CompactDisclosure>}

    <section className="panel" aria-labelledby="asset-register-title">
      <div className="panel-heading"><div><p className="eyebrow">Register-to-GL roll-forward</p><h2 id="asset-register-title">Asset and prepaid register</h2></div><span className="attention-count">{workspace.assets.length}</span></div>
      {workspace.assets.length ? <div className="table-scroll" tabIndex={0}><table>
        <thead><tr><th>Record</th><th>Category</th><th>Lifecycle</th><th>Cost</th><th>Recognized</th><th>Remaining</th></tr></thead>
        <tbody>{workspace.assets.map((asset) => <tr key={asset.id}>
          <td><strong>{asset.assetNumber} · {asset.displayName}</strong><small>{asset.acquisitionDate} · in service {asset.inServiceOn}</small></td>
          <td>{asset.categoryCode}<small>{asset.categoryName} · {asset.kind}</small></td>
          <td>{asset.status}<small>{asset.classification.replaceAll("_", " ")}</small></td>
          <td className="amount-cell">{asset.currency} {asset.cost}</td>
          <td className="amount-cell">{asset.currency} {asset.recognizedToDate}</td>
          <td className="amount-cell">{asset.currency} {asset.remainingBalance}</td>
        </tr>)}</tbody>
      </table></div> : <p className="panel-note">No asset or prepaid records yet.</p>}
    </section>

    <section className="panel" aria-labelledby="asset-reconciliation-title">
      <div className="panel-heading"><div><p className="eyebrow">Control account proof</p><h2 id="asset-reconciliation-title">Register-to-GL reconciliation</h2></div></div>
      {workspace.reconciliation.length ? <div className="table-scroll" tabIndex={0}><table>
        <thead><tr><th>Category</th><th>Gross register</th><th>Posted recognition</th><th>Register net</th><th>GL net</th><th>Variance</th></tr></thead>
        <tbody>{workspace.reconciliation.map((row) => <tr key={row.categoryId}>
          <td><strong>{row.categoryCode}</strong><small>{row.categoryName}</small></td>
          <td className="amount-cell">{row.currency} {row.grossCost}</td>
          <td className="amount-cell">{row.currency} {row.recognized}</td>
          <td className="amount-cell">{row.currency} {row.registerNet}</td>
          <td className="amount-cell">{row.currency} {row.glNet}</td>
          <td className="amount-cell">{row.currency} {row.variance}</td>
        </tr>)}</tbody>
      </table></div> : <p className="panel-note">Create a mapped category to begin register-to-GL reconciliation.</p>}
    </section>

    <section className="panel" aria-labelledby="asset-schedule-title">
      <div className="panel-heading"><div><p className="eyebrow">Period recognition</p><h2 id="asset-schedule-title">Depreciation, amortization and prepaid schedules</h2></div><span className="attention-count">{workspace.schedules.length}</span></div>
      {workspace.schedules.length ? <div className="table-scroll" tabIndex={0}><table>
        <thead><tr><th>Asset</th><th>Coverage</th><th>Due</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{workspace.schedules.map((line) => <tr key={line.id}>
          <td><strong>{line.assetNumber}</strong><small>Period {line.sequenceNumber}</small></td>
          <td>{line.periodStartOn} – {line.periodEndOn}</td><td>{line.dueOn}</td><td className="amount-cell">{line.amount}</td><td>{line.status}</td>
          <td>{line.status === "DUE" && workspace.canDraftSchedules
            ? <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void draftSchedule(line.id)}>{busy === line.id ? "Creating…" : "Create journal draft"}</button>
            : line.journalEntryId ? <a className="text-link" href={`/app/journals/${line.journalEntryId}`}>Open journal</a> : "—"}</td>
        </tr>)}</tbody>
      </table></div> : <p className="panel-note">Indefinite-life intangibles intentionally have no automatic amortization schedule.</p>}
    </section>

    {workspace.canDraftSchedules && activeCategories.length > 0 && <CompactDisclosure summary="Create an asset or prepaid"><section className="panel" aria-labelledby="new-asset-title">
      <div className="panel-heading"><div><p className="eyebrow">New register item</p><h2 id="new-asset-title">Create an asset or prepaid</h2></div></div>
      <form className="settings-form" action={(data) => void submitAsset(data)}>
        <label><span>Category</span><select name="categoryId" required>{activeCategories.map((category) => <option key={category.id} value={category.id}>{category.kind} · {category.code} · {category.displayName}</option>)}</select></label>
        <label><span>Asset number</span><input name="assetNumber" required maxLength={40} /></label>
        <label><span>Name</span><input name="displayName" required maxLength={200} /></label>
        <label><span>Classification</span><select name="classification"><option value="FINITE_LIFE">Finite life</option><option value="INDEFINITE_LIFE">Indefinite-life intangible</option></select></label>
        <label><span>Acquisition date</span><input name="acquisitionDate" type="date" required /></label>
        <label><span>In-service / recognition start</span><input name="inServiceOn" type="date" required /></label>
        <label><span>Prepaid end date</span><input name="scheduleEndOn" type="date" /></label>
        <label><span>Useful life (months)</span><input name="usefulLifeMonths" type="number" min="1" max="1200" defaultValue="36" /></label>
        <label><span>Cost</span><input name="cost" inputMode="decimal" required /></label>
        <label><span>Residual value</span><input name="residualValue" inputMode="decimal" defaultValue="0" /></label>
        <label><span>Source reference</span><input name="sourceReference" maxLength={200} /></label>
        <button className="primary-button" disabled={busy !== null}>{busy === "asset" ? "Creating…" : "Create register record"}</button>
      </form>
    </section></CompactDisclosure>}

    {workspace.canManageCategories && workspace.accounts.length > 0 && <CompactDisclosure summary="Configure an asset category"><section className="panel" aria-labelledby="asset-category-title">
      <div className="panel-heading"><div><p className="eyebrow">Account mappings</p><h2 id="asset-category-title">Create a category</h2></div></div>
      <form className="settings-form" action={(data) => void submitCategory(data)}>
        <input type="hidden" name="legalEntityId" value={categoryAccounts[0]?.legalEntityId ?? ""} />
        <input type="hidden" name="ledgerId" value={categoryAccounts[0]?.ledgerId ?? ""} />
        <label><span>Company ledger</span><select value={selectedLedgerId} onChange={(event) => setSelectedLedgerId(event.target.value)}>{ledgerScopes.map((scope) => <option key={scope.ledgerId} value={scope.ledgerId}>{scope.entityCode} · {scope.ledgerCode}</option>)}</select></label>
        <label><span>Kind</span><select name="kind"><option value="TANGIBLE">Tangible</option><option value="INTANGIBLE">Intangible</option><option value="PREPAID">Prepaid</option></select></label>
        <label><span>Code</span><input name="code" required maxLength={30} /></label>
        <label><span>Name</span><input name="displayName" required maxLength={160} /></label>
        <label><span>Permanent reason</span><input name="reason" required minLength={8} maxLength={500} /></label>
        {(["costAccountCombinationId", "contraAccountCombinationId", "expenseAccountCombinationId", "impairmentAccountCombinationId", "disposalAccountCombinationId"] as const).map((name) => <label key={name}><span>{name === "costAccountCombinationId" ? "Cost / prepaid account" : name === "contraAccountCombinationId" ? "Accumulated depreciation / amortization" : name === "expenseAccountCombinationId" ? "Recognition expense account" : name === "impairmentAccountCombinationId" ? "Impairment expense account" : "Disposal expense account"}</span><select name={name} required={["costAccountCombinationId", "expenseAccountCombinationId"].includes(name)}><option value="">Not applicable</option>{categoryAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.displayName} · {account.class}</option>)}</select></label>)}
        <button className="primary-button" disabled={busy !== null}>{busy === "category" ? "Creating…" : "Create category"}</button>
      </form>
    </section></CompactDisclosure>}
  </>;
}
