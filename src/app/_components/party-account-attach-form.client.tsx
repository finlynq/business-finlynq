"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { PartyAccountCreationOptionDto } from "@/modules/parties/party-workspace";
import styles from "./party-directory.module.css";

type PartyAccountSaveResult = Readonly<{
  partyAccount: Readonly<{
    role: "CUSTOMER" | "SUPPLIER";
    accountNumber: string;
  }>;
  idempotentReplay: boolean;
}>;

function optionKey(option: PartyAccountCreationOptionDto): string {
  return [option.legalEntityId, option.ledgerId, option.role, option.controlAccountId].join(":");
}

export function PartyAccountAttachForm({
  partyId,
  partyName,
  accountOptions,
}: Readonly<{
  partyId: string;
  partyName: string;
  accountOptions: readonly PartyAccountCreationOptionDto[];
}>) {
  const router = useRouter();
  const [selectedOptionKey, setSelectedOptionKey] = useState(
    accountOptions[0] ? optionKey(accountOptions[0]) : "",
  );
  const [accountNumber, setAccountNumber] = useState("");
  const [transactionCurrency, setTransactionCurrency] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{
    kind: "success" | "error";
    text: string;
  }> | null>(null);

  function changeCommand(): void {
    setMessage(null);
    setIdempotencyKey("");
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    const option = accountOptions.find((candidate) => optionKey(candidate) === selectedOptionKey);
    const normalizedAccountNumber = accountNumber.trim().toUpperCase();
    const normalizedCurrency = transactionCurrency.trim().toUpperCase();
    if (!option || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalizedAccountNumber) ||
        (normalizedCurrency && !/^[A-Z]{3}$/.test(normalizedCurrency))) {
      setMessage({
        kind: "error",
        text: "Select an entity role and enter a valid account number and optional ISO currency.",
      });
      return;
    }

    const requestKey = idempotencyKey || globalThis.crypto.randomUUID();
    setIdempotencyKey(requestKey);
    setBusy(true);
    try {
      const response = await fetch(`/api/parties/${encodeURIComponent(partyId)}/accounts`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: requestKey,
          account: {
            legalEntityId: option.legalEntityId,
            ledgerId: option.ledgerId,
            role: option.role,
            accountNumber: normalizedAccountNumber,
            controlAccountId: option.controlAccountId,
            transactionCurrency: normalizedCurrency || null,
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<PartyAccountSaveResult> & {
        error?: unknown;
      };
      if (!response.ok || !payload.partyAccount) {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string" ? payload.error : "The entity role could not be attached.",
        });
        return;
      }
      setMessage({
        kind: "success",
        text: `${payload.partyAccount.role === "CUSTOMER" ? "Customer" : "Supplier"} account ${payload.partyAccount.accountNumber} is now attached to ${partyName}.`,
      });
      setAccountNumber("");
      setTransactionCurrency("");
      setIdempotencyKey("");
      router.refresh();
    } catch {
      setMessage({
        kind: "error",
        text: "The save result is unknown. Retry without changing the form to reuse its idempotency key.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.attachForm} onSubmit={(event) => { void save(event); }} noValidate>
      <label>
        <span>Legal entity and role</span>
        <select
          value={selectedOptionKey}
          onChange={(event) => {
            setSelectedOptionKey(event.target.value);
            changeCommand();
          }}
          disabled={busy || accountOptions.length === 0}
          required
        >
          {accountOptions.length === 0 && <option value="">No configured AR/AP control account</option>}
          {accountOptions.map((option) => (
            <option key={optionKey(option)} value={optionKey(option)}>
              {option.entityCode} · {option.role === "CUSTOMER" ? "Customer" : "Supplier"} · {option.controlAccountCode} {option.controlAccountName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>AR/AP account number</span>
        <input
          value={accountNumber}
          onChange={(event) => {
            setAccountNumber(event.target.value);
            changeCommand();
          }}
          maxLength={32}
          autoComplete="off"
          placeholder="C-US-1001"
          disabled={busy}
          required
        />
      </label>
      <label>
        <span>Currency restriction</span>
        <input
          value={transactionCurrency}
          onChange={(event) => {
            setTransactionCurrency(event.target.value);
            changeCommand();
          }}
          maxLength={3}
          autoComplete="off"
          placeholder="Any currency"
          disabled={busy}
        />
      </label>
      <button className="primary-button compact-button" type="submit" disabled={busy || accountOptions.length === 0}>
        {busy ? "Attaching…" : "Attach entity role"}
      </button>
      {message && (
        <p
          className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"} ${styles.attachMessage}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
