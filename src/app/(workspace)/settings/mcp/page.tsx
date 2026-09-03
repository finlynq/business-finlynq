import Link from "next/link";
import { McpSettings } from "@/app/_components/mcp-settings.client";
import { DemoNotice, PageHeader } from "@/app/_components/ui";
import { mfaStatusForSession } from "@/modules/identity/auth-store";
import { listUserMcpConnections } from "@/modules/mcp/connection-policy";
import { mcpResourceUrl } from "@/modules/mcp/protocol";
import { listPendingMcpApprovals } from "@/modules/mcp/settings-store";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export const dynamic = "force-dynamic";

export default async function McpSettingsPage() {
  const principal = await requireWorkspacePrincipal("/app/settings/mcp");
  const realUser = principal.sessionMode === "real";
  const [connections, approvals, authenticator] = realUser
    ? await Promise.all([
      listUserMcpConnections(principal),
      listPendingMcpApprovals(principal),
      mfaStatusForSession(principal.sessionId),
    ])
    : [[], [], null] as const;

  return (
    <div className="page-content">
      <PageHeader
        eyebrow="Secure agent access"
        title="AI & MCP connections"
        description="Connect Claude, ChatGPT, or another standards-compatible client over HTTPS. Every request is restricted to your current organization membership and live role permissions."
        actions={<Link className="secondary-button" href="/app/settings">Organization settings</Link>}
      />
      {!realUser && <DemoNotice>Remote OAuth connections are disabled in the public demo.</DemoNotice>}
      <McpSettings
        endpoint={mcpResourceUrl().href}
        initialConnections={connections}
        initialApprovals={approvals}
        enabled={realUser}
        mfaEnrollmentState={!authenticator
          ? "UNAVAILABLE"
          : authenticator.mfa_required && authenticator.active_factor
            ? "ENABLED"
            : authenticator.pending_enrollment
              ? "PENDING"
              : "NOT_ENROLLED"}
      />
    </div>
  );
}
