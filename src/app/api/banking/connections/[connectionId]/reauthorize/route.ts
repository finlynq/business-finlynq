import type { NextRequest } from "next/server";
import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { reauthorizeSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({
  setupToken: z.string().trim().min(20).max(4096),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return createBankingMutationRoute({
    schema,
    operation: "banking.simplefin.reauthorize",
    rateAction: "connect",
    maximumBytes: 8_000,
    invoke: (body, principal, requestId) => reauthorizeSimpleFin({
      principal, requestId, connectionId, ...body,
    }),
  })(request);
}
