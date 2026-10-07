"use client";
import { useState, type FormEvent } from "react";
import type { getStorageSetup } from "@/modules/document-storage/setup";
import { MutationFeedback } from "./mutation-feedback.client";

type Setup = Awaited<ReturnType<typeof getStorageSetup>>;
export function StorageSetupApproval({ initial }: { initial: Setup }) {
  const [setup, setSetup] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/document-storage/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        connectionId: setup.connectionId, expectedSetupHash: setup.expectedSetupHash,
        accessAcknowledged: data.get("access") === "on", sharedWithOrganization: data.get("shared") === "on",
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Setup could not be completed. Retry this request.");
      if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
      else setSetup(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Setup could not be completed."); }
    finally { setBusy(false); }
  }
  return <section className="panel form-panel" aria-labelledby="storage-setup-title">
    <h2 id="storage-setup-title">{setup.label}</h2>
    <p>{setup.company} · {setup.module === "receivables" ? "Sales invoices" : "Purchases and expenses"} · OneDrive</p>
    <p>{setup.access.description}</p>
    {setup.status === "READY" ? <>
      <p role="status">Storage is ready. Your agent can continue using this connection.</p>
      <div className="document-actions">
        {setup.inboxUrl && <a className="secondary-button" href={setup.inboxUrl} target="_blank" rel="noopener noreferrer">Open inbox folder</a>}
        {setup.archiveUrl && <a className="secondary-button" href={setup.archiveUrl} target="_blank" rel="noopener noreferrer">Open archive</a>}
      </div>
    </> : <form className="close-form" onSubmit={(event) => void approve(event)}>
      <p className="full-field">{setup.reuseConnectionId ? "FinLynQ will first try your existing OneDrive app-folder authorization. If it has expired, Microsoft will ask you to sign in again." : "After approval, Microsoft will ask you to authorize the FinLynQ application folder."} A separate Inbox and Archive will be created for this connection.</p>
      <label className="full-field document-sharing-consent"><input type="checkbox" name="access" required disabled={busy} /><span>I understand the app-folder access and authorize this Inbox/Archive workflow.</span></label>
      <label className="full-field document-sharing-consent"><input type="checkbox" name="shared" required disabled={busy} /><span>I authorize colleagues with access to {setup.company}’s {setup.module === "receivables" ? "sales" : "purchases"} module to read and process files in this inbox.</span></label>
      <button className="primary-button" disabled={busy}>{busy ? "Connecting…" : "Approve sharing and continue"}</button>
      <p className="panel-note full-field">This approval applies to the company and module shown above. Return here to retry if authorization expires.</p>
    </form>}
    {error && <MutationFeedback kind="error" message={error} onDismiss={() => setError("")} />}
  </section>;
}
