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
  }, {
    key: "receivables.customer-receipt",
    version: 1,
    ownerModule: "receivables",
    label: "Customer receipt",
    correctionRoute: "/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    key: "receivables.invoice-void",
    version: 1,
    ownerModule: "receivables",
    label: "Sales invoice void",
    correctionRoute: "/receivables/invoices",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }],
});
