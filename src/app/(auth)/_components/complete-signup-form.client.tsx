"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  AuthenticatorEnrollmentSetup,
  type AuthenticatorEnrollment,
} from "@/app/_components/authenticator-enrollment.client";
import styles from "../auth.module.css";

type Enrollment = AuthenticatorEnrollment & Readonly<{
  setupToken: string;
  organizationName: string;
}>;

export function CompleteSignupForm({
  authentication = "password",
  identityConfirmed = false,
}: {
  authentication?: "password" | "microsoft";
  identityConfirmed?: boolean;
}) {
  const [signupToken, setSignupToken] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [completionMode, setCompletionMode] = useState<"MFA" | "PASSWORD_ONLY" | "MICROSOFT">("MFA");
  const [includePassword, setIncludePassword] = useState(false);
  const [microsoftVerified, setMicrosoftVerified] = useState(identityConfirmed);

  useEffect(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    const storageKey = "business-finlynq.microsoft-signup-token";
    if (authentication === "microsoft" && fragmentToken) {
      window.sessionStorage.setItem(storageKey, fragmentToken);
    }
    const token = fragmentToken || (authentication === "microsoft"
      ? window.sessionStorage.getItem(storageKey) ?? ""
      : "");
    if (window.location.hash) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    const frame = requestAnimationFrame(() => {
      setSignupToken(token);
      if (!token) setError("This signup link is incomplete. Request a new account verification email.");
    });
    return () => cancelAnimationFrame(frame);
  }, [authentication]);

  function confirmMicrosoftIdentity() {
    if (!signupToken || busy) return;
    window.sessionStorage.setItem("business-finlynq.microsoft-signup-token", signupToken);
    const authorizationUrl = new URL("/api/auth/oidc/start", window.location.origin);
    authorizationUrl.searchParams.set("intent", "signup-accept");
    authorizationUrl.searchParams.set("next", "/complete-signup?method=microsoft");
    window.location.assign(authorizationUrl.toString());
  }

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!signupToken || busy) return;
    const form = new FormData(event.currentTarget);
    const passwordRequired = authentication === "password" || includePassword;
    const password = passwordRequired ? String(form.get("password") ?? "") : undefined;
    if (passwordRequired && password !== String(form.get("confirmation") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(authentication === "microsoft" ? "/api/auth/signup/oidc-accept" : "/api/auth/signup/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: signupToken, ...(password ? { password } : {}) }),
      });
      const result = await response.json() as Partial<Enrollment> & { error?: string };
      if (!response.ok || !result.setupToken || !result.secret || !result.enrollmentUri || !result.qrCodeDataUrl || !result.organizationName) {
        throw new Error(result.error || "Account activation failed.");
      }
      setEnrollment(result as Enrollment);
      setSignupToken("");
      if (authentication === "microsoft") {
        window.sessionStorage.removeItem("business-finlynq.microsoft-signup-token");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account activation is temporarily unavailable.");
      if (authentication === "microsoft") setMicrosoftVerified(false);
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
      setCompletionMode(authentication === "microsoft" ? "MICROSOFT" : "MFA");
      setComplete(true);
      setEnrollment(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authenticator confirmation is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function skipAuthenticator() {
    if (!enrollment || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa/enroll/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupToken: enrollment.setupToken }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Password-only activation failed.");
      setCompletionMode("PASSWORD_ONLY");
      setComplete(true);
      setEnrollment(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account activation is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  if (complete) return (
    <div className={styles.successStack}>
      <div className={styles.successAlert} role="status">{completionMode === "MFA"
        ? "Your business, owner account, and authenticator are active."
        : completionMode === "MICROSOFT"
          ? "Your business, Microsoft sign-in, and owner authenticator are active."
        : "Your business and password-only owner account are active. You can add an authenticator later from Account & security."}</div>
      <Link className={styles.submitButton} href="/login">Continue to sign in</Link>
    </div>
  );
  if (enrollment) return (
    <form className={styles.form} onSubmit={(event) => { void confirm(event); }} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      <div className={styles.successAlert} role="status">{authentication === "microsoft"
        ? `Contact email verified and Microsoft linked to your ${enrollment.organizationName} owner account.`
        : `Password saved for your ${enrollment.organizationName} owner account.`}</div>
      <p>{authentication === "microsoft"
        ? "Scan the QR code and confirm the current code to activate this owner account."
        : "For stronger security, scan the QR code and confirm the current code. You may also continue with password-only sign-in and enroll later."}</p>
      <AuthenticatorEnrollmentSetup enrollment={enrollment} />
      <label><span>Authenticator code</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label>
      <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify and activate"}</button>
      {authentication === "password" && <button className={styles.demoButton} type="button" onClick={() => { void skipAuthenticator(); }} disabled={busy}>Continue with password only</button>}
      <p className={styles.securityNote}>{authentication === "microsoft"
        ? "Owner authenticator enrollment is required so protected accounting and organization changes retain an independent step-up factor."
        : "Password-only access cannot perform operations that require a fresh MFA step-up until an authenticator is enrolled."}</p>
    </form>
  );
  if (authentication === "microsoft" && !microsoftVerified) return (
    <div className={styles.successStack}>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      <div className={styles.successAlert} role="status">Contact-email link received.</div>
      <p>Confirm the same Microsoft account that started this signup. This prevents another person&apos;s Microsoft identity from being linked through your email address.</p>
      <button className={styles.submitButton} type="button" onClick={confirmMicrosoftIdentity} disabled={busy || !signupToken}>
        Confirm with Microsoft
      </button>
    </div>
  );
  return (
    <form className={styles.form} onSubmit={(event) => { void accept(event); }} noValidate>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      {authentication === "microsoft" && <>
        <div className={styles.successAlert} role="status">The one-use link verifies your contact email. Your Microsoft identity remains the primary sign-in method.</div>
        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={includePassword} onChange={(event) => setIncludePassword(event.target.checked)} />
          <span><strong>Also enable email and password sign-in</strong><br />Optional. Use a unique Business Finlynq password, never your Microsoft password.</span>
        </label>
      </>}
      {(authentication === "password" || includePassword) && <>
        <label><span>Create Business Finlynq password</span><input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /><small>Use at least 14 characters and do not reuse your Microsoft password.</small></label>
        <label><span>Confirm password</span><input name="confirmation" type="password" autoComplete="new-password" required minLength={14} maxLength={128} /></label>
      </>}
      <button className={styles.submitButton} type="submit" disabled={busy || !signupToken}>{busy ? "Creating secure business…" : authentication === "microsoft" ? "Verify email and set up authenticator" : "Create business and choose security"}</button>
    </form>
  );
}
