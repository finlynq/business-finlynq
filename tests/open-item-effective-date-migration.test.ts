import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0070_open_item_effective_indexes.sql"),
  "utf8",
);

describe("open-item effective-date migration", () => {
  it("temporarily suspends and restores both append-only guards around the historical backfill", () => {
    for (const [table, trigger] of [
      ["document_settlement_allocations", "document_settlement_allocations_append_only"],
      ["open_item_void_events", "open_item_void_events_append_only"],
    ] as const) {
      const disable = migration.indexOf(`ALTER TABLE ${table}\n  DISABLE TRIGGER ${trigger};`);
      const backfill = migration.indexOf(`UPDATE ${table}`);
      const enable = migration.indexOf(`ALTER TABLE ${table}\n  ENABLE TRIGGER ${trigger};`);
      expect(disable).toBeGreaterThanOrEqual(0);
      expect(backfill).toBeGreaterThan(disable);
      expect(enable).toBeGreaterThan(backfill);
    }
  });
});
