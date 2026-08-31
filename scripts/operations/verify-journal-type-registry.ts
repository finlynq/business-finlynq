import { Pool } from "pg";
import { operatorDatabaseConfig } from "../operator-database";
import {
  assertJournalTypeRegistryDatabase,
  type JournalTypeDatabaseDefinition,
} from "../../src/modules/ledger/journal-type-registry-contract";

async function main(): Promise<void> {
  const pool = new Pool({
    ...operatorDatabaseConfig(),
    application_name: "business-finlynq-journal-type-registry-verifier",
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  try {
    await assertJournalTypeRegistryDatabase((text) =>
      pool.query<JournalTypeDatabaseDefinition>(text),
    );
    console.log("Database journal types match the enabled module manifests.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Journal-type registry verification failed";
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]"));
  process.exitCode = 1;
});
