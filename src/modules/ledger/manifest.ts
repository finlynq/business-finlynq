import { defineAccountingModule } from "./journal-types";

export const ledgerModule = defineAccountingModule({
  key: "ledger",
  version: 1,
  journalTypes: [{
    key: "ledger.manual",
    version: 1,
    ownerModule: "ledger",
    label: "Manual journal",
    correctionRoute: "/journals",
    editableInGeneralLedger: true,
    deterministicSourceMayPost: false,
  }],
});
