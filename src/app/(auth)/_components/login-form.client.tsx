"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import styles from "../auth.module.css";

export function LoginForm({ next, initialMessage, accountLoginEnabled }: { next: string; initialMessage?: string; accountLoginEnabled: boolean }) {
  const [error, setError] = useState(initialMessage ?? "");
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [trustedBrowserAllowed, setTrustedBrowserAllowed] = useState(false);
  const [trustedBrowserDurationDays, setTrustedBrowserDurationDays] = useState(30);

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
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          otp: form.get("otp") || undefined,
          trustBrowser: form.get("trustBrowser") === "on",
          next,
        }),
      });
      const result = await response.json() as {
        error?: string;
        next?: string;
        mfaRequired?: boolean;
        trustedBrowserAllowed?: boolean;
        trustedBrowserDurationDays?: number;
      };
      if (result.mfaRequired) {
        setMfaRequired(true);
        setTrustedBrowserAllowed(result.trustedBrowserAllowed === true);
        if ([7, 30, 90].includes(result.trustedBrowserDurationDays ?? 0)) {
          setTrustedBrowserDurationDays(result.trustedBrowserDurationDays!);
        }
      }
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
          <form className={styles.form} onSubmit={(event) => { void submit(event); }} noValidate>
            <label><span>Email address</span><input name="email" type="email" autoComplete="username" inputMode="email" required maxLength={254} /></label>
            <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
            {mfaRequired && <label><span>Authenticator code</span><input name="otp" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /><small>Enter the current six-digit code.</small></label>}
            {mfaRequired && trustedBrowserAllowed && (
              <label className={styles.checkboxLabel}>
                <input name="trustBrowser" type="checkbox" />
                <span>
                  <strong>Trust this browser for {trustedBrowserDurationDays} days</strong><br />
                  Future sign-ins here still require your password. Clearing cookies, private browsing, expiry, or revocation requires an authenticator code again. Sensitive actions continue to require a fresh MFA step-up.
                </span>
              </label>
            )}
            <div className={styles.formRow}><span>Sessions expire after inactivity.</span><Link href="/forgot-password">Forgot password?</Link></div>
            <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
          <div className={styles.divider}><span>or</span></div>
        </>
      )}
      <Link className={styles.demoButton} href={`/try-demo?next=${encodeURIComponent(next)}`} prefetch={false}>Open the public demo <span aria-hidden="true">→</span></Link>
      <Link className={styles.afterFormLink} href="/signup">Create a new business account</Link>
      <p className={styles.securityNote}>{accountLoginEnabled ? "The public demo is one shared synthetic account. Everyone sees its changes until the nightly reset; do not enter real information. Recovery, external systems, and MCP access remain disabled." : "This hosted preview is one shared synthetic account. Everyone sees its changes until the nightly reset; real account login and real-organization writes remain server-disabled."}</p>
    </>
  );
}
