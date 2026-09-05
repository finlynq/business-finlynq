import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0049_structured_evidence_mime_types.sql"),
  "utf8",
);

describe("structured evidence MIME migration", () => {
  it("validates a canonical replacement constraint before dropping the legacy constraint", () => {
    const add = migration.indexOf("ADD CONSTRAINT document_evidence_assets_metadata_check_v2");
    const validate = migration.indexOf("VALIDATE CONSTRAINT document_evidence_assets_metadata_check_v2");
    const drop = migration.indexOf("DROP CONSTRAINT document_evidence_assets_metadata_check;");
    expect(add).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(add);
    expect(drop).toBeGreaterThan(validate);
    expect(migration).toContain(") NOT VALID;");

    for (const mimeType of [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "text/csv",
      "text/tab-separated-values",
      "text/plain",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(migration).toContain(`'${mimeType}'`);
    }
    expect(migration).not.toContain("'text/html'");
    expect(migration).not.toContain("'application/octet-stream'");
  });
});
