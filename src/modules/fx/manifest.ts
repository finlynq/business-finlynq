import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const fxModule = defineAccountingModule({
  key: "fx",
  version: 1,
  journalTypes: [{
    key: "fx.period-revaluation",
    version: 1,
    ownerModule: "fx",
    label: "FX period revaluation",
    correctionRoute: "/ledger/fx-revaluation",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: false,
  }],
});
