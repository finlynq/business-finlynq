import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const payablesModule = defineAccountingModule({
  key: "payables",
  version: 1,
  journalTypes: [{
    key: "payables.supplier-bill",
    version: 1,
    ownerModule: "payables",
    label: "Supplier bill",
    correctionRoute: "/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    key: "payables.supplier-payment",
    version: 1,
    ownerModule: "payables",
    label: "Supplier payment",
    correctionRoute: "/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    key: "payables.bill-void",
    version: 1,
    ownerModule: "payables",
    label: "Supplier bill void",
    correctionRoute: "/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }],
});
