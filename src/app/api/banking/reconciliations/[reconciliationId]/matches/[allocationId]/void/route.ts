import type { NextRequest } from "next/server";
import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { voidBankMatchAllocation } from "@/modules/banking/banking-service";

const schema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ reconciliationId: string; allocationId: string }> },
) {
  const { reconciliationId, allocationId } = await context.params;
  return createBankingMutationRoute({
    schema,
    operation: "banking.reconciliation.match.void",
    rateAction: "reconciliation",
    successStatus: 201,
    invoke: (body, principal, requestId) => voidBankMatchAllocation({
      principal, requestId, reconciliationId, allocationId, reason: body.reason,
    }),
  })(request);
}
