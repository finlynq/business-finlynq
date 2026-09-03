import type { Metadata } from "next";
import { LegalPage } from "../_components/legal-page";

export const metadata: Metadata = { title: "Security", description: "Business Finlynq security architecture and current launch boundaries.", alternates: { canonical: "/security" } };

export default function SecurityPage() {
  return (
    <LegalPage eyebrow="Security architecture" title="Controls that fail closed." intro="Business Finlynq separates identity, organization keys, accounting data, and public demo access. This page describes the architecture—not a third-party certification.">
      <section><h2>Identity and sessions</h2><p>Browser sessions use random 256-bit opaque tokens. Only a SHA-256 digest is stored in PostgreSQL. Sessions have idle and absolute expiry, are revocable immediately, and are rechecked against active organization membership.</p></section>
      <section><h2>Encryption boundary</h2><p>Organization data encryption keys are wrapped by a root key mounted as a server secret. User passwords do not wrap organization keys, so password recovery can revoke sessions and replace a credential without erasing accounting records.</p></section>
      <section><h2>Accounting integrity</h2><p>Tenant context is set inside database transactions. Posted records and source events are guarded against ordinary updates or deletion. Period states, role permissions, and source-module ownership are designed as server-side controls.</p></section>
      <section><h2>Public demo</h2><p>Every browser opens a separate short-lived session in the same encrypted synthetic organization, so visitors see one another’s changes. Sessions expire after 15 minutes idle or one hour total. At 04:15 America/Toronto, the reset process fences new work, revokes every demo session, deletes the shared organization’s mutable accounting data, reseeds it, verifies the baseline, and reopens access. Speculative browser requests cannot create a demo session.</p></section>
      <section><h2>Current release boundary</h2><p><code>DEMO_LOGIN_ENABLED=true</code> and <code>DEMO_WRITES_ENABLED=true</code> permit accounting changes only through a live demo-link session in the shared <code>PUBLIC_DEMO</code> organization. The demo accountant has the same in-app accounting permissions as a standard owner, including a clearly labeled demo-only privileged-action simulation. It still cannot administer key recovery, send real email, connect external banks, execute payments, file taxes, publish webhooks, or issue public MCP credentials.</p></section>
      <section><h2>Report a vulnerability</h2><p>Use the repository’s <a href="https://github.com/finlynq/business-finlynq/security/advisories/new" rel="noreferrer">private GitHub security advisory form</a>. Do not include real customer or credential data in a public issue.</p></section>
    </LegalPage>
  );
}
