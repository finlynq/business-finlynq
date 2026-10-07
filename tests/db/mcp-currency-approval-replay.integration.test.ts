import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { configureOrganizationCurrency } from "@/modules/ledger/accounting-configuration";
import { authorizeMcpWrite, type McpAuthorizationSnapshot } from "@/modules/mcp/connection-policy";
import { mcpSessionPrincipal } from "@/modules/mcp/oauth-store";
import { decideMcpApproval } from "@/modules/mcp/settings-store";
import type { SessionPrincipal } from "@/modules/identity/session";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const run = ownerUrl && appUrl ? describe : describe.skip;
const ids = {
  organization: randomUUID(),
  actor: randomUUID(),
  membership: randomUUID(),
  browserSession: randomUUID(),
  connection: randomUUID(),
  role: randomUUID(),
};
const clientId = `finlynq_${randomUUID()}`;
const command = { currencyCode: "EUR", enabled: true, reason: "Enable EUR payments" };
const tool = { name: "finlynq_setup_configure_currency", group: "SETUP" as const, access: "WRITE" as const };

run("approved MCP currency replay in PostgreSQL", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  let browser: SessionPrincipal;
  let snapshot: McpAuthorizationSnapshot;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", appUrl);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await owner.query(
      `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at)
       VALUES ($1,$2,'MCP currency approval test',true,false,'REAL',now())`,
      [ids.organization, `mcp-currency-${ids.organization.slice(0, 12)}`],
    );
    await owner.query(
      `INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active)
       VALUES ($1,$2,'encrypted-owner','password-hash',true)`,
      [ids.actor, `mcp-currency-user-${ids.actor}`],
    );
    await owner.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES ($1,$2,$3,true)`,
      [ids.membership, ids.organization, ids.actor],
    );
    await owner.query(
      `INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,
         auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,
         expires_at,mfa_verified_at,step_up_expires_at)
       VALUES ($1,$2,$3,$4,$5,'PASSWORD','REAL',repeat('a',64),7200,
         now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '10 minutes')`,
      [ids.browserSession, `mcp-currency-session-${ids.browserSession}`, ids.actor, ids.organization, ids.membership],
    );
    await owner.query(
      `INSERT INTO roles(id,organization_id,key,display_name,system_template)
       VALUES ($1,$2,'MCP_CURRENCY_APPROVER_TEST','MCP currency approver',false)`,
      [ids.role, ids.organization],
    );
    await owner.query(
      `INSERT INTO role_permissions(organization_id,role_id,permission_key)
       VALUES ($1,$2,'organization.settings.manage')`,
      [ids.organization, ids.role],
    );
    await owner.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [ids.organization, ids.membership, ids.role, ids.actor],
    );
    await owner.query(
      `INSERT INTO mcp_oauth_clients(client_id,client_name,redirect_uris)
       VALUES ($1,'MCP currency test',ARRAY['https://client.example/callback'])`,
      [clientId],
    );
    await owner.query(
      `INSERT INTO mcp_connections(id,organization_id,user_id,membership_id,client_id,client_name,
         scopes,setup_mode)
       VALUES ($1,$2,$3,$4,$5,'MCP currency test',ARRAY['mcp:setup:write'],'CONFIRM_WRITES')`,
      [ids.connection, ids.organization, ids.actor, ids.membership, clientId],
    );
    const stepUpExpiresAt = (await owner.query<{ step_up_expires_at: Date }>(
      "SELECT step_up_expires_at FROM auth_sessions WHERE id=$1", [ids.browserSession],
    )).rows[0]!.step_up_expires_at;
    browser = {
      sessionId: ids.browserSession,
      userId: ids.actor,
      organizationId: ids.organization,
      membershipId: ids.membership,
      organizationName: "MCP currency approval test",
      roleLabel: "Owner",
      displayName: "Owner",
      initials: "OW",
      sessionMode: "real",
      authMethod: "PASSWORD",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
      stepUpExpiresAt,
      organizationWritesEnabled: true,
    };
    snapshot = {
      principal: {
        connectionId: ids.connection,
        organizationId: ids.organization,
        userId: ids.actor,
        membershipId: ids.membership,
        organizationName: browser.organizationName,
        roleLabel: browser.roleLabel,
        clientId,
        clientName: "MCP currency test",
        scopes: ["mcp:setup:write"],
        resource: "https://finlynq.test/mcp",
        dailyMode: "OFF",
        setupMode: "CONFIRM_WRITES",
        toolOverrides: {},
        tokenExpiresAt: new Date(Date.now() + 60_000),
        organizationWritesEnabled: true,
      },
      permissions: new Set(["organization.settings.manage"]),
      dailyMode: "OFF",
      setupMode: "CONFIRM_WRITES",
      toolOverrides: {},
      directWriteSessionId: null,
      directWriteStepUpExpiresAt: null,
      connectionVersion: 1,
    };
  });

  afterAll(async () => {
    await closeDatabasePool();
    await owner.end();
    vi.unstubAllEnvs();
  });

  it("consumes an exact approval, writes using the approving session, and requires reapproval for another retry", async () => {
    const requested = await authorizeMcpWrite(snapshot, tool, command, "https://finlynq.test/mcp");
    expect(requested).toMatchObject({ allowed: false, approvalId: expect.any(String) });
    expect(await decideMcpApproval(browser, { approvalId: requested.approvalId!, decision: "APPROVED" })).toBe(true);

    const authorized = await authorizeMcpWrite(snapshot, tool, command, "https://finlynq.test/mcp");
    expect(authorized).toMatchObject({ allowed: true, approvalId: requested.approvalId, delegatedSessionId: ids.browserSession });
    const principal = mcpSessionPrincipal(snapshot.principal, authorized.stepUpExpiresAt, authorized.delegatedSessionId);
    await expect(configureOrganizationCurrency({ ...command, principal, requestId: `mcp-tool:${randomUUID()}` })).resolves.toEqual({ enabled: true });

    expect((await owner.query<{ enabled: boolean }>(
      "SELECT enabled FROM organization_currencies WHERE organization_id=$1 AND currency_code='EUR'",
      [ids.organization],
    )).rows[0]?.enabled).toBe(true);
    expect(await authorizeMcpWrite(snapshot, tool, command, "https://finlynq.test/mcp")).toMatchObject({ allowed: false });
  });
});
