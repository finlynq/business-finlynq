import { Pool } from "pg";
import { resetSharedDemoOrganization } from "../src/modules/onboarding/demo-bootstrap";
import { operatorDatabaseConfig } from "./operator-database";
import { parseDemoResetMode } from "./demo-reset-mode";

async function main(): Promise<void> {
  const selected = parseDemoResetMode(process.argv.slice(2), process.env.DEMO_RESET_MODE);
  const pool = new Pool({
    ...operatorDatabaseConfig(),
    max: 1,
    application_name: `business-finlynq-demo-reset-${selected.mode}`,
  });
  try {
    await resetSharedDemoOrganization(pool, { mode: selected.mode });
    process.stdout.write(`Business Finlynq ${selected.mode} shared-demo maintenance completed.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Shared-demo reset failed."}\n`);
  process.exitCode = 1;
});
