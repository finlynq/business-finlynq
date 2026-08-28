import type { NextRequest } from "next/server";
import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { createBankMatchAllocation } from "@/modules/banking/banking-service";

const schema = z.object({
  observationVersionId: z.uuid(),
  journalLineId: z.uuid(),
  allocatedAmount: z.string().trim().regex(/^\d+(?:\.\d{1,9})?$/),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ reconciliationId: string }> },
) {
  const { reconciliationId } = await context.params;
  return createBankingMutationRoute({
    schema,
    operation: "banking.reconciliation.match",
    rateAction: "reconciliation",
    successStatus: 201,
    invoke: (body, principal, requestId) => createBankMatchAllocation({
      principal, requestId, reconciliationId, ...body,
    }),
  })(request);
}
