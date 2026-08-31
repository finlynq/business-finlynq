import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { postJournal } from "@/modules/ledger/posting-service";

const bodySchema = z.object({
  expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});
const paramsSchema = z.object({ journalId: z.uuid() });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "journal posting",
  rateAction: "post",
  maximumBytes: 16_000,
  successStatus: 200,
  sameOriginMessage: "The posting request could not be verified.",
  unauthorizedMessage: "An authorized organization journal is required.",
  invalidParamsMessage: "An authorized organization journal is required.",
  invalidParamsStatus: 403,
  rateLimitMessage: "Too many posting requests. Try again later.",
  invalidMessage: "Invalid posting request.",
  failureMessage:
    "The journal could not be posted. Verify its period, balance, approval state, and your posting role.",
  invoke: (body, context, params) => postJournal({
    context,
    journalId: params.journalId,
    expectedContentHash: body.expectedContentHash,
  }),
});
