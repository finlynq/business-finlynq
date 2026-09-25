"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { MutationFeedback } from "@/app/_components/mutation-feedback.client";

export type PersonalInboundAlias = Readonly<{
  id: string;
  address: string;
  label: string;
  connectionId: string | null;
  status: "ACTIVE" | "DISABLED" | "RETIRED";
  version: number;
}>;

type ConnectionOption = Readonly<{
  id: string;
  label: string;
  module: "payables" | "receivables";
  active: boolean;
}>;

export function PersonalInboundAddress({
  initialAlias,
  connections,
}: {
  initialAlias: PersonalInboundAlias | null;
  connections: readonly ConnectionOption[];
}) {
  const activeConnections = connections.filter((connection) => connection.active);
  const [alias, setAlias] = useState(initialAlias);
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    initialAlias?.connectionId ?? activeConnections[0]?.id ?? "",
  );
  const [busy, setBusy] = useState<"provision" | "configure" | "rotate" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);

  async function request(body: Record<string, unknown>): Promise<PersonalInboundAlias> {
    const response = await fetch("/api/email/personal-alias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { alias?: PersonalInboundAlias; error?: string };
    if (!response.ok || !result.alias) throw new Error(result.error ?? "The email address request failed.");
    return result.alias;
  }

  async function perform(
    action: "provision" | "configure" | "rotate",
    body: Record<string, unknown>,
    success: string,
  ) {
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const updated = await request(body);
      setAlias(updated);
      setSelectedConnectionId(updated.connectionId ?? "");
      setMessage(success);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The email address request failed.");
    } finally {
      setBusy(null);
    }
  }

  async function copyAddress() {
    if (!alias) return;
    try {
      await navigator.clipboard.writeText(alias.address);
      setMessage("Personal inbound address copied.");
    } catch {
      addressRef.current?.focus();
      addressRef.current?.select();
      setMessage("Select Copy in your browser to copy the highlighted address.");
    }
  }

  function rotateAddress() {
    if (!alias || !window.confirm("Rotate this address? Messages sent to the old address will no longer be imported.")) return;
    void perform("rotate", {
      action: "rotate",
      aliasId: alias.id,
      expectedVersion: alias.version,
      idempotencyKey: crypto.randomUUID(),
    }, "A new personal inbound address is active. The old address was retired.");
  }

  return <section className="panel personal-inbound-panel" aria-labelledby="personal-inbound-title">
    <div className="panel-heading">
      <div><p className="eyebrow">Your direct intake</p><h2 id="personal-inbound-title">Personal inbound email</h2></div>
      <span className="demo-chip">{alias ? "Active" : "Not created"}</span>
    </div>
    <p>Forward invoice PDFs to this unguessable address. FinLynQ routes them through your active organization membership into the selected company document inbox.</p>
    {alias ? <>
      <div className="personal-inbound-address-row">
        <input ref={addressRef} aria-label="Personal inbound email address" value={alias.address} readOnly spellCheck={false} />
        <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => { void copyAddress(); }}>Copy address</button>
      </div>
      <div className="personal-inbound-routing">
        <label><span>Document inbox</span><select value={selectedConnectionId} disabled={busy !== null} onChange={(event) => setSelectedConnectionId(event.target.value)}>
          <option value="">Secure staging only</option>
          {activeConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label} · {connection.module === "payables" ? "Purchases" : "Sales"}</option>)}
        </select></label>
        <button className="secondary-button" type="button" disabled={busy !== null || selectedConnectionId === (alias.connectionId ?? "")} onClick={() => void perform("configure", {
          action: "configure",
          aliasId: alias.id,
          expectedVersion: alias.version,
          connectionId: selectedConnectionId || null,
        }, "Personal email routing was updated.")}>{busy === "configure" ? "Saving…" : "Save routing"}</button>
        <button className="secondary-button" type="button" disabled={busy !== null} onClick={rotateAddress}>{busy === "rotate" ? "Rotating…" : "Rotate address"}</button>
      </div>
      {!alias.connectionId && <p className="panel-note personal-inbound-warning">Messages are encrypted and staged, but attachments cannot enter a document inbox until routing is selected. <Link href="/app/settings/documents">Configure document storage</Link>.</p>}
    </> : <>
      <div className="personal-inbound-routing">
        <label><span>Document inbox</span><select value={selectedConnectionId} disabled={busy !== null} onChange={(event) => setSelectedConnectionId(event.target.value)}>
          <option value="">Secure staging only</option>
          {activeConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label} · {connection.module === "payables" ? "Purchases" : "Sales"}</option>)}
        </select></label>
        <button className="primary-button" type="button" disabled={busy !== null} onClick={() => void perform("provision", {
          action: "provision",
          ...(selectedConnectionId ? { connectionId: selectedConnectionId } : {}),
        }, "Your personal inbound address is ready.")}>{busy === "provision" ? "Creating…" : "Create my address"}</button>
      </div>
      {!activeConnections.length && <p className="panel-note">You can create an address now and connect its document inbox later.</p>}
    </>}
    {error
      ? <MutationFeedback kind="error" message={error} onDismiss={() => setError("")} />
      : message
        ? <MutationFeedback kind="success" message={message} onDismiss={() => setMessage("")} />
        : null}
  </section>;
}
