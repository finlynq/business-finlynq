import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  executeOrganizationWriteOperatorPool,
  formatOrganizationWriteFailure,
  parseGlobalBusinessWriteGate,
  parseOrganizationWriteCommand,
} from "./organization-writes-command";
import { operatorDatabaseConfig } from "./operator-database";

async function main(): Promise<void> {
  try {
    const command = parseOrganizationWriteCommand(process.argv.slice(2));
    const globalGateEnabled = parseGlobalBusinessWriteGate(process.env.BUSINESS_WRITES_ENABLED);
    const pool = new Pool({
      ...operatorDatabaseConfig(),
      max: 1,
      connectionTimeoutMillis: 10_000,
      application_name: "business-finlynq-organization-writes",
    });
    const output = await executeOrganizationWriteOperatorPool(pool, command, {
      globalGateEnabled,
      ...(command.action === "status" ? {} : { requestId: randomUUID() }),
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`${formatOrganizationWriteFailure(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
