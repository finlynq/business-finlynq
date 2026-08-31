import { defineAccountingModule } from "./journal-types";

export const ledgerModule = defineAccountingModule({
  key: "ledger",
  version: 1,
  journalTypes: [{
    id: "88888888-8888-4888-8888-888888888888",
    key: "ledger.manual",
    version: 1,
    ownerModule: "ledger",
    label: "Manual journal",
    correctionRoute: "/app/journals",
    editableInGeneralLedger: true,
    deterministicSourceMayPost: false,
  }, {
    id: "88888888-8888-4888-8888-888888888889",
    key: "ledger.reversal",
    version: 1,
    ownerModule: "ledger",
    label: "Full journal reversal",
    correctionRoute: "/app/journals",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: false,
  }],
});
