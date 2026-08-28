import type { NextRequest } from "next/server";
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ reconciliationId: string }> },
) {
  const { reconciliationId } = await context.params;
  return createBankingMutationRoute({
    schema,
    operation: "banking.reconciliation.transition",
    rateAction: "reconciliation",
    invoke: (body, principal, requestId) => transitionBankReconciliation({
      principal, requestId, reconciliationId, ...body,
    }),
  })(request);
}
