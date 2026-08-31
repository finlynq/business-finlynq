import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { reversePostedJournal } from "@/modules/ledger/journal-service";

const bodySchema = z.object({
  periodId: z.uuid(),
  accountingDate: z.iso.date(),
  description: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
});
const paramsSchema = z.object({ journalId: z.uuid() });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "journal reversal",
  rateAction: "reverse",
  maximumBytes: 16_000,
  sameOriginMessage: "The reversal request could not be verified.",
  unauthorizedMessage: "An authorized organization journal is required.",
  invalidParamsMessage: "An authorized organization journal is required.",
  invalidParamsStatus: 403,
  rateLimitMessage: "Too many reversal requests. Try again later.",
  invalidMessage: "Invalid reversal request.",
  failureMessage:
    "The journal could not be reversed. Verify ownership, the target period, and your reversal/posting roles.",
  auditReason: (body) => body.reason,
  invoke: (body, context, params) => reversePostedJournal({
    context,
    originalJournalId: params.journalId,
    ...body,
  }),
});
