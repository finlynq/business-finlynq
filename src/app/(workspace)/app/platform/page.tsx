import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/_components/ui";
import { loadPlatformAdministrationOverview } from "@/modules/identity/platform-administration";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export default async function PlatformAdministrationPage() {
  const principal = await requireWorkspacePrincipal("/app/platform");
  const overview = await loadPlatformAdministrationOverview(principal);
  if (!overview) notFound();

  const metrics = [
    {
      label: "Real organizations",
      value: overview.activeRealOrganizationCount,
      note: "Active non-demo organizations",
      tone: "blue",
    },
    {
      label: "Real users",
      value: overview.activeRealUserCount,
      note: "Active users with active real-organization access",
      tone: "green",
    },
    {
      label: "Live sessions",
      value: overview.activeRealSessionCount,
      note: "Unexpired, non-revoked real sessions",
      tone: "purple",
    },
    {
      label: "Pending administrators",
      value: overview.pendingPlatformAdministratorCount,
      note: "Reserved grants awaiting verified identity assurance",
      tone: "amber",
    },
    {
      label: "Linked administrators",
      value: overview.linkedPlatformAdministratorCount,
      note: "Grants linked to verified real identities with MFA",
      tone: "green",
    },
  ] as const;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Read-only control plane"
        title="Platform operations"
        description="Aggregate service metadata for Business Finlynq. This role does not bypass organization encryption or expose tenant accounting records."
        actions={<Link className="secondary-button" href="/app">Return to organization</Link>}
      />

      <section aria-labelledby="platform-summary-title">
        <div className="section-heading">
          <div><p className="eyebrow">Operational overview</p><h2 id="platform-summary-title">Platform posture</h2></div>
          <span className="subtle-label">
            Generated <time dateTime={overview.generatedAt.toISOString()}>{overview.generatedAt.toISOString()}</time>
          </span>
        </div>
        <div className="metric-grid">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <span className={`metric-signal signal-${metric.tone}`} aria-hidden="true" />
              <p>{metric.label}</p>
              <div><strong>{metric.value}</strong></div>
              <span>{metric.note}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="platform-boundary-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Security boundary</p><h2 id="platform-boundary-title">Control plane, not tenant access</h2></div>
        </div>
        <p className="panel-note">
          This first platform surface is intentionally read-only and aggregate-only. It includes no organization names,
          user identity fields, grant identifiers, ledger balances, customer records, or mutation controls. Any future
          platform change will require a separate audited operation and a fresh MFA step-up inside the database transaction.
        </p>
      </section>
    </div>
  );
}
