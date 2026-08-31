"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AuthenticatorEnrollmentSetup } from "@/app/_components/authenticator-enrollment.client";
import styles from "../auth.module.css";

type ReplacementEnrollment = Readonly<{ secret: string; enrollmentUri: string; qrCodeDataUrl: string; organizationName: string }>;

export function ResetPasswordForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [availableAt, setAvailableAt] = useState("");
  const [escalating, setEscalating] = useState(false);
  const [replacementEnrollment, setReplacementEnrollment] = useState<ReplacementEnrollment | null>(null);

  useEffect(() => {
    const tokenValue = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    const frame = window.requestAnimationFrame(() => {
      setToken(tokenValue);
      if (!tokenValue) setError("This reset link is incomplete. Request a new link to continue.");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (password !== confirmation) { setError("The passwords do not match."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, otp: form.get("otp") || undefined }),
      });
      const result = await response.json() as {
        error?: string;
        mfaRequired?: boolean;
        mfaEnrollmentRequired?: boolean;
        availableAt?: string;
        secret?: string;
        enrollmentUri?: string;
        qrCodeDataUrl?: string;
        organizationName?: string;
      };
      if (result.mfaRequired) setMfaRequired(true);
      if (result.mfaEnrollmentRequired && result.secret && result.enrollmentUri && result.qrCodeDataUrl && result.organizationName) {
        setMfaRequired(false);
        setReplacementEnrollment({
          secret: result.secret,
          enrollmentUri: result.enrollmentUri,
          qrCodeDataUrl: result.qrCodeDataUrl,
          organizationName: result.organizationName,
        });
      }
      if (result.availableAt) setAvailableAt(result.availableAt);
      if (!response.ok) throw new Error(result.error || "Password reset failed.");
      setSuccess(true);
      setToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password reset is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function escalate() {
    if (!token || busy || escalating) return;
    setEscalating(true); setError("");
    try {
      const response = await fetch("/api/auth/password-reset/escalate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      const result = await response.json() as { error?: string; recoveryPolicy?: "CO_OWNER" | "DELAYED"; availableAt?: string };
      if (!response.ok || !result.recoveryPolicy) throw new Error(result.error || "Recovery protection could not be changed.");
      setMfaRequired(false);
      setReplacementEnrollment(null);
      if (result.availableAt) setAvailableAt(result.availableAt);
      setError(result.recoveryPolicy === "CO_OWNER"
        ? "A different recovery administrator was notified. Return to this link after they approve it."
        : "Sole-owner protection is active. Return to this link after the 72-hour security delay.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Recovery protection is temporarily unavailable."); }
    finally { setEscalating(false); }
  }

  if (success) return <div className={styles.successStack}><div className={styles.successAlert} role="status">Your password was changed and all existing sessions were signed out.</div><Link className={styles.submitButton} href="/login">Continue to sign in</Link></div>;

  return (
    <form className={styles.form} onSubmit={(event) => { void submit(event); }} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      {availableAt && <div className={styles.alert} role="status">This protected recovery becomes available {new Date(availableAt).toLocaleString()}.</div>}
      {replacementEnrollment && <div className={styles.successAlert} role="status">Protected recovery is approved. Add a replacement authenticator for your {replacementEnrollment.organizationName} account before changing the password.</div>}
      <label><span>New password</span><input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /><small>Use at least 14 characters.</small></label>
      <label><span>Confirm new password</span><input name="confirmation" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /></label>
      {replacementEnrollment && <AuthenticatorEnrollmentSetup enrollment={replacementEnrollment} replacement />}
      {(mfaRequired || replacementEnrollment) && <label><span>{replacementEnrollment ? "Replacement authenticator code" : "Authenticator code"}</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label>}
      {mfaRequired && <button className={styles.afterFormLink} type="button" onClick={() => { void escalate(); }} disabled={busy || escalating}>{escalating ? "Requesting protected recovery…" : "I can’t use my authenticator"}</button>}
      <button className={styles.submitButton} type="submit" disabled={busy || !token}>{busy ? "Updating…" : "Update password"}</button>
    </form>
  );
}
