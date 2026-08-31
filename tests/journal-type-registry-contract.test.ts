import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertJournalTypeRegistryDatabase,
  assertJournalTypeRegistryRows,
  findJournalTypeRegistryDrift,
  JOURNAL_TYPE_REGISTRY_SELECT,
  journalTypeSeedDefinitions,
  renderJournalTypeSeedSql,
} from "@/modules/ledger/journal-type-registry-contract";

describe("journal-type registry database contract", () => {
  it("captures every currently supported seeded journal type", () => {
    expect(journalTypeSeedDefinitions.map(({ key, version }) => `${key}@${version}`)).toEqual([
      "ledger.manual@1",
      "ledger.reversal@1",
      "payables.bill-void@1",
      "payables.supplier-bill@1",
      "payables.supplier-payment@1",
      "receivables.customer-receipt@1",
      "receivables.invoice-void@1",
      "receivables.sales-invoice@1",
    ]);
    expect(findJournalTypeRegistryDrift(journalTypeSeedDefinitions)).toEqual([]);
  });

  it("fails a deliberate manifest-version drift against deployed rows", () => {
    const driftedManifest = journalTypeSeedDefinitions.map((definition) =>
      definition.key === "receivables.sales-invoice"
        ? { ...definition, version: definition.version + 1 }
        : definition,
    );

    expect(() =>
      assertJournalTypeRegistryRows(journalTypeSeedDefinitions, driftedManifest),
    ).toThrow(/missing manifest journal type receivables\.sales-invoice@2/);
  });

  it("rejects an unsupported database row and a changed seeded field", () => {
    const databaseRows = [
      ...journalTypeSeedDefinitions.map((definition) =>
        definition.key === "ledger.manual"
          ? { ...definition, correctionRoute: "/wrong" }
          : definition,
      ),
      {
        id: "22222222-2222-4222-8222-222222222222",
        key: "tax.adjustment",
        version: 1,
        ownerModule: "tax",
        displayName: "Unsupported tax adjustment",
        correctionRoute: "/app/tax/adjustments",
      },
    ];

    expect(findJournalTypeRegistryDrift(databaseRows)).toEqual([
      "database has unregistered journal type tax.adjustment@1",
      "ledger.manual@1 correctionRoute is \"/wrong\"; manifest requires \"/app/journals\"",
    ]);
  });

  it("queries and verifies the live registry through the reusable runtime assertion", async () => {
    const query = vi.fn().mockResolvedValue({ rows: journalTypeSeedDefinitions });

    await expect(assertJournalTypeRegistryDatabase(query)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(JOURNAL_TYPE_REGISTRY_SELECT);
  });

  it("keeps the checked-in generated seed synchronized with the manifests", () => {
    const artifact = readFileSync(
      join(process.cwd(), "migrations/generated/journal-type-definitions.sql"),
      "utf8",
    );
    expect(artifact).toBe(renderJournalTypeSeedSql());
  });
});
