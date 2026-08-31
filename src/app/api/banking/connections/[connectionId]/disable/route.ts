import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { disableSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({}).strict();

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ connectionId: z.uuid() }),
  operation: "banking.simplefin.disable",
  rateAction: "connect",
  invoke: (_body, principal, requestId, { connectionId }) => disableSimpleFin({
    principal, requestId, connectionId,
  }),
});
