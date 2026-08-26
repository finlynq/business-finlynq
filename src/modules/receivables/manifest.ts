import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const receivablesModule = defineAccountingModule({
  key: "receivables",
  version: 1,
  journalTypes: [{
    key: "receivables.sales-invoice",
    version: 1,
    ownerModule: "receivables",
    label: "Sales invoice",
    correctionRoute: "/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }],
});
