"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { McpConnectionSettings } from "@/modules/mcp/connection-policy";
import type { McpAccessMode } from "@/modules/mcp/protocol";
import type { PendingMcpApproval } from "@/modules/mcp/settings-store";

const MODES: readonly Readonly<{ value: McpAccessMode; label: string }>[] = [
  { value: "OFF", label: "Off" },
  { value: "READ_ONLY", label: "Read only" },
  { value: "CONFIRM_WRITES", label: "Ask before writes" },
  { value: "ALLOW_WRITES", label: "Allow writes" },
];

type Feedback = Readonly<{ kind: "error" | "success"; message: string }> | null;
type MfaEnrollmentState = "ENABLED" | "PENDING" | "NOT_ENROLLED" | "UNAVAILABLE";

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : "The MCP setting could not be changed.";
}

function displayTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function McpSettings({
  endpoint,
  initialConnections,
  initialApprovals,
  enabled,
  mfaEnrollmentState,
}: {
  endpoint: string;
  initialConnections: readonly McpConnectionSettings[];
  initialApprovals: readonly PendingMcpApproval[];
  enabled: boolean;
  mfaEnrollmentState: MfaEnrollmentState;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initialConnections);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [otp, setOtp] = useState("");
  const [needsStepUp, setNeedsStepUp] = useState(false);

  async function request(key: string, url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, success: string) {
    setBusy(key);
    setFeedback(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 428) setNeedsStepUp(true);
        throw new Error(await responseMessage(response));
      }
      setFeedback({ kind: "success", message: success });
      router.refresh();
      return true;
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "The MCP setting could not be changed." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function verifyMfa() {
    if (!/^\d{6}$/.test(otp)) {
      setFeedback({ kind: "error", message: "Enter the current six-digit authenticator code." });
      return;
    }
    setBusy("mfa");
    try {
      const response = await fetch("/api/auth/mfa/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setNeedsStepUp(false);
      setOtp("");
      setFeedback({ kind: "success", message: "Verification complete. Repeat the protected action." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Verification failed." });
    } finally {
      setBusy(null);
    }
  }

  function updateDraft(id: string, field: "dailyMode" | "setupMode", value: McpAccessMode) {
    setConnections((current) => current.map((connection) => connection.id === id ? { ...connection, [field]: value } : connection));
  }

  async function save(connection: McpConnectionSettings) {
    await request(`save-${connection.id}`, "/api/mcp/connections", "PATCH", {
      connectionId: connection.id,
      expectedVersion: connection.version,
      dailyMode: connection.dailyMode,
      setupMode: connection.setupMode,
      toolOverrides: connection.toolOverrides,
    }, `${connection.clientName} access policy updated.`);
  }

  async function revoke(connection: McpConnectionSettings) {
    if (!window.confirm(`Disconnect ${connection.clientName}? Its OAuth tokens and pending approvals will be revoked.`)) return;
    if (await request(`revoke-${connection.id}`, "/api/mcp/connections", "DELETE", { connectionId: connection.id }, `${connection.clientName} disconnected.`)) {
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setApprovals((current) => current.filter((item) => item.connectionId !== connection.id));
    }
  }

  async function decide(approval: PendingMcpApproval, decision: "APPROVED" | "REJECTED") {
    if (await request(`${decision}-${approval.id}`, "/api/mcp/approvals", "POST", { approvalId: approval.id, decision }, decision === "APPROVED" ? "The agent may retry this exact action once." : "The action was rejected.")) {
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    }
  }

  return (
    <div className="settings-layout">
      {feedback && <div className={`validation-message ${feedback.kind === "error" ? "validation-error" : "validation-success"}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</div>}

      <section className="panel form-panel" aria-labelledby="mcp-endpoint-title">
        <div className="panel-heading"><div><p className="eyebrow">Remote endpoint</p><h2 id="mcp-endpoint-title">Connect an MCP client</h2><p>Use OAuth 2.1 with PKCE. FinLynQ never asks the agent for a password, API key, bank credential, or signing secret.</p></div></div>
        <div className="close-form">
          <label className="full-field"><span>MCP server URL</span><input readOnly value={endpoint} onFocus={(event) => event.currentTarget.select()} /></label>
          <p className="form-footnote">Request daily scopes for routine accounting and setup scopes only when the agent must maintain master data. New write-capable connections start in confirmation mode.</p>
        </div>
      </section>

      {enabled && mfaEnrollmentState !== "ENABLED" && (
        <section className="panel form-panel" aria-labelledby="mcp-mfa-enrollment-title">
          <div className="panel-heading"><div><p className="eyebrow">Security readiness</p><h2 id="mcp-mfa-enrollment-title">{mfaEnrollmentState === "PENDING" ? "Finish authenticator setup" : mfaEnrollmentState === "NOT_ENROLLED" ? "Add an authenticator for protected access" : "Review authenticator status"}</h2><p>{mfaEnrollmentState === "PENDING"
            ? "Your previous authenticator setup was not confirmed. Restart it before enabling autonomous daily writes, setup writes, or approving high-assurance actions."
            : mfaEnrollmentState === "NOT_ENROLLED"
              ? "This password-only account can use ordinary and read-only features. Enroll an authenticator before enabling autonomous daily writes, setup writes, or approving high-assurance actions."
              : "FinLynQ could not confirm an active authenticator for this session. Review Account & security before making a protected change."}</p></div></div>
          <div className="form-actions"><Link className="primary-button" href="/app/account#mfa-enrollment">{mfaEnrollmentState === "PENDING" ? "Restart authenticator setup" : mfaEnrollmentState === "NOT_ENROLLED" ? "Add authenticator" : "Review account security"}</Link></div>
        </section>
      )}

      {needsStepUp && enabled && mfaEnrollmentState === "ENABLED" && (
        <section className="panel form-panel" aria-labelledby="mcp-step-up-title">
          <div className="panel-heading"><div><p className="eyebrow">Security check</p><h2 id="mcp-step-up-title">Verify a protected change</h2><p>Autonomous daily writes, setup writes, and high-assurance approvals require a fresh authenticator check.</p></div></div>
          <div className="close-form">
            <label className="full-field"><span>Six-digit authenticator code</span><input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label>
            <div className="form-actions"><button className="primary-button" type="button" onClick={() => void verifyMfa()} disabled={busy !== null}>Verify</button></div>
          </div>
        </section>
      )}

      {approvals.length > 0 && (
        <section className="panel" aria-labelledby="mcp-approvals-title">
          <div className="panel-heading"><div><p className="eyebrow">Exact-action consent</p><h2 id="mcp-approvals-title">Pending approvals</h2><p>An approval is bound to the tool and exact arguments, expires after 15 minutes, and can be consumed once.</p></div><span className="attention-count">{approvals.length}</span></div>
          <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Client</th><th>Action</th><th>Arguments</th><th>Expires</th><th>Decision</th></tr></thead><tbody>{approvals.map((approval) => <tr key={approval.id}><td>{approval.clientName}</td><td><code>{approval.toolName}</code></td><td><code>{JSON.stringify(approval.argumentsSummary)}</code></td><td>{displayTime(approval.expiresAt)}</td><td><div className="member-action-list"><button className="primary-button compact-button" type="button" disabled={busy !== null} onClick={() => void decide(approval, "APPROVED")}>Approve once</button><button className="text-danger-button" type="button" disabled={busy !== null} onClick={() => void decide(approval, "REJECTED")}>Reject</button></div></td></tr>)}</tbody></table></div>
        </section>
      )}

      <section className="panel" aria-labelledby="mcp-connections-title">
        <div className="panel-heading"><div><p className="eyebrow">Your delegated access</p><h2 id="mcp-connections-title">Connected clients</h2><p>Effective tools are recalculated from your live role permissions on every MCP request.</p></div><span className="attention-count">{connections.length}</span></div>
        {!enabled || connections.length === 0 ? <p className="panel-note">{enabled ? "No MCP clients are connected yet. Add the server URL in your client to begin OAuth authorization." : "Sign in to a real organization to connect a client."}</p> : (
          <div className="table-scroll" tabIndex={0}><table><thead><tr><th>Client</th><th>Daily work</th><th>Setup</th><th>Activity</th><th>Actions</th></tr></thead><tbody>{connections.map((connection) => <tr key={connection.id}><td><strong>{connection.clientName}</strong><small>{connection.scopes.join(" · ")}</small></td><td><select aria-label={`Daily work access for ${connection.clientName}`} value={connection.dailyMode} onChange={(event) => updateDraft(connection.id, "dailyMode", event.target.value as McpAccessMode)} disabled={busy !== null}>{MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></td><td><select aria-label={`Setup access for ${connection.clientName}`} value={connection.setupMode} onChange={(event) => updateDraft(connection.id, "setupMode", event.target.value as McpAccessMode)} disabled={busy !== null}>{MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></td><td><small>Authorized {displayTime(connection.authorizedAt)}<br />Last used {displayTime(connection.lastUsedAt)}</small></td><td><div className="member-action-list"><button className="primary-button compact-button" type="button" disabled={busy !== null} onClick={() => void save(connection)}>Save</button><button className="text-danger-button" type="button" disabled={busy !== null} onClick={() => void revoke(connection)}>Disconnect</button></div></td></tr>)}</tbody></table></div>
        )}
        <p className="panel-note">Off removes the group from the client. Read only exposes queries and reports. Ask before writes creates a one-time approval. Allow writes runs without per-action approval while still enforcing your role, accounting workflow, maker-checker rules, period controls, and organization write state. High-assurance setup and reconciliation writes use the recent MFA verification captured when Allow writes is saved; verify and save again after that window expires.</p>
      </section>
    </div>
  );
}
