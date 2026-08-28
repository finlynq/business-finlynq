import type { NextRequest } from "next/server";
import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { disableSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return createBankingMutationRoute({
    schema,
    operation: "banking.simplefin.disable",
    rateAction: "connect",
    invoke: (_body, principal, requestId) => disableSimpleFin({
      principal, requestId, connectionId,
    }),
  })(request);
}
