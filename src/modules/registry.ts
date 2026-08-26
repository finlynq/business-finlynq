import { fxModule } from "@/modules/fx/manifest";
import { JournalTypeRegistry } from "@/modules/ledger/journal-types";
import { ledgerModule } from "@/modules/ledger/manifest";
import { payablesModule } from "@/modules/payables/manifest";
import { receivablesModule } from "@/modules/receivables/manifest";
import { taxModule } from "@/modules/tax/manifest";

// This composition root is the only place that knows which modules ship in a
// deployment. The ledger kernel only knows the versioned manifest contract.
export const enabledAccountingModules = [
  ledgerModule,
  receivablesModule,
  payablesModule,
  taxModule,
  fxModule,
] as const;

export const journalTypeRegistry = new JournalTypeRegistry(enabledAccountingModules);
