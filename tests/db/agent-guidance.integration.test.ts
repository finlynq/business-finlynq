import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  getGuidanceIndex, readGuidanceFile, retireClientGuidanceFile, saveClientGuidanceFile,
} from "@/modules/agent-guidance/service";

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;

run("agent guidance tenant and revision controls", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ids = { orgA: randomUUID(), orgB: randomUUID(), userA: randomUUID(), userB: randomUUID(),
    membershipA: randomUUID(), membershipB: randomUUID(), roleA: randomUUID(), roleB: randomUUID() };
  const context = (org: string, actor: string): TenantTransactionContext => ({
    organizationId: org, actorId: actor, sessionId: randomUUID(), sessionMode: "real",
    authMethod: "oauth2.1+pkce", sourceSurface: "MCP", requestId: randomUUID(),
    reason: "Agent guidance integration test",
  });

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await owner.query(`INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at)
      VALUES ($1,$2,'Guidance A',true,false,'REAL',now()),($3,$4,'Guidance B',true,false,'REAL',now())`,
      [ids.orgA, `guidance-${ids.orgA}`, ids.orgB, `guidance-${ids.orgB}`]);
    await owner.query(`INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active)
      VALUES ($1,$2,'encrypted','test',true),($3,$4,'encrypted','test',true)`,
      [ids.userA, ids.userA, ids.userB, ids.userB]);
    await owner.query(`INSERT INTO organization_memberships(id,organization_id,user_id,active)
      VALUES ($1,$2,$3,true),($4,$5,$6,true)`,
      [ids.membershipA, ids.orgA, ids.userA, ids.membershipB, ids.orgB, ids.userB]);
    await owner.query(`INSERT INTO roles(id,organization_id,key,display_name,system_template,active)
      VALUES ($1,$2,'OWNER','Owner',true,true),($3,$4,'VIEWER_AUDITOR','Viewer',true,true)`,
      [ids.roleA, ids.orgA, ids.roleB, ids.orgB]);
    await owner.query(`INSERT INTO role_permissions(organization_id,role_id,permission_key)
      VALUES ($1,$2,'organization.settings.read'),($1,$2,'organization.settings.manage'),
        ($3,$4,'organization.settings.read')`, [ids.orgA, ids.roleA, ids.orgB, ids.roleB]);
    await owner.query(`INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
      VALUES ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [ids.orgA, ids.membershipA, ids.roleA, ids.userA, ids.orgB, ids.membershipB, ids.roleB, ids.userB]);
  });

  afterAll(async () => {
    await closeDatabasePool();
    await owner.end();
    vi.unstubAllEnvs();
  });

  it("seeds a shared index and versions tenant files without crossing organizations", async () => {
    const a = context(ids.orgA, ids.userA);
    const b = context(ids.orgB, ids.userB);
    const shared = await getGuidanceIndex(a);
    expect(shared.indexes.some((file) => file.scope === "platform" && file.path === "index.md")).toBe(true);
    expect(shared.indexes.some((file) => file.scope === "client")).toBe(false);

    const first = await saveClientGuidanceFile(a, { path: "index.md", summary: "Client entry point",
      content: "# Client guidance\n\n- `client:tax/notes.md` — tax notes.\n", expectedVersion: 0 });
    expect(first.version).toBe(1);
    expect((await readGuidanceFile(a, "client", "index.md")).content).toContain("tax/notes.md");
    await expect(readGuidanceFile(b, "client", "index.md")).rejects.toThrow(/not found/i);
    const crossTenantRows = await withTenantTransaction(b, (client) => client.query(
      "SELECT id FROM organization_guidance_files WHERE organization_id=$1", [ids.orgA]));
    expect(crossTenantRows.rows).toHaveLength(0);
    await expect(saveClientGuidanceFile(b, { path: "index.md", summary: "No write", content: "No.", expectedVersion: 0 }))
      .rejects.toThrow();
    await expect(saveClientGuidanceFile(a, { path: "index.md", summary: "Stale", content: "Old.", expectedVersion: 0 }))
      .rejects.toMatchObject({ code: "GUIDANCE_VERSION_CONFLICT" });

    const second = await saveClientGuidanceFile(a, { path: "index.md", summary: "Updated client entry",
      content: "# Client guidance\n\nUpdated reference.\n", expectedVersion: 1 });
    expect(second.version).toBe(2);
    expect((await readGuidanceFile(a, "client", "index.md")).version).toBe(2);
    const retired = await retireClientGuidanceFile(a, { path: "index.md", expectedVersion: 2 });
    expect(retired.version).toBe(3);
    await expect(readGuidanceFile(a, "client", "index.md")).rejects.toThrow(/not found/i);
    const history = await owner.query<{ status: string }>(
      "SELECT status FROM organization_guidance_files WHERE organization_id=$1 AND path='index.md' ORDER BY version",
      [ids.orgA]);
    expect(history.rows.map((row) => row.status)).toEqual(["ACTIVE", "ACTIVE", "RETIRED"]);
    await expect(withTenantTransaction(a, (client) => client.query(
      "UPDATE organization_guidance_files SET summary='Changed history' WHERE organization_id=$1 AND path='index.md'",
      [ids.orgA]))).rejects.toThrow();
  });
});
