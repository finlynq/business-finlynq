import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { versionBankRuleState } from "@/modules/banking/banking-service";

const schema = z.object({
  state: z.enum(["ACTIVE", "INACTIVE"]),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const POST = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ ruleId: z.uuid() }),
  operation: "banking.rule.version-state",
  rateAction: "rule",
  successStatus: 201,
  invoke: (body, principal, requestId, { ruleId }) => versionBankRuleState({
    principal,
    requestId,
    ruleId,
    ...body,
  }),
});
