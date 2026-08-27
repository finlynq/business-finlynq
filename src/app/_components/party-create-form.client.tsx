"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PartyAccountCreationOptionDto } from "@/modules/parties/party-workspace";

type PartySaveResult = Readonly<{
  party: Readonly<{ id: string; partyNumber: string; displayName: string }>;
  partyAccount: Readonly<{ role: "CUSTOMER" | "SUPPLIER"; accountNumber: string }>;
  idempotentReplay: boolean;
}>;

function optionKey(option: PartyAccountCreationOptionDto): string {
  return [option.legalEntityId, option.ledgerId, option.role, option.controlAccountId].join(":");
}

export function PartyCreateForm({
  accountOptions,
}: Readonly<{ accountOptions: readonly PartyAccountCreationOptionDto[] }>) {
  const router = useRouter();
  const [partyNumber, setPartyNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [transactionCurrency, setTransactionCurrency] = useState("");
  const [selectedOptionKey, setSelectedOptionKey] = useState(
    accountOptions[0] ? optionKey(accountOptions[0]) : "",
  );
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  const changeCommand = () => {
    setMessage(null);
    setIdempotencyKey("");
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const normalizedNumber = partyNumber.trim().toUpperCase();
    const normalizedName = displayName.trim();
    const normalizedAccountNumber = accountNumber.trim().toUpperCase();
    const normalizedCurrency = transactionCurrency.trim().toUpperCase();
    const accountOption = accountOptions.find((option) => optionKey(option) === selectedOptionKey);
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalizedNumber) ||
        !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalizedAccountNumber) ||
        !normalizedName || !accountOption || (normalizedCurrency && !/^[A-Z]{3}$/.test(normalizedCurrency))) {
      setMessage({ kind: "error", text: "Enter valid party and account numbers, then select an available AR/AP setup." });
      return;
    }
    const requestKey = idempotencyKey || crypto.randomUUID();
    setIdempotencyKey(requestKey);
    setBusy(true);
    try {
      const response = await fetch("/api/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyNumber: normalizedNumber,
          displayName: normalizedName,
          idempotencyKey: requestKey,
          account: {
            legalEntityId: accountOption.legalEntityId,
            ledgerId: accountOption.ledgerId,
            role: accountOption.role,
            accountNumber: normalizedAccountNumber,
            controlAccountId: accountOption.controlAccountId,
            transactionCurrency: normalizedCurrency || null,
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<PartySaveResult> & { error?: unknown };
      if (!response.ok || !payload.party || !payload.partyAccount) {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string" ? payload.error : "The party could not be saved.",
        });
        return;
      }
      setMessage({
        kind: "success",
        text: `${payload.party.partyNumber} was saved with an active ${payload.partyAccount.role.toLowerCase()} account ${payload.partyAccount.accountNumber}.`,
      });
      setPartyNumber("");
      setDisplayName("");
      setAccountNumber("");
      setTransactionCurrency("");
      setIdempotencyKey("");
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "The save result is unknown. Retry without changing the form to reuse its idempotency key." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel form-panel" aria-labelledby="new-party-title">
      <div className="panel-heading"><div><p className="eyebrow">Encrypted master data</p><h2 id="new-party-title">Create a party</h2></div></div>
      <form className="close-form" onSubmit={save} noValidate>
        <div className="form-grid form-grid-three">
          <label>
            <span>Party number</span>
            <input value={partyNumber} onChange={(event) => { setPartyNumber(event.target.value); changeCommand(); }} maxLength={32} autoComplete="off" disabled={busy} placeholder="CUST-1001" />
            <small>Letters, numbers, underscores, and hyphens.</small>
          </label>
          <label>
            <span>Display name</span>
            <input value={displayName} onChange={(event) => { setDisplayName(event.target.value); changeCommand(); }} maxLength={200} autoComplete="organization" disabled={busy} placeholder="Customer or supplier name" />
          </label>
          <label>
            <span>Customer or supplier setup</span>
            <select value={selectedOptionKey} onChange={(event) => { setSelectedOptionKey(event.target.value); changeCommand(); }} disabled={busy || accountOptions.length === 0} required>
              {accountOptions.length === 0 && <option value="">No configured AR/AP control account</option>}
              {accountOptions.map((option) => (
                <option key={optionKey(option)} value={optionKey(option)}>
                  {option.entityCode} · {option.role === "CUSTOMER" ? "Customer" : "Supplier"} · {option.controlAccountCode} {option.controlAccountName}
                </option>
              ))}
            </select>
            <small>The legal entity, primary ledger, and matching control account are bound together.</small>
          </label>
          <label>
            <span>AR/AP account number</span>
            <input value={accountNumber} onChange={(event) => { setAccountNumber(event.target.value); changeCommand(); }} maxLength={32} autoComplete="off" disabled={busy} placeholder="C-CA-1001" />
          </label>
          <label>
            <span>Currency restriction (optional)</span>
            <input value={transactionCurrency} onChange={(event) => { setTransactionCurrency(event.target.value); changeCommand(); }} maxLength={3} autoComplete="off" disabled={busy} placeholder="Any currency" />
            <small>Leave blank for multi-currency transactions, or enter an active ISO code.</small>
          </label>
        </div>
        {accountOptions.length === 0 && <p className="validation-message validation-error" role="alert">Create an active AR or AP control account combination before adding a customer or supplier.</p>}
        {message && <p className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        <div className="form-actions"><button type="submit" className="primary-button" disabled={busy || accountOptions.length === 0}>{busy ? "Saving…" : "Create encrypted party and account"}</button></div>
      </form>
    </section>
  );
}
