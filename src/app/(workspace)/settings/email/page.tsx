import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { mutationContext } from "@/modules/workspace/write-policy";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { PersonalInboundAddress } from "@/app/_components/personal-inbound-address.client";
import { SettingsNavigation } from "@/app/_components/route-tabs";
import {
  getEmailDeliverySettings,
  getPersonalEmailAlias,
  listEmailAliases,
  listEmailBookingRules,
  listPaymentProfiles,
} from "@/modules/email/configuration";
import { loadEmailOperations } from "@/modules/email/operations";
import { listStorageConnections } from "@/modules/document-storage/connections";

export const dynamic = "force-dynamic";

function CountList({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values);
  return entries.length
    ? <ul className="email-count-list">{entries.map(([label, count]) => <li key={label}><span>{label.replaceAll("_", " ")}</span><strong>{count}</strong></li>)}</ul>
    : <p className="panel-note">No activity yet.</p>;
}

export default async function EmailAutomationPage() {
  const principal = await requireWorkspacePrincipal("/app/settings/email");
  const context = mutationContext(principal, `email-settings:${randomUUID()}`, { reason: "View email automation operations", sourceSurface: "UI" });
  const data = principal.sessionMode === "real" ? await Promise.all([
    listEmailAliases(context), listEmailBookingRules(context), listPaymentProfiles(context),
    getEmailDeliverySettings(context), loadEmailOperations(context),
    getPersonalEmailAlias(context, principal.membershipId), listStorageConnections(context),
  ]) : null;
  const aliases = data?.[0] ?? [];
  const rules = data?.[1] ?? [];
  const profiles = data?.[2] ?? [];
  const settings = data?.[3] ?? null;
  const operations = data?.[4] ?? null;
  const personalAlias = data?.[5] ?? null;
  const storageConnections = data?.[6] ?? [];
  return <div className="page-content email-operations-page">
    <PageHeader eyebrow="Email-to-books" title="Invoice email automation"
      description="Monitor tenant-safe supplier-invoice ingest, guarded AP rules, customer invoice PDFs and delivery without exposing message bodies or payment credentials."
      actions={<><Link className="secondary-button" href="/app/settings/documents">Document inbox</Link><Link className="primary-button" href="/app/settings/mcp">Configure with AI & MCP</Link></>} />
    <SettingsNavigation active="email" />
    {!data && <DemoNotice>Email providers and external delivery are disabled in the shared demo.</DemoNotice>}
    {operations && <>
      <PersonalInboundAddress initialAlias={personalAlias} connections={storageConnections} />
      <section className="email-readiness-grid" aria-label="Email provider readiness">
        <article className="panel"><p className="eyebrow">Inbound provider</p><h2>{operations.readiness.inbound ? "Ready" : "Needs configuration"}</h2><p>{operations.readiness.inboundDomain ?? "No environment domain"}</p></article>
        <article className="panel"><p className="eyebrow">Outbound provider</p><h2>{operations.readiness.outbound ? "Ready" : "Needs configuration"}</h2><p>{operations.readiness.outboundDomain ?? "No verified sending domain"}</p></article>
        <article className="panel"><p className="eyebrow">Organization policy</p><h2>{settings?.outboundEnabled ? "Outbound enabled" : "Outbound disabled"}</h2><p>{settings?.autoSendEnabled ? "Opted-in customers may auto-send" : "Manual send only"}</p></article>
        <article className="panel"><p className="eyebrow">Oldest queued work</p><h2>{operations.metrics.oldestQueueSeconds}s</h2><p>Retries are bounded and idempotent.</p></article>
      </section>
      <section className="email-metric-grid" aria-label="Email processing totals">
        <article className="panel"><div className="panel-heading"><h2>Inbound messages</h2></div><CountList values={operations.metrics.inboundMessages} /></article>
        <article className="panel"><div className="panel-heading"><h2>Attachments</h2></div><CountList values={operations.metrics.attachments} /></article>
        <article className="panel"><div className="panel-heading"><h2>Customer delivery</h2></div><CountList values={operations.metrics.deliveries} /></article>
      </section>
      <section className="panel" aria-labelledby="email-aliases-title">
        <div className="panel-heading"><div><p className="eyebrow">Inbound routing</p><h2 id="email-aliases-title">Organization aliases</h2></div><span className="demo-chip">{aliases.length}</span></div>
        {aliases.length ? <div className="table-shell"><table><thead><tr><th>Label</th><th>Address</th><th>Purpose</th><th>Status</th><th>Limit</th></tr></thead><tbody>{aliases.map((alias) => <tr key={alias.id}><td>{alias.label}</td><td><code>{alias.address}</code></td><td>{alias.purpose}</td><td>{alias.status}</td><td>{alias.hourlyLimit}/hour</td></tr>)}</tbody></table></div> : <p className="panel-note">No aliases are configured. Create one with the setup MCP tools after connecting OneDrive.</p>}
      </section>
      <section className="email-metric-grid">
        <article className="panel"><div className="panel-heading"><div><p className="eyebrow">AP controls</p><h2>Booking rules</h2></div><span className="demo-chip">{rules.length}</span></div>{rules.slice(0, 8).map((rule) => <div className="email-list-row" key={rule.id}><div><strong>{rule.name}</strong><span>{rule.mode} · v{rule.version}</span></div><span>{rule.active ? "Active" : "Inactive"}</span></div>)}</article>
        <article className="panel"><div className="panel-heading"><div><p className="eyebrow">Remittance</p><h2>Payment profiles</h2></div><span className="demo-chip">{profiles.length}</span></div>{profiles.slice(0, 8).map((profile) => <div className="email-list-row" key={profile.id}><div><strong>{profile.name}</strong><span>{profile.currencyCode} · v{profile.version}</span></div><span>{profile.active ? profile.isDefault ? "Default" : "Active" : "Retired"}</span></div>)}</article>
      </section>
      <section className="panel" aria-labelledby="inbound-activity-title">
        <div className="panel-heading"><div><p className="eyebrow">Recent inbound</p><h2 id="inbound-activity-title">Message processing</h2></div></div>
        {operations.messages.length ? <div className="table-shell"><table><thead><tr><th>Received</th><th>Alias</th><th>Sender</th><th>Subject</th><th>Status</th><th>Retries</th></tr></thead><tbody>{operations.messages.map((message) => <tr key={message.id}><td>{new Date(message.receivedAt).toLocaleString("en-CA")}</td><td>{message.aliasLabel}</td><td>{message.sender}</td><td>{message.subject || "—"}</td><td>{message.status}</td><td>{message.retryCount}</td></tr>)}</tbody></table></div> : <p className="panel-note">No inbound messages have been received.</p>}
      </section>
      <section className="panel" aria-labelledby="delivery-activity-title">
        <div className="panel-heading"><div><p className="eyebrow">Recent outbound</p><h2 id="delivery-activity-title">Invoice delivery</h2></div></div>
        {operations.deliveries.length ? <div className="table-shell"><table><thead><tr><th>Created</th><th>Invoice version</th><th>Status</th><th>Failure</th><th>Retries</th></tr></thead><tbody>{operations.deliveries.map((delivery) => <tr key={delivery.id}><td>{new Date(delivery.createdAt).toLocaleString("en-CA")}</td><td><code>{delivery.sourceDocumentId.slice(0, 8)}</code></td><td>{delivery.status}</td><td>{delivery.failureCode ?? "—"}</td><td>{delivery.retryCount}</td></tr>)}</tbody></table></div> : <p className="panel-note">No customer invoice deliveries have been attempted.</p>}
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Retention</p><h2>Minimized transient data</h2></div></div><p className="panel-note">Message bodies: {settings?.transientRetentionDays ?? 30} days · Quarantine: {settings?.quarantineRetentionDays ?? 30} days · Operational details: {settings?.operationRetentionDays ?? 90} days. Immutable accounting evidence and delivery events are preserved.</p></section>
    </>}
  </div>;
}

export const metadata = { title: "Invoice email automation" };
