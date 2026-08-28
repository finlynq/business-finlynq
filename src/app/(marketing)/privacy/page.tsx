import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = { title: "Privacy", description: "Privacy information for the Business Finlynq hosted preview.", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return (
    <LegalPage eyebrow="Privacy" title="A hosted preview designed for evaluation." intro="Last updated August 27, 2026. This notice covers the public Business Finlynq website, synthetic demo, and self-service organization workspaces in the hosted preview.">
      <section><h2>Information processed</h2><p>The service processes basic request metadata needed for security and operations, such as time, route, coarse network address information, and user-agent data. Security controls store keyed hashes rather than raw email or IP values where practical.</p></section>
      <section><h2>Account information</h2><p>Self-service organization accounts process an encrypted email address, encrypted display profile, password hash, memberships, roles, and revocable session records. Passwords and raw session tokens are not stored. These workspaces are offered for evaluation under the preview terms; do not enter regulated, confidential, customer, or production financial data.</p></section>
      <section><h2>Public demo</h2><p>A host-only browser claim reserves one synthetic sandbox without storing the claim token itself in the database. The sandbox remains isolated and available to that browser until its nightly reset. It is not a confidential or durable customer workspace: do not enter personal, financial, confidential, or customer information.</p></section>
      <section><h2>Service providers</h2><p>Hosting and transactional email providers may process information needed to operate the preview. Provider configuration and data-processing terms must be reviewed before any production customer onboarding.</p></section>
      <section><h2>Retention and requests</h2><p>Security events and session records are retained for operational and audit needs. A production retention schedule and contact process must be published before accepting customer data.</p></section>
    </LegalPage>
  );
}
