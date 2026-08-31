import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { createBankMatchAllocation } from "@/modules/banking/banking-service";

const schema = z.object({
  observationVersionId: z.uuid(),
  journalLineId: z.uuid(),
  allocatedAmount: z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const POST = createBankingMutationRoute<
  z.infer<typeof schema>,
  Readonly<{ allocationId: string; idempotentReplay: boolean }>,
  { reconciliationId: string }
>({
  schema,
  paramsSchema: z.object({ reconciliationId: z.uuid() }),
  operation: "banking.reconciliation.match",
  rateAction: "reconciliation",
  successStatus: (result) => result.idempotentReplay ? 200 : 201,
  invoke: (body, principal, requestId, { reconciliationId }) => createBankMatchAllocation({
    principal, requestId, reconciliationId, ...body,
  }),
});
