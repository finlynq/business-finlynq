import { DemoNotice, PageHeader } from "../../_components/ui";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

const allowed = ["ledger:read", "open-items:read", "journal-draft:create"] as const;
const denied = ["journal:post", "approval:self", "period:reopen", "role:change", "history:delete", "key:recover"] as const;

export default async function AutomationPage() {
  await requireWorkspacePrincipal("/app/automation");
  return (
    <div className="page-content">
      <PageHeader eyebrow="Controlled automation" title="AI & MCP access" description="The future MCP surface uses the same tenant authorization, RLS transaction context, idempotency, and audit path as the UI." />
      <DemoNotice>
        No public MCP endpoint or OAuth service principal is active in this deployment. The scopes below are the approved v0 contract for demo and standard accounts, not a live connection.
      </DemoNotice>
      <div className="scope-grid">
        <section className="panel scope-panel" aria-labelledby="allowed-title"><div className="panel-heading"><div><p className="eyebrow">Approved v0 boundary</p><h2 id="allowed-title">Read and prepare</h2></div></div><ul>{allowed.map((scope) => <li key={scope}><code>{scope}</code><span>Allowed only after organization-bound OAuth and audit are implemented.</span></li>)}</ul></section>
        <section className="panel scope-panel denied-scopes" aria-labelledby="denied-title"><div className="panel-heading"><div><p className="eyebrow">Never delegated</p><h2 id="denied-title">Human/security controls</h2></div></div><ul>{denied.map((scope) => <li key={scope}><code>{scope}</code><span>Unavailable to MCP and AI.</span></li>)}</ul></section>
      </div>
      <section className="automation-callout"><span className="automation-mark" aria-hidden="true">AI</span><div><h2>AI can prepare the work—not approve itself</h2><p>Draft creation remains idempotent and reviewable. A service principal cannot self-approve, post, reopen periods, change roles, recover keys, or delete history.</p></div></section>
    </div>
  );
}
