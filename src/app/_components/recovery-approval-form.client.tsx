"use client";

import { FormEvent, useEffect, useState } from "react";

export function RecoveryApprovalForm() {
  const [requestId, setRequestId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("request") ?? "";
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    const frame = requestAnimationFrame(() => {
      setRequestId(value);
      if (!value) setError("This approval link is incomplete.");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requestId || busy) return;
    const otp = new FormData(event.currentTarget).get("otp");
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/auth/recovery/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recoveryRequestId: requestId, otp }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Recovery approval failed.");
      setMessage("Recovery approved. The requester may now use their existing reset link.");
      setRequestId("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Recovery approval is temporarily unavailable."); }
    finally { setBusy(false); }
  }

  return (
    <form className="close-form" onSubmit={submit} noValidate>
      {error && <div className="validation-message validation-error" role="alert">{error}</div>}
      {message && <div className="validation-message validation-success" role="status">{message}</div>}
      <label className="full-field"><span>Fresh authenticator code</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /><small>Verify the requester through a separate channel before approving. Codes cannot be replayed.</small></label>
      <div className="form-actions"><button className="primary-button" type="submit" disabled={busy || !requestId}>{busy ? "Approving…" : "Approve recovery"}</button></div>
    </form>
  );
}
