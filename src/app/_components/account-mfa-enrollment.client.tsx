"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthenticatorEnrollmentSetup,
  type AuthenticatorEnrollment,
} from "./authenticator-enrollment.client";
import styles from "./account-mfa-enrollment.module.css";

type Enrollment = AuthenticatorEnrollment & Readonly<{
  setupToken: string;
  organizationName: string;
}>;

export function AccountMfaEnrollment({
  enabled,
  pending = false,
}: {
  enabled: boolean;
  pending?: boolean;
}) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || enabled) return;
    const currentPassword = new FormData(event.currentTarget).get("currentPassword");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa/enroll/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      const result = await response.json() as Partial<Enrollment> & { error?: string };
      if (!response.ok || !result.setupToken || !result.secret || !result.enrollmentUri || !result.qrCodeDataUrl || !result.organizationName) {
        throw new Error(result.error || "Authenticator setup could not start.");
      }
      setEnrollment(result as Enrollment);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authenticator setup is temporarily unavailable.");
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
      const response = await fetch("/api/auth/mfa/enroll/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupToken: enrollment.setupToken, otp }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Authenticator confirmation failed.");
      setComplete(true);
      setEnrollment(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authenticator confirmation is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (enabled || complete) {
    return <div className={styles.success} role="status">Authenticator protection is enabled. Sign-ins require a password and current code; privileged operations continue to require a fresh step-up.</div>;
  }

  if (!enrollment) {
    return (
      <form className={styles.stack} onSubmit={(event) => { void start(event); }}>
        {error && <div className={styles.error} role="alert">{error}</div>}
        <p className={styles.note}>{pending
          ? "A previous authenticator setup was not confirmed. Re-enter your password to replace it and restart setup; password-only access remains active in the meantime."
          : "Your current account uses password-only sign-in. Ordinary workspace access remains available, but sensitive operations that require MFA step-up are unavailable until you enroll an authenticator."}</p>
        <label className={styles.field}>
          <span>Current password</span>
          <input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} />
          <small>Re-enter your password before generating a new authenticator secret.</small>
        </label>
        <div className="panel-actions">
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Preparing…" : pending ? "Restart authenticator setup" : "Add authenticator"}</button>
        </div>
      </form>
    );
  }

  return (
    <form className={styles.stack} onSubmit={(event) => { void confirm(event); }}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      <AuthenticatorEnrollmentSetup enrollment={enrollment} />
      <label className={styles.field}>
        <span>Authenticator code</span>
        <input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
        <small>Enter the current six-digit code to enable MFA.</small>
      </label>
      <div className="panel-actions">
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify and enable"}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => { setEnrollment(null); setError(""); }}>Cancel</button>
      </div>
    </form>
  );
}
