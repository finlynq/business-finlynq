"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SubledgerWorkspaceDto } from "@/modules/subledger/workspace";

export function SupplierCreditApplicationPanel({ workspace }: { workspace: SubledgerWorkspaceDto }) {
  const router = useRouter();
  const credits = workspace.openItems.filter((item) => item.sourceType === "payables.supplier-credit-note");
  const [creditId, setCreditId] = useState(credits[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const credit = credits.find((item) => item.id === creditId);
  const bills = workspace.openItems.filter((item) => item.sourceType !== "payables.supplier-credit-note"
    && item.partyAccountId === credit?.partyAccountId && item.ledgerId === credit?.ledgerId && item.currency === credit?.currency);
  const entity = workspace.entities.find((item) => item.ledgerId === credit?.ledgerId);
  const party = entity?.partyAccounts.find((item) => item.id === credit?.partyAccountId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credit || !entity || !party) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/payables/credit-applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "SUPPLIER_CREDIT_APPLICATION", sourceNumber: form.get("sourceNumber"), ledgerId: entity.ledgerId,
        legalEntityId: entity.id, partyAccountId: party.id, controlAccountCombinationId: party.controlAccountCombinationId,
        periodId: form.get("periodId"), accountingDate: form.get("accountingDate"), currency: credit.currency,
        creditOpenItemId: credit.id, billOpenItemId: form.get("billOpenItemId"), amount: form.get("amount"),
        realizedFxGainAccountCombinationId: form.get("gainAccount"), realizedFxLossAccountCombinationId: form.get("lossAccount"),
        description: form.get("description"), idempotencyKey: globalThis.crypto.randomUUID(),
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The supplier credit could not be applied.");
      setMessage("Supplier credit applied. Both balances have been updated.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Credit application failed."); }
    finally { setBusy(false); }
  }
  if (!credits.length) return null;
  return <details className="panel"><summary>Apply supplier credit to a bill</summary>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <form onSubmit={(event) => void submit(event)} className="form-grid">
      <label className="field"><span>Supplier credit</span><select value={creditId} onChange={(event) => setCreditId(event.target.value)} required>
        {credits.map((item) => <option key={item.id} value={item.id}>{item.sourceNumber} · {item.partyName} · {item.currency} {item.openAmount}</option>)}
      </select></label>
      <label className="field"><span>Bill</span><select name="billOpenItemId" key={creditId} required>
        <option value="">Select a bill</option>{bills.map((item) => <option key={item.id} value={item.id}>{item.sourceNumber} · {item.currency} {item.openAmount}</option>)}
      </select></label>
      <label className="field"><span>Application reference</span><input name="sourceNumber" required maxLength={50} /></label>
      <label className="field"><span>Amount to apply ({credit?.currency})</span><input name="amount" inputMode="decimal" required pattern="[0-9]+([.][0-9]+)?" /></label>
      <label className="field"><span>Accounting date</span><input name="accountingDate" type="date" defaultValue={workspace.currentDate} required /></label>
      <label className="field"><span>Open period</span><select name="periodId" required key={entity?.id} defaultValue={entity?.periods.find((period) => period.startsOn <= workspace.currentDate && period.endsOn >= workspace.currentDate)?.id}>
        {entity?.periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
      </select></label>
      <label className="field"><span>Realized FX gain account</span><select name="gainAccount" required>{entity?.fxGainAccounts.map((account) => <option key={account.combinationId} value={account.combinationId}>{account.code} · {account.displayName}</option>)}</select></label>
      <label className="field"><span>Realized FX loss account</span><select name="lossAccount" required>{entity?.fxLossAccounts.map((account) => <option key={account.combinationId} value={account.combinationId}>{account.code} · {account.displayName}</option>)}</select></label>
      <label className="field"><span>Description</span><input name="description" required maxLength={500} /></label>
      <button className="primary-button" disabled={busy || !bills.length} type="submit">{busy ? "Applying…" : "Apply credit"}</button>
      <p>Any unused credit stays available. Reverse an application from the transaction register before voiding the credit.</p>
    </form>
  </details>;
}
