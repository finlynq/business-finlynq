import { z } from "zod";
import type { NextRequest } from "next/server";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { versionBankRuleState } from "@/modules/banking/banking-service";

const schema = z.object({
  state: z.enum(["ACTIVE", "INACTIVE"]),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ ruleId: string }> },
) {
  const { ruleId } = await context.params;
  const handler = createBankingMutationRoute({
    schema,
    operation: "banking.rule.version-state",
    rateAction: "rule",
    successStatus: 201,
    invoke: (body, principal, requestId) => versionBankRuleState({
      principal,
      requestId,
      ruleId,
      ...body,
    }),
  });
  return handler(request);
}
