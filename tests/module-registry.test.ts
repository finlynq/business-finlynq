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
    expect(journalTypeRegistry.get("ledger.reversal", 1)).toMatchObject({
      id: "88888888-8888-4888-8888-888888888889",
      ownerModule: "ledger",
      editableInGeneralLedger: false,
    });
    expect(journalTypeRegistry.get("tax.adjustment", 1)).toBeUndefined();
    expect(journalTypeRegistry.get("fx.period-revaluation", 1)).toBeUndefined();
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
          id: "11111111-1111-4111-8111-111111111111",
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

  it("rejects duplicate permanent journal-type identifiers", () => {
    const first = defineAccountingModule({
      key: "first",
      version: 1,
      journalTypes: [{
        id: "11111111-1111-4111-8111-111111111111",
        key: "first.entry",
        version: 1,
        ownerModule: "first",
        label: "First",
        correctionRoute: "/app/first",
        editableInGeneralLedger: false,
        deterministicSourceMayPost: false,
      }],
    });
    const second = defineAccountingModule({
      key: "second",
      version: 1,
      journalTypes: [{
        id: "11111111-1111-4111-8111-111111111111",
        key: "second.entry",
        version: 1,
        ownerModule: "second",
        label: "Second",
        correctionRoute: "/app/second",
        editableInGeneralLedger: false,
        deterministicSourceMayPost: false,
      }],
    });

    expect(() => new JournalTypeRegistry([first, second])).toThrow(/Duplicate journal type definition id/);
  });
});
