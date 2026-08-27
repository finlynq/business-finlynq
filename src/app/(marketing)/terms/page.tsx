import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = { title: "Terms", description: "Terms for the Business Finlynq public website and demo.", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return (
    <LegalPage eyebrow="Demo terms" title="Use the preview as a preview." intro="Last updated August 27, 2026. These short terms apply to the public website and synthetic demo while the hosted service is in preview.">
      <section><h2>Preview status</h2><p>The hosted application is a writable but disposable product demonstration, not a production bookkeeping service. Each browser receives an isolated synthetic sandbox whose changes persist through logout and session expiry, then reset during nightly maintenance. Emergency maintenance may reset it sooner. It must not be used to make tax, legal, accounting, or financial decisions or to preserve records.</p></section>
      <section><h2>Acceptable use</h2><p>Do not attempt to access another user or organization, evade security controls, disrupt the service, upload malicious content, or enter real confidential data into the public demo.</p></section>
      <section><h2>No warranty</h2><p>The demo is provided as available and may change or be withdrawn. Synthetic figures and tax examples are illustrative and are not professional advice.</p></section>
      <section><h2>Open-source license</h2><p>The source code is available under AGPL-3.0-or-later. The license governs copying, modification, and distribution of the code; these hosted-demo terms govern use of this deployment.</p></section>
      <section><h2>Production onboarding</h2><p>Customer-specific commercial terms, service levels, support, privacy commitments, and data-processing terms must be agreed separately before production customer data is accepted.</p></section>
    </LegalPage>
  );
}
