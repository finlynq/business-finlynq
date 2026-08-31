"use client";

import { useRef, useState } from "react";
import styles from "./authenticator-enrollment.module.css";

export type AuthenticatorEnrollment = Readonly<{
  secret: string;
  enrollmentUri: string;
  qrCodeDataUrl: string;
}>;

export function AuthenticatorEnrollmentSetup({
  enrollment,
  replacement = false,
}: {
  enrollment: AuthenticatorEnrollment;
  replacement?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopyStatus("Setup key copied.");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyStatus("Select Copy in your browser to copy the highlighted key.");
    }
  }

  const qualifier = replacement ? "replacement " : "";
  return (
    <div className={styles.setup}>
      <div className={styles.qrCard}>
        {/* The QR is generated locally on the server; the TOTP secret is never sent to a QR service. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enrollment.qrCodeDataUrl}
          alt={`QR code for ${qualifier}authenticator setup`}
          width={256}
          height={256}
        />
        <p>Scan this QR code with Microsoft Authenticator, Google Authenticator, 1Password, or another TOTP app.</p>
      </div>
      <div className={styles.manual}>
        <span id="authenticator-manual-key-label">Manual {qualifier}setup key</span>
        <span className={styles.copyRow}>
          <input
            ref={inputRef}
            value={enrollment.secret}
            readOnly
            spellCheck={false}
            autoComplete="off"
            aria-labelledby="authenticator-manual-key-label"
            aria-label={`${replacement ? "Replacement authenticator" : "Authenticator"} manual setup key`}
          />
          <button className={styles.copyButton} type="button" onClick={() => { void copySecret(); }}>Copy key</button>
        </span>
      </div>
      <p className={styles.copyStatus} role="status" aria-live="polite">{copyStatus}</p>
      <a className={styles.appLink} href={enrollment.enrollmentUri}>Open authenticator app</a>
    </div>
  );
}
