"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./party-directory.module.css";

type Feedback = Readonly<{ kind: "success" | "error"; text: string }> | null;

async function errorMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : "The party could not be corrected.";
}

export function PartyCorrectionForm({
  partyId,
  displayName,
  active,
}: Readonly<{ partyId: string; displayName: string; active: boolean }>) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [enabled, setEnabled] = useState(active);
  const [reason, setReason] = useState("Correct party master-data name");
  const [otp, setOtp] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const patchParty = () => fetch(`/api/parties/${encodeURIComponent(partyId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: name.trim(),
      active: enabled,
      expectedDisplayName: displayName,
      expectedActive: active,
      reason: reason.trim(),
    }),
  });

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      let response = await patchParty();
      if (response.status === 428) {
        if (!/^\d{6}$/.test(otp)) {
          setFeedback({ kind: "error", text: "Enter the current six-digit authenticator code, then retry." });
          return;
        }
        const stepUp = await fetch("/api/auth/mfa/step-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otp }),
        });
        if (!stepUp.ok) {
          setFeedback({ kind: "error", text: await errorMessage(stepUp) });
          return;
        }
        response = await patchParty();
      }
      if (!response.ok) {
        setFeedback({ kind: "error", text: await errorMessage(response) });
        return;
      }
      const payload = await response.json() as { warnings?: string[] };
      setOtp("");
      setConfirmed(false);
      setFeedback({
        kind: "success",
        text: payload.warnings?.[0] ?? "The party was corrected without changing its stable ID or accounting links.",
      });
      router.refresh();
    } catch {
      setFeedback({ kind: "error", text: "The save result is unknown. Refresh the directory before retrying." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.attachForm} onSubmit={(event) => { void save(event); }}>
      <label><span>Current name</span><input value={displayName} readOnly /></label>
      <label><span>Corrected name</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={1} maxLength={200} required disabled={busy} /></label>
      <label><span>Permanent reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} required disabled={busy} /></label>
      <label><span>Authenticator code (when requested)</span><input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} disabled={busy} /></label>
      <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} /><span>Party is active</span></label>
      <label className="checkbox-field"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required disabled={busy} /><span>I confirm this owner correction and its permanent audit reason.</span></label>
      {feedback && <p className={`${styles.attachMessage} validation-message ${feedback.kind === "success" ? "validation-success" : "validation-error"}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
      <button className="secondary-button" type="submit" disabled={busy || !confirmed || !name.trim() || reason.trim().length < 5}>{busy ? "Saving…" : "Save correction"}</button>
    </form>
  );
}
