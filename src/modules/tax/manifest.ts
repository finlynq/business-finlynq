import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const taxModule = defineAccountingModule({
  key: "tax",
  version: 1,
  journalTypes: [{
    key: "tax.adjustment",
    version: 1,
    ownerModule: "tax",
    label: "Tax adjustment",
    correctionRoute: "/tax/adjustments",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: false,
  }],
});
