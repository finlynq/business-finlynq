"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import styles from "../auth.module.css";

export function ResetPasswordForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

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
        body: JSON.stringify({ token, password }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Password reset failed.");
      setSuccess(true);
      setToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password reset is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (success) return <div className={styles.successStack}><div className={styles.successAlert} role="status">Your password was changed and all existing sessions were signed out.</div><Link className={styles.submitButton} href="/login">Continue to sign in</Link></div>;

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      <label><span>New password</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /><small>Use at least 12 characters.</small></label>
      <label><span>Confirm new password</span><input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
      <button className={styles.submitButton} type="submit" disabled={busy || !token}>{busy ? "Updating…" : "Update password"}</button>
    </form>
  );
}
