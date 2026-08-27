"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import styles from "../auth.module.css";

export function LoginForm({ next, initialMessage, accountLoginEnabled }: { next: string; initialMessage?: string; accountLoginEnabled: boolean }) {
  const [error, setError] = useState(initialMessage ?? "");
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password"), otp: form.get("otp") || undefined, next }),
      });
      const result = await response.json() as { error?: string; next?: string; mfaRequired?: boolean };
      if (result.mfaRequired) setMfaRequired(true);
      if (!response.ok || !result.next) throw new Error(result.error || "Sign-in failed.");
      window.location.assign(result.next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in is temporarily unavailable.");
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className={styles.alert} role="alert">{error}</div>}
      {accountLoginEnabled && (
        <>
          <form className={styles.form} onSubmit={submit} noValidate>
            <label><span>Email address</span><input name="email" type="email" autoComplete="username" inputMode="email" required maxLength={254} /></label>
            <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
            {mfaRequired && <label><span>Authenticator code</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /><small>Enter the current six-digit code.</small></label>}
            <div className={styles.formRow}><span>Sessions expire after inactivity.</span><Link href="/forgot-password">Forgot password?</Link></div>
            <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
          <div className={styles.divider}><span>or</span></div>
        </>
      )}
      <Link className={styles.demoButton} href={`/try-demo?next=${encodeURIComponent(next)}`} prefetch={false}>Open the public demo <span aria-hidden="true">→</span></Link>
      <p className={styles.securityNote}>{accountLoginEnabled ? "The public demo is a separate disposable synthetic sandbox; it cannot administer recovery, security, banks, live payments, tax filing, or MCP access." : "This hosted preview provides an isolated disposable synthetic sandbox. Real account login and real-organization writes remain server-disabled."}</p>
    </>
  );
}
