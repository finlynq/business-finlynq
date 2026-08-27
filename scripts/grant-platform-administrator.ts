import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { provisionPlatformAdministratorGrant } from "../src/modules/identity/platform-administrator-provisioning";
import { operatorDatabaseConfig } from "./operator-database";

function requiredValue(argument: string | undefined, environmentValue: string | undefined, label: string): string {
  const value = argument?.trim() || environmentValue?.trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      "granted-by": { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
  });
  const input = {
    email: requiredValue(values.email, process.env.PLATFORM_ADMIN_EMAIL, "--email or PLATFORM_ADMIN_EMAIL"),
    grantedBy: requiredValue(
      values["granted-by"],
      process.env.PLATFORM_ADMIN_GRANTED_BY,
      "--granted-by or PLATFORM_ADMIN_GRANTED_BY",
    ),
    reason: requiredValue(values.reason, process.env.PLATFORM_ADMIN_REASON, "--reason or PLATFORM_ADMIN_REASON"),
    requestId: randomUUID(),
  };

  const pool = new Pool({
    ...operatorDatabaseConfig(),
    max: 1,
    application_name: "business-finlynq-platform-administrator-grant",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await provisionPlatformAdministratorGrant(client, input);
    await client.query("COMMIT");
    process.stdout.write(
      `Platform administrator grant ${result.grantId} is ${result.state}. ` +
      `${result.created ? "Created" : "Already present"}; no account or session was created.\n`,
    );
  } catch {
    await client.query("ROLLBACK");
    throw new Error("Platform administrator grant failed; no email or identity material was logged");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Platform administrator grant failed"}\n`);
  process.exitCode = 1;
});
