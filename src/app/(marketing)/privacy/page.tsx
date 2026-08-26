import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = { title: "Privacy", description: "Privacy information for the Business Finlynq public demo.", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return (
    <LegalPage eyebrow="Privacy" title="A demo designed for synthetic data." intro="Last updated August 26, 2026. This notice covers the public Business Finlynq website and hosted demo.">
      <section><h2>Information processed</h2><p>The service processes basic request metadata needed for security and operations, such as time, route, coarse network address information, and user-agent data. Security controls store keyed hashes rather than raw email or IP values where practical.</p></section>
      <section><h2>Account information</h2><p>Eligible organization accounts store an encrypted email address, encrypted display profile, password hash, memberships, roles, and revocable session records. Passwords and raw session tokens are never stored.</p></section>
      <section><h2>Public demo</h2><p>The demo contains public synthetic records. Do not enter personal, financial, confidential, or customer information. Demo sessions are temporary and the demo does not provide a private workspace.</p></section>
      <section><h2>Service providers</h2><p>Hosting and transactional email providers may process the minimum information needed to operate the service. Provider configuration and data-processing terms must be reviewed before non-demo customer onboarding.</p></section>
      <section><h2>Retention and requests</h2><p>Security events and session records are retained for operational and audit needs. A production retention schedule and contact process must be published before accepting customer data.</p></section>
    </LegalPage>
  );
}
