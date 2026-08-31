"use client";

import { FormEvent, useState } from "react";
import styles from "../auth.module.css";

export function ForgotPasswordForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      const result = await response.json() as { message?: string };
      setMessage(result.message || "If an eligible account matches that email, a reset link will be sent shortly.");
    } catch {
      setMessage("If an eligible account matches that email, a reset link will be sent shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => { void submit(event); }} noValidate>
      {message && <div className={styles.successAlert} role="status">{message}</div>}
      <label><span>Email address</span><input name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} /></label>
      <button className={styles.submitButton} type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
    </form>
  );
}
