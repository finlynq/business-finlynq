import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationOwnedConstraintContract,
  buildSnapshotSchemaContract,
  compareSchemaContracts,
  loadMigrationOwnedConstraintContract,
  loadLatestJournalSnapshot,
  readDatabaseSchemaContract,
} from "../../scripts/operations/verify-database-schema.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;

function retainAllocationContract(contract: { tables: Map<string, unknown> }) {
  for (const tableName of [...contract.tables.keys()]) {
    if (tableName !== "bank_match_allocations") contract.tables.delete(tableName);
  }
  return contract;
}

async function expectedSchemaContract() {
  const latest = await loadLatestJournalSnapshot();
  return applyMigrationOwnedConstraintContract(
    buildSnapshotSchemaContract(latest.snapshot),
    await loadMigrationOwnedConstraintContract(),
  );
}

runDatabaseTests("database schema verifier live constraint negative", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => client.connect());
  afterAll(async () => client.end());

  it("matches the complete snapshot and migration-owned constraint contract", async () => {
    const expected = await expectedSchemaContract();
    const current = await readDatabaseSchemaContract(client);
    expect(compareSchemaContracts(expected, current)).toEqual([]);
  });

  it("detects a transaction-local dropped live CHECK constraint", async () => {
    const expected = retainAllocationContract(await expectedSchemaContract());
    const current = retainAllocationContract(await readDatabaseSchemaContract(client));
    expect(compareSchemaContracts(expected, current)).toEqual([]);

    await client.query("BEGIN");
    try {
      await client.query(
        'ALTER TABLE public.bank_match_allocations DROP CONSTRAINT "bank_match_allocations_idempotency_key_length"',
      );
      const altered = retainAllocationContract(await readDatabaseSchemaContract(client));
      expect(compareSchemaContracts(expected, altered)).toContain(
        "[MISSING_CHECK] public.bank_match_allocations.bank_match_allocations_idempotency_key_length is declared by the latest Drizzle snapshot but is absent from PostgreSQL",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
