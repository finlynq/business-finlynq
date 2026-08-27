"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type PartySaveResult = Readonly<{
  party: Readonly<{ id: string; partyNumber: string; displayName: string }>;
  idempotentReplay: boolean;
}>;

export function PartyCreateForm() {
  const router = useRouter();
  const [partyNumber, setPartyNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
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
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalizedNumber) || !normalizedName) {
      setMessage({ kind: "error", text: "Enter a valid party number and display name." });
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
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<PartySaveResult> & { error?: unknown };
      if (!response.ok || !payload.party) {
        setMessage({
          kind: "error",
          text: typeof payload.error === "string" ? payload.error : "The party could not be saved.",
        });
        return;
      }
      setMessage({ kind: "success", text: `${payload.party.partyNumber} was saved with encrypted master data.` });
      setPartyNumber("");
      setDisplayName("");
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
        </div>
        {message && <p className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Create encrypted party"}</button></div>
      </form>
    </section>
  );
}
