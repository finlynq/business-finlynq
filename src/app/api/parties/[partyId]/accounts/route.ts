import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { addPartyAccount } from "@/modules/parties/party-service";

const bodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(180),
  account: z.object({
    legalEntityId: z.uuid(),
    ledgerId: z.uuid(),
    role: z.enum(["CUSTOMER", "SUPPLIER"]),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
    controlAccountId: z.uuid(),
    transactionCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).nullable().optional(),
  }),
});
const paramsSchema = z.object({ partyId: z.uuid() });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "party-account attachment",
  rateAction: "party",
  maximumBytes: 16_000,
  sameOriginMessage: "The party account request could not be verified.",
  invalidParamsMessage: "Party identifier is invalid.",
  invalidParamsStatus: 400,
  rateLimitMessage: "Too many party requests. Try again later.",
  invalidMessage: "Party account fields are invalid.",
  failureMessage:
    "The entity role could not be attached. Verify the party, account number, control setup, currency, and your assigned role.",
  invoke: (body, context, params) => addPartyAccount({
    context,
    partyId: params.partyId,
    ...body,
  }),
});
