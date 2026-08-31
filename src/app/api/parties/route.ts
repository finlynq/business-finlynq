import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { createParty } from "@/modules/parties/party-service";

const bodySchema = z.object({
  partyNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(180),
  internalLegalEntityId: z.uuid().optional(),
  account: z.object({
    legalEntityId: z.uuid(),
    ledgerId: z.uuid(),
    role: z.enum(["CUSTOMER", "SUPPLIER"]),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
    controlAccountId: z.uuid(),
    transactionCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).nullable().optional(),
  }).optional(),
  address: z.object({
    kind: z.enum(["BILLING", "SHIPPING", "REMIT_TO", "REGISTERED"]),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(30),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/),
    validFrom: z.iso.date(),
  }).optional(),
});

export const POST = createMutationRoute({
  schema: bodySchema,
  operation: "party creation",
  rateAction: "party",
  maximumBytes: 32_000,
  sameOriginMessage: "The party request could not be verified.",
  rateLimitMessage: "Too many party requests. Try again later.",
  invalidMessage: "Party fields are invalid.",
  failureMessage:
    "The party could not be saved. Verify its number, master data, encryption setup, and your assigned role.",
  invoke: (body, context) => createParty({
    context,
    ...body,
  }),
});
