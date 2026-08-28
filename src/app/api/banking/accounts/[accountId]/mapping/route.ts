import { z } from "zod";
import type { NextRequest } from "next/server";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { mapBankExternalAccount } from "@/modules/banking/banking-service";

const schema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  cashAccountCombinationId: z.uuid(),
}).strict();

export const PUT = async (
  request: NextRequest,
  context: { params: Promise<{ accountId: string }> },
) => {
  const { accountId } = await context.params;
  const route = createBankingMutationRoute({
    schema,
    operation: "banking.account.map",
    rateAction: "mapping",
    invoke: (body, principal, requestId) => mapBankExternalAccount({
      principal,
      requestId,
      externalAccountId: accountId,
      ...body,
    }),
  });
  return route(request);
};
