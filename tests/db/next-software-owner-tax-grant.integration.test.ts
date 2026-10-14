import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0091_next_software_owner_tax_filing_grants.sql"),
  "utf8",
);
const targetEntityId = "70eed0d9-289d-494d-b897-c1331fe0af3a";

runDatabaseTests("Next Software Owner tax filing grant", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  afterAll(async () => pool.end());

  it("grants exactly two permissions to the verified fixed Owner and is replay-safe", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const targetOrganizationId = randomUUID();
      const otherOrganizationId = randomUUID();
      const targetOwnerId = randomUUID();
      const targetAdminId = randomUUID();
      const otherOwnerId = randomUUID();

      await client.query(
        `INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode)
         VALUES($1,$2,'Next Software',true,false,'REAL'),
               ($3,$4,'Next Software',true,false,'REAL')`,
        [targetOrganizationId, `tax-grant-${targetOrganizationId.slice(0, 8)}`,
          otherOrganizationId, `tax-grant-${otherOrganizationId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code)
         VALUES($1,$2,'CA01','Target entity','CA','ON'),
               ($3,$4,'CA01','Other entity','CA','ON')`,
        [targetEntityId, targetOrganizationId, randomUUID(), otherOrganizationId],
      );
      await client.query(
        `INSERT INTO roles(id,organization_id,key,display_name,system_template,active)
         VALUES($1,$2,'OWNER','Owner',true,true),
               ($3,$2,'ORGANIZATION_ADMIN','Organization administrator',true,true),
               ($4,$5,'OWNER','Owner',true,true)`,
        [targetOwnerId, targetOrganizationId, targetAdminId, otherOwnerId, otherOrganizationId],
      );

      await client.query(migration);
      await client.query(migration);

      const grants = await client.query<{ organization_id: string; role_id: string; permission_key: string }>(
        `SELECT organization_id,role_id,permission_key FROM role_permissions
         WHERE organization_id IN ($1,$2)
         ORDER BY organization_id,role_id,permission_key`,
        [targetOrganizationId, otherOrganizationId],
      );
      expect(grants.rows).toEqual([
        { organization_id: targetOrganizationId, role_id: targetOwnerId,
          permission_key: "tax.filing.canonical.manage" },
        { organization_id: targetOrganizationId, role_id: targetOwnerId,
          permission_key: "tax.filing.configuration.manage" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
