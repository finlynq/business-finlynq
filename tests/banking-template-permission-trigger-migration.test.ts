import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "migrations",
    "drizzle",
    "0022_defer_banking_template_permissions.sql",
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(
    join(process.cwd(), "migrations", "drizzle", "meta", "_journal.json"),
    "utf8",
  ),
) as { entries: Array<{ idx: number; tag: string }> };

describe("deferred banking template permission trigger migration", () => {
  it("replaces only the trigger with an initially deferred constraint trigger", () => {
    expect(migration).toContain(
      "DROP TRIGGER IF EXISTS assign_banking_template_permissions ON roles",
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER assign_banking_template_permissions\s+AFTER INSERT OR UPDATE OF key, system_template ON roles\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION app\.assign_banking_template_permissions\(\)/,
    );
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(migration).not.toMatch(/DROP FUNCTION/i);
  });

  it("registers the forward migration after the banking foundation", () => {
    expect(journal.entries.at(-2)).toMatchObject({
      idx: 21,
      tag: "0021_banking_foundation",
    });
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 22,
      tag: "0022_defer_banking_template_permissions",
    });
  });
});
