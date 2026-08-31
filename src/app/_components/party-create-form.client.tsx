"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type PartySaveResult = Readonly<{
  party: Readonly<{ id: string; partyNumber: string; displayName: string }>;
  partyAccount: null;
  idempotentReplay: boolean;
}>;

type AddressDraft = Readonly<{
  kind: "BILLING" | "SHIPPING" | "REMIT_TO" | "REGISTERED";
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  validFrom: string;
}>;

const emptyAddress: AddressDraft = {
  kind: "BILLING",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  countryCode: "",
  validFrom: "",
};

export function PartyCreateForm() {
  const router = useRouter();
  const [partyNumber, setPartyNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [includeAddress, setIncludeAddress] = useState(false);
  const [address, setAddress] = useState<AddressDraft>(emptyAddress);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Readonly<{ kind: "success" | "error"; text: string }> | null>(null);

  const changeCommand = () => {
    setMessage(null);
    setIdempotencyKey("");
  };

  const updateAddress = (patch: Partial<AddressDraft>) => {
    setAddress((current) => ({ ...current, ...patch }));
    changeCommand();
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const normalizedNumber = partyNumber.trim().toUpperCase();
    const normalizedName = displayName.trim();
    const normalizedCountry = address.countryCode.trim().toUpperCase();
    const validAddress = !includeAddress || (
      Boolean(address.line1.trim()) && Boolean(address.city.trim()) && Boolean(address.region.trim()) &&
      Boolean(address.postalCode.trim()) && /^[A-Z]{2}$/.test(normalizedCountry) && Boolean(address.validFrom)
    );
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(normalizedNumber) || !normalizedName || !validAddress) {
      setMessage({ kind: "error", text: "Enter a valid party number and name, plus every required shared-address field when an address is included." });
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
          ...(includeAddress ? {
            address: {
              ...address,
              line1: address.line1.trim(),
              line2: address.line2.trim(),
              city: address.city.trim(),
              region: address.region.trim(),
              postalCode: address.postalCode.trim(),
              countryCode: normalizedCountry,
            },
          } : {}),
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
      setMessage({
        kind: "success",
        text: `${payload.party.partyNumber} was added once to the organization address book. Add customer or supplier accounting roles only where needed.`,
      });
      setPartyNumber("");
      setDisplayName("");
      setIncludeAddress(false);
      setAddress(emptyAddress);
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
      <div className="panel-heading"><div><p className="eyebrow">Organization-wide encrypted master</p><h2 id="new-party-title">Create an address-book party</h2></div></div>
      <form className="close-form" onSubmit={(event) => { void save(event); }} noValidate>
        <div className="form-grid form-grid-three">
          <label>
            <span>Party number</span>
            <input value={partyNumber} onChange={(event) => { setPartyNumber(event.target.value); changeCommand(); }} maxLength={32} autoComplete="off" disabled={busy} placeholder="PARTY-1001" required />
            <small>One organization-wide identifier; letters, numbers, underscores, and hyphens.</small>
          </label>
          <label>
            <span>Display name</span>
            <input value={displayName} onChange={(event) => { setDisplayName(event.target.value); changeCommand(); }} maxLength={200} autoComplete="organization" disabled={busy} placeholder="Person or business name" required />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={includeAddress} onChange={(event) => { setIncludeAddress(event.target.checked); changeCommand(); }} disabled={busy} />
            <span>Add a shared address now</span>
          </label>
        </div>
        {includeAddress && (
          <fieldset className="journal-line-card">
            <legend>Shared organization address</legend>
            <div className="form-grid form-grid-three">
              <label><span>Address type</span><select value={address.kind} onChange={(event) => updateAddress({ kind: event.target.value as AddressDraft["kind"] })} disabled={busy}><option value="BILLING">Billing</option><option value="SHIPPING">Shipping</option><option value="REMIT_TO">Remit to</option><option value="REGISTERED">Registered</option></select></label>
              <label><span>Address line 1</span><input value={address.line1} onChange={(event) => updateAddress({ line1: event.target.value })} maxLength={200} disabled={busy} required /></label>
              <label><span>Address line 2</span><input value={address.line2} onChange={(event) => updateAddress({ line2: event.target.value })} maxLength={200} disabled={busy} /></label>
              <label><span>City</span><input value={address.city} onChange={(event) => updateAddress({ city: event.target.value })} maxLength={100} disabled={busy} required /></label>
              <label><span>State / province / region</span><input value={address.region} onChange={(event) => updateAddress({ region: event.target.value })} maxLength={100} disabled={busy} required /></label>
              <label><span>Postal code</span><input value={address.postalCode} onChange={(event) => updateAddress({ postalCode: event.target.value })} maxLength={30} disabled={busy} required /></label>
              <label><span>Country code</span><input value={address.countryCode} onChange={(event) => updateAddress({ countryCode: event.target.value.toUpperCase() })} maxLength={2} placeholder="US" disabled={busy} required /></label>
              <label><span>Valid from</span><input type="date" value={address.validFrom} onChange={(event) => updateAddress({ validFrom: event.target.value })} disabled={busy} required /></label>
            </div>
          </fieldset>
        )}
        {message && <p className={`validation-message ${message.kind === "success" ? "validation-success" : "validation-error"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        <p className="form-footnote">This creates one shared party and encrypted address master. Entity, ledger, currency, and control-account settings are added later as accounting roles; they never duplicate the party.</p>
        <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Create shared party"}</button></div>
      </form>
    </section>
  );
}
