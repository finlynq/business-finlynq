"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AccountingConfigurationDto } from "@/modules/ledger/accounting-configuration";
import { MutationFeedback } from "./mutation-feedback.client";

type Registration = AccountingConfigurationDto["taxRegistrations"][number];
export function TaxRegistrationScope({ registration, canCorrect }: { registration: Registration; canCorrect: boolean }) {
  const router = useRouter();
  const provincial = registration.regimeKey === "ca.on.hst";
  const [city, setCity] = useState(provincial ? "" : registration.destinationCity ?? "");
  const [location, setLocation] = useState(provincial ? "" : registration.locationCode ?? "");
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setBusy(true); setFeedback(null);
    try {
      const response = await fetch("/api/accounting/configuration/tax-registrations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        registrationId: registration.id, expectedScopeVersion: registration.scopeVersion,
        destinationCity: city || null, locationCode: location || null,
        configurationEvidence: form.get("evidence"), reason: form.get("reason"),
        preservePostedEvidence: form.get("preserve") === "on", idempotencyKey: key,
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The registration correction could not be saved.");
      setFeedback({ kind: "success", message: `Scope version ${result.scopeVersion} saved. Posted documents and tax evidence were preserved.` });
      router.refresh();
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : "The correction could not be saved." }); }
    finally { setBusy(false); }
  }
  return <>
    <small>Scope version {registration.scopeVersion}</small>
    <details><summary>Scope history</summary><ul>{registration.scopeHistory.map((version) => <li key={version.version}>
      Version {version.version}: {version.destinationCity ?? "Province/region scope"}{version.locationCode ? ` · ${version.locationCode}` : ""}. {version.reason}
      {version.createdAt && <small>{new Date(version.createdAt).toLocaleString()}</small>}
      {version.configurationEvidence && <small>{version.configurationEvidence}</small>}
    </li>)}</ul></details>
    {canCorrect && <details><summary>Correct registration scope</summary><form className="close-form" onSubmit={(event) => void correct(event)}>
      <p>Correct the sourcing scope for {registration.entityCode}. The registration reference, country, region and validity dates stay attached to the same registration. Posted evidence is retained unchanged.</p>
      {provincial ? <p>Ontario HST registration covers Ontario. The customer’s actual city remains on each invoice.</p> : <>
        <label><span>Registration city</span><input value={city} onChange={(event) => setCity(event.target.value)} maxLength={100} disabled={busy} /></label>
        <label><span>Location code</span><input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={40} disabled={busy} /></label>
        <p className="panel-note">Supported city-specific regimes still require an exact city and authority location. Seattle uses location 1726.</p>
      </>}
      <label><span>Scope correction evidence</span><input name="evidence" minLength={8} maxLength={1000} required disabled={busy} /></label>
      <label><span>Correction reason</span><input name="reason" minLength={8} maxLength={500} required disabled={busy} /></label>
      <label className="document-sharing-consent"><input type="checkbox" name="preserve" required disabled={busy} /><span>I understand that historical posted tax evidence stays unchanged. Review affected unposted drafts against the corrected scope.</span></label>
      <button className="secondary-button" disabled={busy}>{busy ? "Saving…" : "Save scope correction"}</button>
    </form></details>}
    {feedback && <MutationFeedback kind={feedback.kind} message={feedback.message} onDismiss={() => setFeedback(null)} />}
  </>;
}
