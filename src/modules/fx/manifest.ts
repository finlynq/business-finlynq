import { defineAccountingModule } from "@/modules/ledger/journal-types";

export const fxModule = defineAccountingModule({
  key: "fx",
  version: 1,
  // Transaction FX is live, but period revaluation posting is not. Its journal
  // type remains absent until the future module owns an end-to-end workflow.
  journalTypes: [],
});
