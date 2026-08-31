import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { syncSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({
  startOn: z.iso.date().optional(),
  endOn: z.iso.date().optional(),
}).strict().refine((value) => !value.startOn || !value.endOn || value.endOn >= value.startOn, {
  message: "The sync end date must not precede the start date",
});

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ connectionId: z.uuid() }),
  operation: "banking.simplefin.sync",
  rateAction: "sync",
  invoke: (body, principal, requestId, { connectionId }) =>
    syncSimpleFin({ principal, requestId, connectionId, ...body }),
});
