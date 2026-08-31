import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { createManualJournal } from "@/modules/ledger/journal-service";

const bodySchema = z.object({
  ledgerId: z.uuid(),
  legalEntityId: z.uuid(),
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  purpose: z.enum(["ROUTINE", "ADJUSTING", "OPENING", "CLOSING", "REVALUATION", "TAX_ADJUSTMENT"]),
  description: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
  lines: z.array(z.object({
    accountCombinationId: z.uuid(),
    debitFunctional: z.string().max(50),
    creditFunctional: z.string().max(50),
    transactionCurrency: z.string().max(3),
    debitTransaction: z.string().max(50),
    creditTransaction: z.string().max(50),
    fxRate: z.string().max(60),
    fxRateSource: z.string().max(100),
    fxRateEffectiveAt: z.string().max(50),
    memo: z.string().max(500).optional(),
  })).min(2).max(200),
});

export const POST = createMutationRoute({
  schema: bodySchema,
  operation: "journal creation",
  rateAction: "create",
  maximumBytes: 128_000,
  sameOriginMessage: "The journal request could not be verified.",
  rateLimitMessage: "Too many journal requests. Try again later.",
  invalidMessage: "Journal fields are invalid.",
  failureMessage:
    "The journal could not be saved. Verify the ledger, period, accounts, balance, and your assigned role.",
  invoke: (body, context) => createManualJournal({
    context,
    ...body,
    origin: "USER",
  }),
});
