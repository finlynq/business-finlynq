import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

const ids = {
  org: randomUUID(),
  actor: randomUUID(),
  otherActor: randomUUID(),
  membership: randomUUID(),
  otherMembership: randomUUID(),
  ownConnection: randomUUID(),
  otherConnection: randomUUID(),
  clientId: `finlynq_${randomUUID()}`,
};

runDatabaseTests("remote MCP PostgreSQL boundary", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  const runtime = new Pool({ connectionString: appUrl });

  async function asActor<T>(actorId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.org]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO organizations (id, slug, display_name)
       VALUES ($1, $2, 'MCP integration organization')`,
      [ids.org, `mcp-${ids.org.slice(0, 12)}`],
    );
    await owner.query(
      `INSERT INTO users (id, email_lookup_hash, email_ciphertext, password_hash, active)
       VALUES ($1, $2, 'cipher-a', 'password-hash', true),
              ($3, $4, 'cipher-b', 'password-hash', false)`,
      [ids.actor, `mcp-user-${ids.actor}`, ids.otherActor, `mcp-user-${ids.otherActor}`],
    );
    await owner.query(
      `INSERT INTO organization_memberships (id, organization_id, user_id, active)
       VALUES ($1,$2,$3,true), ($4,$2,$5,true)`,
      [ids.membership, ids.org, ids.actor, ids.otherMembership, ids.otherActor],
    );
    await owner.query(
      `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, 'Integration client', ARRAY['https://client.example/callback'])`,
      [ids.clientId],
    );
    await owner.query(
      `INSERT INTO mcp_connections (
         id, organization_id, user_id, membership_id, client_id, client_name, scopes
       ) VALUES ($1,$2,$3,$4,$5,'Other client',ARRAY['mcp:daily:read'])`,
      [ids.otherConnection, ids.org, ids.otherActor, ids.otherMembership, ids.clientId],
    );
  });

  afterAll(async () => {
    await owner.query("DELETE FROM mcp_tool_executions WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_approvals WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_access_tokens WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_refresh_tokens WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_oauth_codes WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_connections WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM mcp_oauth_clients WHERE client_id = $1", [ids.clientId]);
    await owner.query("DELETE FROM membership_roles WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM role_permissions WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM roles WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM organization_memberships WHERE organization_id = $1", [ids.org]);
    await owner.query("DELETE FROM users WHERE id IN ($1,$2)", [ids.actor, ids.otherActor]);
    await owner.query("DELETE FROM organizations WHERE id = $1", [ids.org]);
    await Promise.all([owner.end(), runtime.end()]);
  });

  it("allows only the current actor's rows inside the current organization", async () => {
    await asActor(ids.actor, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mcp_connections (
           id, organization_id, user_id, membership_id, client_id, client_name, scopes
         ) VALUES ($1,$2,$3,$4,$5,'Own client',ARRAY['mcp:daily:read'])
         RETURNING id`,
        [ids.ownConnection, ids.org, ids.actor, ids.membership, ids.clientId],
      );
      expect(inserted.rows[0]?.id).toBe(ids.ownConnection);
      const visible = await client.query<{ id: string }>(
        "SELECT id FROM mcp_connections WHERE organization_id = $1 ORDER BY id",
        [ids.org],
      );
      expect(visible.rows.map((row) => row.id)).toEqual([ids.ownConnection]);
      await expect(client.query(
        `INSERT INTO mcp_connections (
           organization_id, user_id, membership_id, client_id, client_name, scopes
         ) VALUES ($1,$2,$3,$4,'Forged client',ARRAY['mcp:daily:read'])`,
        [ids.org, ids.otherActor, ids.otherMembership, ids.clientId],
      )).rejects.toThrow(/row-level security/i);
    });
  });

  it("does not expose identity rows and returns only active-user status", async () => {
    await asActor(ids.actor, async (client) => {
      expect((await client.query<{ active: boolean }>("SELECT app.mcp_user_is_active($1) AS active", [ids.actor])).rows[0]?.active).toBe(true);
      expect((await client.query<{ active: boolean }>("SELECT app.mcp_user_is_active($1) AS active", [ids.otherActor])).rows[0]?.active).toBe(false);
      await expect(client.query("SELECT id FROM users LIMIT 1")).rejects.toThrow(/permission denied/i);
    });
  });

  it("keeps import blocked while removing only the historical MCP surface ban", async () => {
    const definition = (await owner.query<{ definition: string }>(
      "SELECT pg_get_functiondef('app.validate_journal_posting()'::regprocedure) AS definition",
    )).rows[0]?.definition ?? "";
    expect(definition).toContain("= 'IMPORT'");
    expect(definition).not.toContain("IN ('MCP', 'IMPORT')");
    expect(definition).toContain("app.current_actor_has_permission('ledger.journal.post')");
    expect(definition).toContain("app.compute_journal_content_hash(NEW.id)");
  });
});
