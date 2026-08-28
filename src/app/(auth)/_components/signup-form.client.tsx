"use client";

import Link from "next/link";
import Script from "next/script";
import { FormEvent, useCallback, useRef, useState } from "react";
import { supportedCurrencies } from "@/kernel/money";
import {
  SIGNUP_ACCOUNTING_PROFILES,
  SIGNUP_REGIONS,
  signupCountryDefaults,
  type SignupAccountingProfile,
} from "@/modules/identity/signup-policy";
import { signupRateLimitMessage } from "@/modules/identity/signup-public-response";
import styles from "../auth.module.css";

type TurnstileApi = Readonly<{
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
}>;

declare global {
  interface Window { turnstile?: TurnstileApi }
}

export function SignupForm({
  challenge,
}: Readonly<{
  challenge: { enabled: boolean; siteKey: string | null; action: string };
}>) {
  const [countryChoice, setCountryChoice] = useState<"CA" | "US" | "OTHER">("CA");
  const [otherCountryCode, setOtherCountryCode] = useState("");
  const [region, setRegion] = useState("ON");
  const [functionalCurrency, setFunctionalCurrency] = useState("CAD");
  const [accountingProfile, setAccountingProfile] = useState<SignupAccountingProfile>("CAN_ASPE");
  const [challengeToken, setChallengeToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const challengeContainer = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  const renderChallenge = useCallback(() => {
    if (!challenge.enabled || !challenge.siteKey || !challengeContainer.current || !window.turnstile || widgetId.current) return;
    widgetId.current = window.turnstile.render(challengeContainer.current, {
      sitekey: challenge.siteKey,
      action: challenge.action,
      callback: (token: string) => setChallengeToken(token),
      "expired-callback": () => setChallengeToken(""),
      "error-callback": () => setChallengeToken(""),
    });
  }, [challenge]);

  function resetChallenge() {
    setChallengeToken("");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }

  function changeCountry(nextCountry: "CA" | "US" | "OTHER") {
    setCountryChoice(nextCountry);
    const countryCode = nextCountry === "OTHER" ? "" : nextCountry;
    const defaults = signupCountryDefaults(countryCode);
    setRegion(nextCountry === "CA" ? "ON" : nextCountry === "US" ? "WA" : "NA");
    setFunctionalCurrency(defaults.functionalCurrency);
    setAccountingProfile(defaults.accountingProfile);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (challenge.enabled && !challengeToken) {
      setError("Complete the signup verification before continuing.");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/signup/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          displayName: form.get("displayName"),
          organizationName: form.get("organizationName"),
          entityCode: form.get("entityCode"),
          entityName: form.get("entityName"),
          countryCode: countryChoice === "OTHER" ? otherCountryCode.trim().toUpperCase() : countryChoice,
          regionCode: region,
          functionalCurrency,
          accountingProfile,
          fiscalYear: Number(form.get("fiscalYear")),
          manualPostingMode: form.get("manualPostingMode"),
          termsAccepted: form.get("termsAccepted") === "on",
          challengeToken,
        }),
      });
      const result = await response.json() as { error?: string; message?: string };
      if (response.status === 429) {
        throw new Error(signupRateLimitMessage(response.headers.get("Retry-After")));
      }
      if (!response.ok || !result.message) throw new Error(result.error || "Account signup failed.");
      setMessage(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account signup is temporarily unavailable.");
      resetChallenge();
    } finally {
      setBusy(false);
    }
  }

  if (message) return (
    <div className={styles.successStack}>
      <div className={styles.successAlert} role="status">{message}</div>
      <p>Open the one-use link in the email to create your password and authenticator. No business is provisioned until the link is verified.</p>
      <Link className={styles.submitButton} href="/login">Continue to sign in</Link>
    </div>
  );

  return (
    <>
      {challenge.enabled && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={renderChallenge}
          onError={() => setError("Signup verification could not load. Refresh the page and try again.")}
        />
      )}
      <form className={styles.form} onSubmit={submit}>
        {error && <div className={styles.alert} role="alert">{error}</div>}
        <div className={styles.formGrid}>
          <label><span>Your name</span><input name="displayName" autoComplete="name" required minLength={2} maxLength={120} /></label>
          <label><span>Work email</span><input name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} /></label>
        </div>
        <label><span>Business name</span><input name="organizationName" autoComplete="organization" required minLength={2} maxLength={200} /><small>Enter at least 2 characters.</small></label>
        <label><span>Legal entity name</span><input name="entityName" autoComplete="organization" required minLength={2} maxLength={200} /><small>Enter the legal name registered for this entity.</small></label>
        <div className={styles.formGrid}>
          <label><span>Country</span><select value={countryChoice} onChange={(event) => changeCountry(event.target.value as "CA" | "US" | "OTHER")}><option value="CA">Canada</option><option value="US">United States</option><option value="OTHER">Another ISO country</option></select></label>
          {countryChoice === "OTHER" ? (
            <label><span>ISO country code</span><input value={otherCountryCode} onChange={(event) => setOtherCountryCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} minLength={2} maxLength={2} pattern="[A-Z]{2}" placeholder="GB" required /><small>Enter the legal entity&apos;s two-letter ISO country code.</small></label>
          ) : (
            <label><span>{countryChoice === "CA" ? "Province or territory" : "State"}</span><select value={region} onChange={(event) => setRegion(event.target.value)}>{SIGNUP_REGIONS[countryChoice].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          )}
        </div>
        {countryChoice === "OTHER" && (
          <label><span>State, province, or region code</span><input value={region} onChange={(event) => setRegion(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10))} minLength={2} maxLength={10} pattern="[A-Z0-9-]{2,10}" required /><small>Use NA where a subdivision does not apply. Local tax automation is currently supported only for Ontario and Washington; other jurisdictions are held for review rather than treated as zero tax.</small></label>
        )}
        <div className={styles.formGrid}>
          <label><span>Entity code</span><input name="entityCode" defaultValue={countryChoice === "CA" ? "CA01" : countryChoice === "US" ? "US01" : "ENT01"} key={countryChoice} required maxLength={16} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" /><small>Used in the account key; 0000 is reserved.</small></label>
          <label><span>First fiscal year</span><input name="fiscalYear" type="number" defaultValue={new Date().getFullYear()} min={2000} max={2200} required /></label>
        </div>
        <div className={styles.formGrid}>
          <label><span>Functional currency</span><select value={functionalCurrency} onChange={(event) => setFunctionalCurrency(event.target.value)}>{supportedCurrencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select><small>Immutable for this ledger after its first posting.</small></label>
          <label><span>Accounting framework</span><select value={accountingProfile} onChange={(event) => setAccountingProfile(event.target.value as SignupAccountingProfile)}>{SIGNUP_ACCOUNTING_PROFILES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>Choose the framework used by this entity.</small></label>
        </div>
        <label><span>Manual journal posting</span><select name="manualPostingMode" defaultValue="AUTO_POST"><option value="AUTO_POST">Auto-post for simpler workflows</option><option value="REVIEW_REQUIRED">Require review before posting</option></select><small>Posting permissions still apply in either mode.</small></label>
        <label className={styles.checkboxLabel}><input name="termsAccepted" type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">terms</Link> and acknowledge the <Link href="/privacy" target="_blank">privacy notice</Link>.</span></label>
        {challenge.enabled && <div ref={challengeContainer} className={styles.challenge} aria-label="Signup verification" />}
        <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Sending verification…" : "Create account"}</button>
        <p className={styles.securityNote}>This creates an evaluation workspace in the hosted preview, not a production system of record. Do not enter regulated, confidential, or customer data under the current preview terms. The owner remains disabled until email verification, password setup, and authenticator confirmation finish.</p>
      </form>
    </>
  );
}
