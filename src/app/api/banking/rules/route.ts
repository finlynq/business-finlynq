import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import {
  bankRuleActionSchema,
  bankRuleConditionSchema,
  createBankRule,
} from "@/modules/banking/banking-service";

const schema = z.object({
  name: z.string().trim().min(2).max(100),
  priority: z.number().int().min(1).max(10_000),
  state: z.enum(["DRAFT", "ACTIVE"]),
  condition: bankRuleConditionSchema,
  action: bankRuleActionSchema,
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const POST = createBankingMutationRoute({
  schema,
  operation: "banking.rule.create",
  rateAction: "rule",
  successStatus: 201,
  invoke: (body, principal, requestId) => createBankRule({ principal, requestId, ...body }),
});
