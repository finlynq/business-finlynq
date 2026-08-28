import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { createBankReconciliation } from "@/modules/banking/banking-service";

const amount = z.string().trim().regex(/^-?\d+(?:\.\d{1,9})?$/);
const schema = z.object({
  externalAccountId: z.uuid(),
  statementStartOn: z.iso.date(),
  statementEndOn: z.iso.date(),
  openingBalance: amount,
  closingBalance: amount,
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict().refine((value) => value.statementEndOn >= value.statementStartOn, {
  message: "The statement end date must not precede the start date",
});

export const POST = createBankingMutationRoute({
  schema,
  operation: "banking.reconciliation.create",
  rateAction: "reconciliation",
  successStatus: 201,
  invoke: (body, principal, requestId) => createBankReconciliation({ principal, requestId, ...body }),
});
