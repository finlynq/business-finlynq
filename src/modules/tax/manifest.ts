import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const taxModule = defineAccountingModule({
  key: "tax",
  version: 1,
  // Tax calculation and review are implemented, but tax-owned journal
  // orchestration is not. Register its types only when that posting path ships.
  journalTypes: [],
});
