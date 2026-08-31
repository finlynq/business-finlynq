import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const receivablesModule = defineAccountingModule({
  key: "receivables",
  version: 1,
  journalTypes: [{
    id: "88888888-8888-4888-8888-888888888881",
    key: "receivables.sales-invoice",
    version: 1,
    ownerModule: "receivables",
    label: "Sales invoice",
    correctionRoute: "/app/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    id: "88888888-8888-4888-8888-888888888883",
    key: "receivables.customer-receipt",
    version: 1,
    ownerModule: "receivables",
    label: "Customer receipt",
    correctionRoute: "/app/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    id: "88888888-8888-4888-8888-888888888884",
    key: "receivables.invoice-void",
    version: 1,
    ownerModule: "receivables",
    label: "Sales invoice void",
    correctionRoute: "/app/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }],
});
