import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = { title: "Terms", description: "Terms for the Business Finlynq public website and demo.", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return (
    <LegalPage eyebrow="Preview terms" title="Use the preview as a preview." intro="Last updated August 27, 2026. These short terms apply to the public website, synthetic demo, and self-service organization workspaces while the hosted service is in preview.">
      <section><h2>Preview status</h2><p>The hosted application is an evaluation preview, not a production bookkeeping service or durable system of record. The public demo is a disposable synthetic sandbox that resets during nightly maintenance and may reset sooner for emergency maintenance. Self-service organization workspaces are not part of that nightly demo reset, but the preview may change, become unavailable, or lose data, and these terms do not provide a backup, retention, or service-level commitment. Do not rely on the preview to preserve records or make tax, legal, accounting, or financial decisions.</p></section>
      <section><h2>Acceptable use</h2><p>Do not attempt to access another user or organization, evade security controls, disrupt the service, or upload malicious content. Do not enter regulated, confidential, customer, or production financial data into this hosted preview.</p></section>
      <section><h2>No warranty</h2><p>The demo is provided as available and may change or be withdrawn. Synthetic figures and tax examples are illustrative and are not professional advice.</p></section>
      <section><h2>Open-source license</h2><p>The source code is available under AGPL-3.0-or-later. The license governs copying, modification, and distribution of the code; these hosted-demo terms govern use of this deployment.</p></section>
      <section><h2>Production onboarding</h2><p>A production service would require separate, customer-specific terms covering service levels, support, privacy, retention, and data processing before production customer data is accepted. These preview terms do not provide those commitments.</p></section>
    </LegalPage>
  );
}
