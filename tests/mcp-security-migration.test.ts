import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schemaMigration = readFileSync("migrations/drizzle/0034_clean_praxagora.sql", "utf8");
const securityMigration = readFileSync("migrations/drizzle/0035_remote_mcp_security.sql", "utf8");
const assuranceMigration = readFileSync("migrations/drizzle/0036_mcp_approval_assurance.sql", "utf8");
const sessionBindingMigration = readFileSync("migrations/drizzle/0038_mcp_approval_session_binding.sql", "utf8");
const settingsStore = readFileSync("src/modules/mcp/settings-store.ts", "utf8");
const connectionPolicy = readFileSync("src/modules/mcp/connection-policy.ts", "utf8");
const oauthStore = readFileSync("src/modules/mcp/oauth-store.ts", "utf8");
const runtimeGrants = readFileSync("deploy/postgres/010-runtime-role.sh", "utf8");
const verifier = readFileSync("scripts/operations/verify-database-schema.mjs", "utf8");

describe("remote MCP database security contract", () => {
  it("persists OAuth credentials, connections, approvals, and immutable execution evidence", () => {
    for (const table of ["mcp_oauth_clients", "mcp_connections", "mcp_oauth_codes", "mcp_access_tokens", "mcp_refresh_tokens", "mcp_approvals", "mcp_tool_executions"]) {
      expect(schemaMigration).toContain(`CREATE TABLE \"${table}\"`);
    }
    expect(schemaMigration).not.toContain("access_token\" text");
    expect(schemaMigration).toContain("token_hash");
  });

  it("forces tenant-and-user RLS on every user-bound MCP table", () => {
    expect(securityMigration).toContain("FORCE ROW LEVEL SECURITY");
    expect(securityMigration).toContain("organization_id = app.current_organization_id() AND user_id = app.current_actor_id()");
    expect(securityMigration).toContain("CREATE POLICY mcp_user_isolation");
    expect(verifier).toContain("const userBoundRlsTables");
    expect(verifier).toContain('name: "mcp_user_isolation"');
  });

  it("does not grant access to the users table and exposes only a boolean active-user check", () => {
    expect(runtimeGrants).not.toMatch(/GRANT SELECT ON TABLE public\.users/);
    expect(runtimeGrants).toContain("app.mcp_user_is_active(uuid)");
    expect(securityMigration).toContain("SECURITY DEFINER");
    expect(securityMigration).toContain("REVOKE ALL ON FUNCTION app.mcp_user_is_active(uuid) FROM PUBLIC");
  });

  it("delegates high assurance only from an explicit unexpired browser MFA approval", () => {
    expect(assuranceMigration).toContain("mfa_step_up_expires_at");
    expect(sessionBindingMigration).toContain("mfa_session_id");
    expect(sessionBindingMigration).toContain("direct_write_session_id");
    expect(sessionBindingMigration).toContain("REFERENCES \"public\".\"auth_sessions\"");
    expect(settingsStore).toContain("input.decision === \"APPROVED\" && requiresStepUp ? principal.sessionId : null");
    expect(settingsStore).toContain("input.decision === \"APPROVED\" && requiresStepUp ? principal.stepUpExpiresAt : null");
    expect(connectionPolicy).toContain("mfa_step_up_expires_at > now()");
    expect(connectionPolicy).toContain("mfa_session_id IS NOT NULL");
    expect(connectionPolicy).toContain("delegatedSessionId: approved.rows[0].mfa_session_id");
    expect(oauthStore).toContain("stepUpExpiresAt: delegatedStepUpExpiry");
    expect(oauthStore).toContain("sessionId: delegatedSessionId ?? principal.connectionId");
    expect(oauthStore).not.toContain("stepUpExpiresAt: principal.tokenExpiresAt");
  });

  it("permits controlled MCP posting but keeps import posting blocked", () => {
    expect(securityMigration).toContain("original_guard constant text := 'IN (''MCP'', ''IMPORT'')'");
    expect(securityMigration).toContain("replace(function_definition, original_guard, '= ''IMPORT''')");
    expect(securityMigration).toContain("same database permission, frozen-content, maker-checker, period, FX");
  });
});
