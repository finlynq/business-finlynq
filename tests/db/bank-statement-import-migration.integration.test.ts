import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

const ids = {
  organizationA: randomUUID(),
  organizationB: randomUUID(),
  actor: randomUUID(),
  importA: randomUUID(),
  importB: randomUUID(),
  connectionA: randomUUID(),
  simpleFinConnection: randomUUID(),
  simpleFinExternalAccount: randomUUID(),
};

function fakeId(): string {
  return randomUUID();
}

runDatabaseTests("bank statement import migration PostgreSQL controls", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  const app = new Pool({ connectionString: appUrl });

  async function asOrganization<T>(
    organizationId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.actor]);
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

  async function insertFixtureImport(
    client: PoolClient,
    organizationId: string,
    importId: string,
    sha: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO bank_statement_imports(
         id, organization_id, inbox_item_id, evidence_asset_id,
         external_account_id, sync_run_id, reconciliation_session_id,
         source_sha256, extraction_version, extraction_ciphertext, key_version,
         preview_hash, statement_start_on, statement_end_on, opening_balance,
         closing_balance, currency_code, included_row_count, excluded_row_count,
         duplicate_row_count, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'finlynq.statement.v1',repeat('x',60),1,
         $9,'2026-01-01','2026-01-31',0,1,'USD',1,0,0,$10
       )`,
      [
        importId,
        organizationId,
        fakeId(),
        fakeId(),
        fakeId(),
        fakeId(),
        fakeId(),
        sha,
        "b".repeat(64),
        ids.actor,
      ],
    );
  }

  beforeAll(async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO organizations(id, slug, display_name, active, is_demo, organization_mode)
         VALUES ($1,$2,'Statement migration A',true,false,'REAL'),
                ($3,$4,'Statement migration B',true,false,'REAL')`,
        [
          ids.organizationA,
          `statement-migration-${ids.organizationA}`,
          ids.organizationB,
          `statement-migration-${ids.organizationB}`,
        ],
      );
      await client.query(
        `INSERT INTO bank_connections(
           id, organization_id, provider, display_name, credentials_ciphertext,
           credentials_key_version, credential_version, status, idempotency_key,
           command_hash, created_by
         ) VALUES
           ($1,$2,'FILE_IMPORT','Statement file imports',repeat('x',60),
             1,1,'ACTIVE','file-import-fixture',$3,$4),
           ($5,$6,'SIMPLEFIN','SimpleFIN fixture',repeat('x',60),
             1,1,'ACTIVE','simplefin-fixture',$7,$4)`,
        [
          ids.connectionA,
          ids.organizationA,
          "a".repeat(64),
          ids.actor,
          ids.simpleFinConnection,
          ids.organizationB,
          "b".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO bank_external_accounts(
           id, organization_id, connection_id, provider_account_id_hash,
           provider_account_id_ciphertext, display_name_ciphertext, key_version,
           currency_code
         ) VALUES ($1,$2,$3,$4,repeat('x',60),repeat('y',60),1,'USD')`,
        [
          ids.simpleFinExternalAccount,
          ids.organizationB,
          ids.simpleFinConnection,
          `hmac-sha256-v1:${"f".repeat(64)}`,
        ],
      );
      await insertFixtureImport(client, ids.organizationA, ids.importA, "c".repeat(64));
      await insertFixtureImport(client, ids.organizationB, ids.importB, "d".repeat(64));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM bank_statement_import_rows WHERE organization_id IN ($1,$2)",
        [ids.organizationA, ids.organizationB],
      );
      await client.query(
        "DELETE FROM bank_statement_imports WHERE organization_id IN ($1,$2)",
        [ids.organizationA, ids.organizationB],
      );
      await client.query(
        "DELETE FROM bank_external_accounts WHERE id = $1",
        [ids.simpleFinExternalAccount],
      );
      await client.query(
        "DELETE FROM bank_connections WHERE id IN ($1,$2)",
        [ids.connectionA, ids.simpleFinConnection],
      );
      await client.query(
        "DELETE FROM organizations WHERE id IN ($1,$2)",
        [ids.organizationA, ids.organizationB],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await Promise.all([app.end(), owner.end()]);
    }
  });

  it("forces one-organization visibility through the app role", async () => {
    await expect(asOrganization(ids.organizationA, async (client) => {
      const imports = await client.query<{ id: string }>(
        "SELECT id FROM bank_statement_imports ORDER BY id",
      );
      expect(imports.rows).toEqual([{ id: ids.importA }]);
    })).resolves.toBeUndefined();

    await expect(asOrganization(ids.organizationB, async (client) => {
      const imports = await client.query<{ id: string }>(
        "SELECT id FROM bank_statement_imports ORDER BY id",
      );
      expect(imports.rows).toEqual([{ id: ids.importB }]);
    })).resolves.toBeUndefined();
  });

  it("grants only SELECT and INSERT on both append-only tables", async () => {
    const privileges = await owner.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT table_name,
         has_table_privilege('business_finlynq_app', 'public.' || table_name, 'SELECT') AS can_select,
         has_table_privilege('business_finlynq_app', 'public.' || table_name, 'INSERT') AS can_insert,
         has_table_privilege('business_finlynq_app', 'public.' || table_name, 'UPDATE') AS can_update,
         has_table_privilege('business_finlynq_app', 'public.' || table_name, 'DELETE') AS can_delete
       FROM unnest(ARRAY['bank_statement_import_rows','bank_statement_imports']) AS table_name
       ORDER BY table_name`,
    );
    expect(privileges.rows).toEqual([
      {
        table_name: "bank_statement_import_rows",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
      {
        table_name: "bank_statement_imports",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
    ]);
  });

  it("rejects a statement row before foreign-key evaluation when either permission is absent", async () => {
    await expect(asOrganization(ids.organizationA, async (client) => {
      await client.query(
        `INSERT INTO bank_statement_import_rows(
           organization_id, statement_import_id, source_row_number,
           row_fingerprint, disposition, observation_version_id,
           row_ciphertext, key_version
         ) VALUES ($1,$2,1,$3,'EXCLUDED',NULL,repeat('x',60),1)`,
        [ids.organizationA, ids.importA, "e".repeat(64)],
      );
    })).rejects.toMatchObject({ code: "42501" });
  });

  it("blocks updates even for the migration owner", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.organizationA]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.actor]);
      await expect(client.query(
        "UPDATE bank_statement_imports SET preview_hash = $2 WHERE id = $1",
        [ids.importA, "f".repeat(64)],
      )).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("allows only the first atomic SimpleFIN kind classification before accounting use", async () => {
    const client = await owner.connect();
    try {
      await client.query(
        "ALTER TABLE bank_external_accounts ENABLE ALWAYS TRIGGER bank_external_account_identity_immutable",
      );
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const classified = await client.query(
        `UPDATE bank_external_accounts
         SET account_kind = 'CREDIT_CARD', legal_entity_id = $2,
           ledger_id = $3, cash_account_combination_id = $4
         WHERE id = $1`,
        [ids.simpleFinExternalAccount, fakeId(), fakeId(), fakeId()],
      );
      expect(classified.rowCount).toBe(1);
      await expect(client.query(
        "UPDATE bank_external_accounts SET account_kind = 'CASH' WHERE id = $1",
        [ids.simpleFinExternalAccount],
      )).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");
    } finally {
      await client.query(
        "ALTER TABLE bank_external_accounts ENABLE TRIGGER bank_external_account_identity_immutable",
      );
      client.release();
    }
  });

  it("accepts FILE_IMPORT and rejects unregistered banking providers at the database boundary", async () => {
    const accepted = await owner.query<{ provider: string }>(
      "SELECT provider FROM bank_connections WHERE id = $1",
      [ids.connectionA],
    );
    expect(accepted.rows).toEqual([{ provider: "FILE_IMPORT" }]);

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await expect(client.query(
        `INSERT INTO bank_connections(
           organization_id, provider, display_name, credentials_ciphertext,
           credentials_key_version, credential_version, status, idempotency_key,
           command_hash, created_by
         ) VALUES ($1,'UNREGISTERED','Invalid provider',repeat('x',60),
           1,1,'ACTIVE','invalid-provider',$2,$3)`,
        [ids.organizationB, "a".repeat(64), ids.actor],
      )).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
