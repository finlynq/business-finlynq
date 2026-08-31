import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { transitionBankReconciliation } from "@/modules/banking/banking-service";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["SUBMIT", "REVIEW", "FINALIZE"]) }).strict(),
  z.object({
    action: z.literal("VOID"),
    reason: z.string().trim().min(8).max(500),
  }).strict(),
]);

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ reconciliationId: z.uuid() }),
  operation: "banking.reconciliation.transition",
  rateAction: "reconciliation",
  invoke: (body, principal, requestId, { reconciliationId }) => transitionBankReconciliation({
    principal, requestId, reconciliationId, ...body,
  }),
});
