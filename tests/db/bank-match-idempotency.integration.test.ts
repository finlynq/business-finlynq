import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTests = databaseUrl ? describe : describe.skip;

runDatabaseTests("bank-match idempotency database contract", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("persists bounded command identity and reconciliation-scoped uniqueness in PostgreSQL", async () => {
    const columns = await pool.query<{
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'bank_match_allocations'
         AND column_name IN ('idempotency_key', 'command_hash')
       ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "command_hash", is_nullable: "NO" },
      { column_name: "idempotency_key", is_nullable: "NO" },
    ]);

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'bank_match_allocations'
         AND indexname = 'bank_match_allocations_org_session_idempotency_unique'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(
      /UNIQUE INDEX .*\(organization_id, reconciliation_session_id, idempotency_key\)/,
    );
  });
});
