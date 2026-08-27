import { Pool } from "pg";
import { bootstrapDemoOrganization } from "../src/modules/onboarding/demo-bootstrap";
import { operatorDatabaseConfig } from "./operator-database";

async function main(): Promise<void> {
  const pool = new Pool({
    ...operatorDatabaseConfig(),
    max: 1,
    application_name: "business-finlynq-demo-bootstrap",
  });
  try {
    await bootstrapDemoOrganization(pool);
    process.stdout.write("Business Finlynq synthetic demo foundation is ready.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Demo bootstrap failed."}\n`);
  process.exitCode = 1;
});
