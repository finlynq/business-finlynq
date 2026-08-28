import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { connectSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({
  displayName: z.string().trim().min(2).max(100),
  setupToken: z.string().trim().min(20).max(4096),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const POST = createBankingMutationRoute({
  schema,
  operation: "banking.simplefin.connect",
  rateAction: "connect",
  maximumBytes: 8_000,
  successStatus: 201,
  invoke: (body, principal, requestId) => connectSimpleFin({ principal, requestId, ...body }),
});
