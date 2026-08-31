import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { reauthorizeSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({
  setupToken: z.string().trim().min(20).max(4096),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ connectionId: z.uuid() }),
  operation: "banking.simplefin.reauthorize",
  rateAction: "connect",
  maximumBytes: 8_000,
  invoke: (body, principal, requestId, { connectionId }) => reauthorizeSimpleFin({
    principal, requestId, connectionId, ...body,
  }),
});
