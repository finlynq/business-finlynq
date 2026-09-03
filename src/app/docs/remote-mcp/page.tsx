import Link from "next/link";
import { PageHeader } from "@/app/_components/ui";
import { MCP_OAUTH_SCOPES } from "@/modules/mcp/protocol";

export default function RemoteMcpDocumentationPage() {
  const configuredOrigin = process.env.BUSINESS_FINLYNQ_PUBLIC_URL?.trim() || process.env.APP_ORIGIN?.trim();
  const endpoint = configuredOrigin ? new URL("/mcp", configuredOrigin).href : "/mcp";
  return (
    <main className="page-content">
      <PageHeader
        eyebrow="Integration guide"
        title="Remote accounting MCP"
        description="Connect a standards-compatible AI client to FinLynQ using HTTPS, OAuth 2.1 authorization code flow, PKCE S256, dynamic client registration, and resource-bound bearer tokens."
        actions={<Link className="secondary-button" href="/app/settings/mcp">Manage connections</Link>}
      />
      <section className="panel form-panel">
        <div className="panel-heading"><div><p className="eyebrow">Server</p><h2>Connection details</h2></div></div>
        <div className="close-form">
          <label className="full-field"><span>MCP server URL</span><input readOnly value={endpoint} /></label>
          <p>Discovery is available through OAuth authorization-server and protected-resource metadata. Clients register as public clients and must use an exact registered redirect URI and PKCE S256.</p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Least privilege</p><h2>Scopes and tool groups</h2></div></div>
        <div className="table-scroll"><table><thead><tr><th>Scope</th><th>Purpose</th></tr></thead><tbody>
          <tr><td><code>{MCP_OAUTH_SCOPES.dailyRead}</code></td><td>Journals, documents, banking observations, reconciliation state, tax review, and reports.</td></tr>
          <tr><td><code>{MCP_OAUTH_SCOPES.dailyWrite}</code></td><td>Daily entries, invoices, bills, settlements, reconciliation, and permitted posting workflows.</td></tr>
          <tr><td><code>{MCP_OAUTH_SCOPES.setupRead}</code></td><td>Accounting configuration, parties, chart context, periods, and hierarchies.</td></tr>
          <tr><td><code>{MCP_OAUTH_SCOPES.setupWrite}</code></td><td>Accounts, parties, entities, dimensions, currencies, tax registrations, policies, and bank mappings.</td></tr>
          <tr><td><code>{MCP_OAUTH_SCOPES.offlineAccess}</code></td><td>Rotating refresh token for a connection that should survive the ten-minute access-token lifetime.</td></tr>
        </tbody></table></div>
        <p className="panel-note">OAuth scope is only the outer boundary. Every request also checks the connection&apos;s Daily/Setup mode, optional per-tool override, current organization membership, live role permissions, organization write state, and the accounting workflow&apos;s own controls.</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Payables</p><h2>Bank and non-cash supplier settlements</h2></div></div>
        <p><code>finlynq_daily_record_supplier_payment</code> accepts <code>settlementAccountCombinationId</code> and <code>settlementMethod</code>: BANK, CORPORATE_CARD, SHAREHOLDER_ADVANCE, EMPLOYEE_REIMBURSEMENT, or OTHER_NON_CASH.</p>
        <p>BANK requires a non-control asset account; the other methods require a non-control liability account in the same ledger and entity. Legacy <code>bankAccountCombinationId</code> remains supported for bank settlements. A shareholder-funded bill debits AP and credits the shareholder liability, without reducing corporate cash. No bank transfer is initiated.</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Source evidence</p><h2>Attach invoices and receipts</h2></div></div>
        <ol>
          <li>Upload a PDF, PNG, or JPEG up to 2 MiB with <code>finlynq_daily_upload_document_evidence</code>. Supply module, filename, MIME type, exact byte size, SHA-256, base64 content, and an idempotency key.</li>
          <li>Use <code>finlynq_daily_attach_document_evidence</code> with the returned asset ID, document kind/number, exact current draft version, purpose, reason, and another idempotency key. Each attachment creates a new version.</li>
          <li><code>finlynq_daily_get_document</code> returns attachment metadata and authenticated download links. Explicit binary downloads use <code>finlynq_daily_download_document_evidence</code>.</li>
          <li><code>finlynq_daily_detach_document_evidence</code> only changes a draft. Historical links remain retained; editing, posting, and voiding preserve evidence.</li>
        </ol>
        <p>Files are encrypted, malware-scanned, and tenant-scoped. Every read rechecks authorization. No arbitrary file URLs are fetched. View linked files in a bill or invoice&apos;s View details → Source documents section.</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Write safety</p><h2>Confirmation and audit behavior</h2></div></div>
        <ul>
          <li>New daily write access asks for confirmation; setup is off until the user enables it.</li>
          <li>A confirmation is bound to one tool and an exact canonical argument hash, expires after 15 minutes, and is consumed once.</li>
          <li>Allow writes bypasses per-action approval. High-assurance setup and reconciliation writes use the recent MFA verification captured when direct access is enabled; the user must verify and save the policy again after that window expires.</li>
          <li>Transactions keep FinLynQ&apos;s idempotency, balance, period, content-hash, maker-checker, tax, FX, and subledger controls.</li>
          <li>Agents cannot receive credentials, administer users, change recovery controls, or initiate bank transfers.</li>
        </ul>
      </section>
    </main>
  );
}
