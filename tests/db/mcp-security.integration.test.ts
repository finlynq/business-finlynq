import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { beginMcpExecution, finishMcpExecution } from "@/modules/mcp/execution-store";
import type { McpAuthorizationSnapshot } from "@/modules/mcp/connection-policy";

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
      await client.query("SAVEPOINT forged_connection");
      await expect(client.query(
        `INSERT INTO mcp_connections (
           organization_id, user_id, membership_id, client_id, client_name, scopes
         ) VALUES ($1,$2,$3,$4,'Forged client',ARRAY['mcp:daily:read'])`,
        [ids.org, ids.otherActor, ids.otherMembership, ids.clientId],
      )).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK TO SAVEPOINT forged_connection");
    });
  });

  it("records concurrent read executions with collision-safe IDs and idempotent finalization", async () => {
    const snapshot: McpAuthorizationSnapshot = {
      principal: {
        connectionId: ids.ownConnection,
        organizationId: ids.org,
        userId: ids.actor,
        membershipId: ids.membership,
        organizationName: "MCP integration organization",
        roleLabel: "MCP test",
        clientId: ids.clientId,
        clientName: "Own client",
        scopes: ["mcp:daily:read"],
        resource: "https://finlynq.test/mcp",
        dailyMode: "READ_ONLY",
        setupMode: "OFF",
        toolOverrides: {},
        tokenExpiresAt: new Date(Date.now() + 60_000),
        organizationWritesEnabled: true,
      },
      permissions: new Set(),
      dailyMode: "READ_ONLY",
      setupMode: "OFF",
      toolOverrides: {},
      directWriteSessionId: null,
      directWriteStepUpExpiresAt: null,
      connectionVersion: 1,
    };
    const tool = { name: "finlynq_daily_download_document_evidence", group: "DAILY" as const, access: "READ" as const };
    const executions = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      beginMcpExecution(snapshot, tool, { assetId: randomUUID(), sourceDocumentId: randomUUID(), index })
    )));
    expect(new Set(executions.map((execution) => execution.id)).size).toBe(executions.length);
    expect(new Set(executions.map((execution) => execution.requestId)).size).toBe(executions.length);
    expect(executions.every((execution) => execution.requestId === `mcp-tool:${execution.id}`)).toBe(true);

    await Promise.all(executions.flatMap((execution) => [
      finishMcpExecution(snapshot, execution, { status: "SUCCEEDED", result: { assetId: "[redacted]" } }),
      finishMcpExecution(snapshot, execution, { status: "SUCCEEDED", result: { assetId: "[redacted]" } }),
    ]));
    const rows = await owner.query<{ status: string; request_id: string }>(
      "SELECT status,request_id FROM mcp_tool_executions WHERE organization_id=$1 AND connection_id=$2 AND tool_name=$3",
      [ids.org, ids.ownConnection, tool.name],
    );
    expect(rows.rows).toHaveLength(executions.length);
    expect(rows.rows.every((row) => row.status === "SUCCEEDED")).toBe(true);

    const contended = await beginMcpExecution(snapshot, tool, {
      assetId: randomUUID(),
      sourceDocumentId: randomUUID(),
      contention: true,
    });
    const terminal = { status: "SUCCEEDED" as const, result: { assetId: "[redacted]" } };
    const blocker = await owner.connect();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM mcp_tool_executions WHERE id=$1 FOR UPDATE", [contended.id]);
      await expect(finishMcpExecution(snapshot, contended, terminal)).rejects.toMatchObject({
        code: "MCP_RETRYABLE",
        retryAfterSeconds: 1,
      });
      expect((await blocker.query<{ status: string }>(
        "SELECT status FROM mcp_tool_executions WHERE id=$1",
        [contended.id],
      )).rows[0]?.status).toBe("STARTED");
      const logged = warning.mock.calls.flat().join(" ");
      expect(logged).toContain(contended.requestId);
      expect(logged).not.toMatch(/lock timeout|mcp_tool_executions/i);
    } finally {
      warning.mockRestore();
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await Promise.all([
      finishMcpExecution(snapshot, contended, terminal),
      finishMcpExecution(snapshot, contended, terminal),
    ]);
    expect((await owner.query<{ status: string }>(
      "SELECT status FROM mcp_tool_executions WHERE id=$1",
      [contended.id],
    )).rows[0]?.status).toBe("SUCCEEDED");
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
