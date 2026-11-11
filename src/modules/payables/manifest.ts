import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const payablesModule = defineAccountingModule({
  key: "payables",
  version: 1,
  journalTypes: [{
    id: "82828282-8282-4282-8282-828282828201",
    key: "payables.supplier-credit-note", version: 1, ownerModule: "payables",
    label: "Supplier credit note", correctionRoute: "/app/payables/bills",
    editableInGeneralLedger: false, deterministicSourceMayPost: true,
  }, {
    id: "82828282-8282-4282-8282-828282828202",
    key: "payables.supplier-credit-application", version: 1, ownerModule: "payables",
    label: "Supplier credit application", correctionRoute: "/app/payables/bills",
    editableInGeneralLedger: false, deterministicSourceMayPost: true,
  }, {
    id: "88888888-8888-4888-8888-888888888882",
    key: "payables.supplier-bill",
    version: 1,
    ownerModule: "payables",
    label: "Supplier bill",
    correctionRoute: "/app/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    id: "88888888-8888-4888-8888-888888888885",
    key: "payables.supplier-payment",
    version: 1,
    ownerModule: "payables",
    label: "Supplier payment",
    correctionRoute: "/app/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }, {
    id: "88888888-8888-4888-8888-888888888886",
    key: "payables.bill-void",
    version: 1,
    ownerModule: "payables",
    label: "Supplier bill void",
    correctionRoute: "/app/payables/bills",
    editableInGeneralLedger: false,
    deterministicSourceMayPost: true,
  }],
});
