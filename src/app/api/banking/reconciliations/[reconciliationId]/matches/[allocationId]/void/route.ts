import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { voidBankMatchAllocation } from "@/modules/banking/banking-service";

const schema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ reconciliationId: z.uuid(), allocationId: z.uuid() }),
  operation: "banking.reconciliation.match.void",
  rateAction: "reconciliation",
  successStatus: 201,
  invoke: (body, principal, requestId, { reconciliationId, allocationId }) =>
    voidBankMatchAllocation({
      principal, requestId, reconciliationId, allocationId, reason: body.reason,
    }),
});
