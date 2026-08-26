"use client";

import { useId, useState } from "react";

export function CloseReadinessForm({ blockers }: { blockers: readonly string[] }) {
  const resultId = useId();
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<null | { errors: string[] }>(null);

  const checkReadiness = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: string[] = [];
    if (reason.trim().length < 20) errors.push("Provide a reason of at least 20 characters.");
    if (!acknowledged) errors.push("Acknowledge that hard close prevents ordinary posting.");
    errors.push(...blockers);
    errors.push("No signed actor, step-up authentication, or write-enabled environment is available in this demo.");
    setResult({ errors });
  };

  return (
    <form className="close-form" onSubmit={checkReadiness} aria-describedby={resultId}>
      <label>
        <span>Reason for hard close</span>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} maxLength={500} placeholder="Describe why this period is ready to be hard closed." />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>I understand ordinary journals cannot post into a hard-closed period.</span>
      </label>
      <div className="form-actions">
        <button type="submit" className="primary-button">Check hard-close readiness</button>
        <button type="button" className="secondary-button" disabled>Submit request unavailable</button>
      </div>
      <div id={resultId} aria-live="polite">
        {result && (
          <div className="validation-message validation-error">
            <strong>Hard close is blocked.</strong>
            <ul>{result.errors.map((error) => <li key={error}>{error}</li>)}</ul>
            <p>No close request was created.</p>
          </div>
        )}
      </div>
    </form>
  );
}
