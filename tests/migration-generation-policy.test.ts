import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { driftMessage, summarizeGeneratedMigration } from "../scripts/operations/check-drizzle-drift.mjs";

describe("forward migration generation policy", () => {
  it("uses the repaired snapshot chain and a non-mutating CI drift check", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["db:generate"]).toBe("drizzle-kit generate");
    expect(packageJson.scripts?.["db:generate:custom"]).toBe("drizzle-kit generate --custom");
    expect(packageJson.scripts?.["db:check-drift"]).toBe(
      "node scripts/operations/check-drizzle-drift.mjs",
    );
  });

  it("keeps actionable generated-SQL context in drift failures", () => {
    const sql = [
      'CREATE TABLE "schema_drift_probe" ("id" text PRIMARY KEY NOT NULL);',
      'ALTER TABLE "organizations" ADD COLUMN "unexpected" text;',
    ].join("--> statement-breakpoint");
    expect(summarizeGeneratedMigration(sql)).toContain("schema_drift_probe");
    expect(driftMessage(["0027_schema_drift_check.sql"], sql)).toContain(
      "docs/operations/migrations.md",
    );
  });

  it("fails a deliberate declaration mismatch without changing the real migration folder", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/operations/check-drizzle-drift.mjs")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          BUSINESS_FINLYNQ_DRIZZLE_SCHEMA: "./tests/fixtures/drizzle-schema-drift.ts",
        },
        timeout: 120_000,
      },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Drizzle schema drift detected");
    expect(`${result.stdout}\n${result.stderr}`).toContain("schema_drift_probe");
  });
});
