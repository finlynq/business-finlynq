import { z } from "zod";
import { createBankingMutationRoute } from "@/app/api/_shared/banking-mutation-route";
import { mapBankExternalAccount } from "@/modules/banking/banking-service";

const schema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  cashAccountCombinationId: z.uuid(),
  accountKind: z.enum(["CASH", "CREDIT_CARD"]).optional(),
}).strict();

export const PUT = createBankingMutationRoute({
  schema,
  paramsSchema: z.object({ accountId: z.uuid() }),
  operation: "banking.account.map",
  rateAction: "mapping",
  invoke: (body, principal, requestId, { accountId }) => mapBankExternalAccount({
    principal,
    requestId,
    externalAccountId: accountId,
    ...body,
  }),
});
