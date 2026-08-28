import { z } from "zod";
import type { NextRequest } from "next/server";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { syncSimpleFin } from "@/modules/banking/banking-service";

const schema = z.object({
  startOn: z.iso.date().optional(),
  endOn: z.iso.date().optional(),
}).strict().refine((value) => !value.startOn || !value.endOn || value.endOn >= value.startOn, {
  message: "The sync end date must not precede the start date",
});

export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) => {
  const { connectionId } = await context.params;
  const route = createBankingMutationRoute({
    schema,
    operation: "banking.simplefin.sync",
    rateAction: "sync",
    invoke: (body, principal, requestId) => syncSimpleFin({ principal, requestId, connectionId, ...body }),
  });
  return route(request);
};
