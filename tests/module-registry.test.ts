import { describe, expect, it } from "vitest";
import {
  defineAccountingModule,
  JournalTypeRegistry,
} from "@/modules/ledger/journal-types";
import { enabledAccountingModules, journalTypeRegistry } from "@/modules/registry";

describe("accounting module manifests", () => {
  it("assembles source-owned journal types without hardcoding owners in the ledger kernel", () => {
    expect(enabledAccountingModules.map((module) => module.key)).toEqual([
      "ledger",
      "receivables",
      "payables",
      "tax",
      "fx",
    ]);
    expect(journalTypeRegistry.get("receivables.sales-invoice", 1)).toMatchObject({
      ownerModule: "receivables",
      editableInGeneralLedger: false,
    });
  });

  it("rejects duplicate modules and journal types not owned by their manifest", () => {
    const sampleManifest = defineAccountingModule({ key: "sample", version: 1, journalTypes: [] });
    expect(() => new JournalTypeRegistry([sampleManifest, sampleManifest])).toThrow(
      /Duplicate accounting module/,
    );

    expect(() =>
      defineAccountingModule({
        key: "sample",
        version: 1,
        journalTypes: [{
          key: "ledger.wrong-owner",
          version: 1,
          ownerModule: "sample",
          label: "Wrong",
          correctionRoute: "/sample",
          editableInGeneralLedger: false,
          deterministicSourceMayPost: false,
        }],
      }),
    ).toThrow(/not canonically owned/);
  });
});
