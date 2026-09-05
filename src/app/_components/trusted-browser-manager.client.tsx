"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type TrustedBrowserView = Readonly<{
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}>;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string"
    ? payload.error
    : "The security change could not be completed.";
}

export function TrustedBrowserManager({
  initialBrowsers,
}: {
  initialBrowsers: readonly TrustedBrowserView[];
}) {
  const router = useRouter();
  const [browsers, setBrowsers] = useState(initialBrowsers);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  async function revoke(browserId: string) {
    setBusy(browserId);
    setFeedback("");
    try {
      const response = await fetch(`/api/auth/trusted-browsers/${encodeURIComponent(browserId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setBrowsers((current) => current.filter((browser) => browser.id !== browserId));
      setFeedback("The trusted browser was revoked. This browser may require MFA at its next login.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The trusted browser could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    setBusy("all");
    setFeedback("");
    try {
      const response = await fetch("/api/auth/trusted-browsers", { method: "DELETE" });
      if (!response.ok) throw new Error(await responseMessage(response));
      setBrowsers([]);
      setFeedback("All trusted browsers were revoked.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Trusted browsers could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  async function logoutAll() {
    setBusy("sessions");
    setFeedback("");
    try {
      const response = await fetch("/api/auth/sessions", { method: "DELETE" });
      if (!response.ok) throw new Error(await responseMessage(response));
      router.push("/login");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Sessions could not be revoked.");
      setBusy(null);
    }
  }

  return (
    <>
      {feedback && <div className="validation-message" role="status">{feedback}</div>}
      {browsers.length === 0 ? (
        <p className="panel-note">No active trusted browsers. If your organization permits it, the option appears only after your password is accepted and MFA is requested during sign-in.</p>
      ) : (
        <div className="table-scroll" tabIndex={0} aria-label="Trusted browsers">
          <table>
            <thead><tr><th>Browser</th><th>Created</th><th>Last used</th><th>Expires</th><th>Action</th></tr></thead>
            <tbody>
              {browsers.map((browser) => (
                <tr key={browser.id}>
                  <td><strong>{browser.label}</strong></td>
                  <td><time dateTime={browser.createdAt}>{formatTime(browser.createdAt)} UTC</time></td>
                  <td>{browser.lastUsedAt
                    ? <time dateTime={browser.lastUsedAt}>{formatTime(browser.lastUsedAt)} UTC</time>
                    : "Not used since enrollment"}</td>
                  <td><time dateTime={browser.expiresAt}>{formatTime(browser.expiresAt)} UTC</time></td>
                  <td><button className="text-danger-button" type="button" disabled={busy !== null} onClick={() => { void revoke(browser.id); }}>{busy === browser.id ? "Revoking…" : "Revoke"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-actions">
        <button className="secondary-button" type="button" disabled={busy !== null || browsers.length === 0} onClick={() => { void revokeAll(); }}>{busy === "all" ? "Revoking…" : "Revoke all trusted browsers"}</button>
        <button className="text-danger-button" type="button" disabled={busy !== null} onClick={() => { void logoutAll(); }}>{busy === "sessions" ? "Signing out…" : "Sign out all devices"}</button>
      </div>
      <p className="panel-note">Trust skips only login MFA. Your password remains required, and sensitive actions still require a fresh authenticator step-up. Clearing cookies or private browsing removes this browser&apos;s proof.</p>
    </>
  );
}
