"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import styles from "../auth.module.css";

type Enrollment = Readonly<{
  setupToken: string;
  secret: string;
  enrollmentUri: string;
  organizationName: string;
}>;

export function CompleteSignupForm() {
  const [signupToken, setSignupToken] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    const frame = requestAnimationFrame(() => {
      setSignupToken(token);
      if (!token) setError("This signup link is incomplete. Request a new account verification email.");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!signupToken || busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirmation") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/signup/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: signupToken, password }),
      });
      const result = await response.json() as Partial<Enrollment> & { error?: string };
      if (!response.ok || !result.setupToken || !result.secret || !result.enrollmentUri || !result.organizationName) {
        throw new Error(result.error || "Account activation failed.");
      }
      setEnrollment(result as Enrollment);
      setSignupToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account activation is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment || busy) return;
    const otp = new FormData(event.currentTarget).get("otp");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa/enroll/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupToken: enrollment.setupToken, otp }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Authenticator confirmation failed.");
      setComplete(true);
      setEnrollment(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authenticator confirmation is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (complete) return (
    <div className={styles.successStack}>
      <div className={styles.successAlert} role="status">Your business, owner account, and authenticator are active.</div>
      <Link className={styles.submitButton} href="/login">Continue to sign in</Link>
    </div>
  );
  if (enrollment) return (
    <form className={styles.form} onSubmit={confirm} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      <div className={styles.successAlert} role="status">Password saved. Finish securing your {enrollment.organizationName} owner account.</div>
      <p>Add this key to a TOTP authenticator, then enter its current code. Your user and membership remain disabled until this succeeds.</p>
      <label><span>Manual setup key</span><input value={enrollment.secret} readOnly aria-label="Authenticator manual setup key" /></label>
      <a className={styles.afterFormLink} href={enrollment.enrollmentUri}>Open authenticator app</a>
      <label><span>Authenticator code</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label>
      <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify and activate"}</button>
    </form>
  );
  return (
    <form className={styles.form} onSubmit={accept} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      <label><span>Create password</span><input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /><small>Use at least 14 characters.</small></label>
      <label><span>Confirm password</span><input name="confirmation" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /></label>
      <button className={styles.submitButton} type="submit" disabled={busy || !signupToken}>{busy ? "Creating secure business…" : "Continue to authenticator"}</button>
    </form>
  );
}
