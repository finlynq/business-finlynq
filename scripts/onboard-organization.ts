import { parseArgs } from "node:util";
import { Pool } from "pg";
import { onboardOrganization } from "../src/modules/onboarding/organization-service";
import { operatorDatabaseConfig } from "./operator-database";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      "organization-name": { type: "string" },
      "entity-code": { type: "string" },
      "entity-name": { type: "string" },
      country: { type: "string" },
      region: { type: "string" },
      currency: { type: "string" },
      "accounting-profile": { type: "string" },
      "fiscal-year": { type: "string" },
    },
    strict: true,
  });

  const required = (key: keyof typeof values): string => {
    const value = values[key]?.trim();
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };

  const country = required("country").toUpperCase();
  const pool = new Pool({
    ...operatorDatabaseConfig(),
    max: 1,
    application_name: "business-finlynq-onboarding",
  });
  try {
    const result = await onboardOrganization(pool, {
      slug: required("slug"),
      organizationName: required("organization-name"),
      entityCode: required("entity-code"),
      entityName: required("entity-name"),
      countryCode: country as "CA" | "US",
      regionCode: required("region"),
      functionalCurrency: required("currency") as "CAD" | "USD",
      accountingProfile: required("accounting-profile") as "CAN_ASPE" | "US_GAAP_NONPUBLIC",
      fiscalYear: Number(required("fiscal-year")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Organization onboarding failed."}\n`);
  process.exitCode = 1;
});
