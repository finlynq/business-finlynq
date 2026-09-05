"use client";
import { useState, type FormEvent } from "react";
import type { listStorageConnections } from "@/modules/document-storage/connections";
import type { listDocumentInbox } from "@/modules/document-storage/inbox";
import type { StorageProvider } from "@/modules/document-storage/model";
import { storageAccessPolicy } from "@/modules/document-storage/access-policy";

type Connection = Awaited<ReturnType<typeof listStorageConnections>>[number];
type Inbox = Awaited<ReturnType<typeof listDocumentInbox>>;
const providerLabel = (provider: string) => provider === "GOOGLE_DRIVE" ? "Google Drive" : "OneDrive";
const statusLabel: Record<string, string> = { PENDING: "Ready to process", CLAIMED: "Being processed", NEEDS_REVIEW: "Needs review", READY_TO_FILE: "Ready to file", FILED: "Filed", FILING_FAILED: "Filing needs attention" };
const connectionErrors: Readonly<Record<string, string>> = {
  failed: "The connection was not completed. Start again and grant the requested access.",
  "original-account": "Reconnect the original cloud account. Existing attachment locations cannot be replaced with another account.",
  "folder-unavailable": "The saved connection folder is missing or outside its authorized location. Restore it in your drive and reconnect the original account.",
  "authorization-expired": "The authorization request expired or access was revoked. Start a fresh connection request with the original account.",
  "unsupported-access": "New Google connections are unavailable because Google does not provide the required folder-only authorization for automatic inbox discovery.",
  "excessive-access": "Microsoft returned broader file access than this integration supports. Remove the previous FinLynQ app grant in Microsoft and reconnect with app-folder access only. Removing the grant may affect your other FinLynQ connections.",
};
export function DocumentInbox({ initialConnections, initialInbox, entities, permissions, providers, initialOutcome }: {
  initialOutcome?: string;
  initialConnections: Connection[]; initialInbox: Inbox; entities: { id: string; display_name: string }[];
  permissions: { admin: boolean; payables: boolean; receivables: boolean }; providers: { provider: StorageProvider; configured: boolean }[];
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [inbox, setInbox] = useState(initialInbox);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(initialOutcome === "connected" ? "Storage connected. Open the inbox folder to add your documents." : ""); const [error, setError] = useState(initialOutcome && Object.hasOwn(connectionErrors, initialOutcome) ? connectionErrors[initialOutcome] : "");
  const [filter, setFilter] = useState(""); const [connectionFilter, setConnectionFilter] = useState("");
  const [provider, setProvider] = useState<StorageProvider>("ONEDRIVE");
  const [reconnectConsent, setReconnectConsent] = useState<Record<string, boolean>>({});
  const canManage = (connection: Connection) => permissions[connection.module];
  async function request(action: string, input: unknown) {
    const response = await fetch("/api/document-storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, input }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "The request failed.");
    return result;
  }
  async function refresh(status = filter, connectionId = connectionFilter, before?: string) {
    const query = new URLSearchParams(); if (status) query.set("status", status); if (connectionId) query.set("connectionId", connectionId); if (before) query.set("before", before);
    const response = await fetch(`/api/document-storage?${query}`, { cache: "no-store" }); const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not refresh the inbox.");
    setConnections(result.connections); setInbox((previous) => ({ items: before ? [...previous.items, ...result.items] : result.items, nextCursor: result.nextCursor }));
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "The request failed."); }
    finally { setBusy(false); }
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await perform(async () => {
      const result = await request("connect", { provider, legalEntityId: data.get("entity"), module: data.get("module"), label: data.get("label"), sharedWithOrganization: data.get("shared") === "on", accessAcknowledged: data.get("access") === "on" });
      window.location.assign(result.authorizationUrl);
    });
  }
  async function upload(connectionId: string, file: File) {
    await perform(async () => {
      const fileExtension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1].toLowerCase() ?? "";
      const fallbackMimeType: Record<string, string> = {
        pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      const mimeType = file.type || fallbackMimeType[fileExtension];
      if (!file.size || file.size > 2 * 1024 * 1024 || !fallbackMimeType[fileExtension] || !mimeType) throw new Error("Choose a PDF, PNG, JPEG, CSV, TSV, TXT, XLS, or XLSX file of up to 2 MiB.");
      const buffer = await file.arrayBuffer(); const bytes = new Uint8Array(buffer);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))).map((v) => v.toString(16).padStart(2, "0")).join("");
      const nameHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.name)))).map((v) => v.toString(16).padStart(2, "0")).join("");
      let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await request("upload", { connectionId, filename: file.name, mimeType, byteSize: file.size, sha256, contentBase64: btoa(binary), idempotencyKey: `browser:${nameHash}:${sha256}` });
      await refresh(); setMessage("Uploaded to your cloud inbox. Ask your connected AI client to process it.");
    });
  }
  return <>
    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">Processing</p><h2>Use your connected AI client</h2></div></div>
      <p>Ask Codex or ChatGPT: “Sync my FinLynQ document inbox, read each invoice, create the appropriate drafts, and file the originals. Send uncertain items for review.”</p>
      <p className="panel-note">Files stay in your drive. FinLynQ stores attachment details and accounting records. Processing uses your AI client; no AI API key is required here. Filing a document does not post or pay its invoice.</p>
    </section>
    {error && <p role="alert" className="panel-note">{error}</p>}{message && <p role="status" className="panel-note">{message}</p>}
    {permissions.admin && <section className="panel form-panel"><div className="panel-heading"><h2>Connect document storage</h2></div>
      <form className="close-form" onSubmit={(event) => { void connect(event); }}>
        <label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value as StorageProvider)}>{providers.map((p) => <option key={p.provider} value={p.provider}>{providerLabel(p.provider)}{!p.configured ? " — unavailable" : ""}</option>)}</select></label>
        <label><span>Company</span><select name="entity" required>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.display_name}</option>)}</select></label>
        <label><span>Documents for</span><select name="module"><option value="payables">Purchases and expenses</option><option value="receivables">Sales invoices</option></select></label>
        <label><span>Connection name</span><input name="label" required maxLength={100} placeholder="Company purchases" /></label>
        <p className="panel-note full-field">{storageAccessPolicy(provider).newConnections ? storageAccessPolicy(provider).description : storageAccessPolicy(provider).limitation}</p>
        {storageAccessPolicy(provider).newConnections && <>
          <p className="panel-note full-field">{storageAccessPolicy(provider).limitation} FinLynQ creates a separate connection folder containing Inbox and Archive. Add documents directly to Inbox; files already elsewhere stay where they are. Processing moves only completed originals into Archive, organized by year, month, and document type.</p>
          <label className="full-field document-sharing-consent"><input type="checkbox" name="access" required /><span>I understand the app-folder access and authorize this Inbox/Archive workflow.</span></label>
        </>}
        <label className="full-field document-sharing-consent"><input type="checkbox" name="shared" required /><span>I authorize colleagues with access to this company’s selected accounting module to read and process files in this inbox.</span></label>
        <button className="primary-button" disabled={busy || !entities.length || !storageAccessPolicy(provider).newConnections || !providers.find((p) => p.provider === provider)?.configured}>Connect {providerLabel(provider)}</button>
        {storageAccessPolicy(provider).newConnections && !providers.find((p) => p.provider === provider)?.configured && <p className="panel-note">FinLynQ’s connection to {providerLabel(provider)} is not enabled yet. Once available, you can sign in with your own account here.</p>}
      </form>
    </section>}
    <section className="panel"><div className="panel-heading"><h2>Connected folders</h2></div>
      {!connections.length && <p>No storage connections yet. An organization administrator can connect a drive above.</p>}
      {connections.map((connection) => <div className="document-connection" key={connection.id}>
        <h3>{connection.label} · {providerLabel(connection.provider)}</h3><p>{entities.find((entity) => entity.id === connection.legalEntityId)?.display_name} · {connection.module === "payables" ? "Purchases" : "Sales"} · {connection.active ? "Connected" : "Disconnected"}</p>
        <p className="panel-note">{connection.access.description}</p>
        {permissions.admin && <label className="document-sharing-consent"><input type="checkbox" checked={Boolean(reconnectConsent[connection.id])} onChange={(event) => setReconnectConsent({ ...reconnectConsent, [connection.id]: event.target.checked })} /><span>When reconnecting, I authorize the access described above and continued sharing with this company’s accounting module. Use the original account; the saved folder locations will be retained.</span></label>}
        <div className="document-actions">
          {connection.inboxUrl && <a className="secondary-button" href={connection.inboxUrl} target="_blank" rel="noopener noreferrer">Open inbox folder</a>}
          {connection.archiveUrl && <a className="secondary-button" href={connection.archiveUrl} target="_blank" rel="noopener noreferrer">Open archive</a>}
          {connection.active && canManage(connection) && <>
            <button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { const result = await request("sync", { connectionId: connection.id }); await refresh(); setMessage(result.hasMore ? "More files are available. Sync again to continue." : "Inbox sync complete."); })}>Sync inbox</button>
            <label className="secondary-button">Upload document<input type="file" accept=".pdf,.png,.jpg,.jpeg,.csv,.tsv,.txt,.xls,.xlsx" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void upload(connection.id, file); }} /></label>
          </>}
          {permissions.admin && <>
            <button className="secondary-button" disabled={busy || !reconnectConsent[connection.id] || !providers.find((p) => p.provider === connection.provider)?.configured} onClick={() => void perform(async () => { const result = await request("connect", { provider: connection.provider, legalEntityId: connection.legalEntityId, module: connection.module, label: connection.label, connectionId: connection.id, sharedWithOrganization: true, accessAcknowledged: reconnectConsent[connection.id] }); window.location.assign(result.authorizationUrl); })}>Reconnect</button>
            {connection.active && <button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { await request("disconnect", { connectionId: connection.id }); await refresh(); setMessage("Disconnected. Files remain in the cloud account."); })}>Disconnect</button>}
          </>}
        </div><p className="panel-note">Last complete sync: {connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : "Not yet synced"}</p>
      </div>)}
    </section>
    <section className="panel"><div className="panel-heading"><h2>Documents</h2><button className="secondary-button" disabled={busy} onClick={() => void perform(() => refresh())}>Refresh</button></div>
      <div className="document-actions">
        <label>Status <select aria-label="Document status" value={filter} disabled={busy} onChange={(event) => { setFilter(event.target.value); void perform(() => refresh(event.target.value)); }}><option value="">All statuses</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Inbox <select aria-label="Document inbox filter" value={connectionFilter} disabled={busy} onChange={(event) => { setConnectionFilter(event.target.value); void perform(() => refresh(filter, event.target.value)); }}><option value="">All inboxes</option>{connections.map((c) => <option value={c.id} key={c.id}>{c.label}</option>)}</select></label>
      </div>
      <div className="table-scroll"><table><thead><tr><th>Document</th><th>Status</th><th>Details</th><th>Action</th></tr></thead><tbody>
        {inbox.items.map((item) => <tr key={item.id}><td>{item.canonicalName ?? item.filename}<p className="panel-note">{item.canonicalName ? item.filename : `${Math.ceil(item.byteSize / 1024)} KB`}{item.sourcePath !== item.filename ? ` · ${item.sourcePath}` : ""}</p></td><td>{statusLabel[item.status]}{item.leaseUntil && item.status === "CLAIMED" && <p className="panel-note">Claim until {new Date(item.leaseUntil).toLocaleTimeString()}</p>}</td><td>{item.reason ?? (item.sourceDocumentId ? "Linked to an accounting draft" : "")}</td><td>
          {permissions[item.module] && (item.status === "FILING_FAILED" || item.status === "READY_TO_FILE") && <button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { await request("retry", { itemId: item.id }); await refresh(); setMessage("Document filed."); })}>Retry filing</button>}
          {item.status === "NEEDS_REVIEW" && <span className="panel-note">Ask your AI client to review this item.</span>}
        </td></tr>)}
      </tbody></table></div>
      {!inbox.items.length && <p>No documents match this view. Add files to a connected inbox and sync it.</p>}
      {inbox.nextCursor && <button className="secondary-button" disabled={busy} onClick={() => void perform(() => refresh(filter, connectionFilter, inbox.nextCursor!))}>Load more</button>}
    </section>
  </>;
}
