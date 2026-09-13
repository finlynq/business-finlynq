import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { hasRecentStepUp } from "@/modules/identity/session";
import { unpostJournal } from "@/modules/ledger/journal-administration-service";

const bodySchema = z.object({
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.uuid(),
}).strict();
const paramsSchema = z.object({ journalId: z.uuid() });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "journal unposting",
  rateAction: "unpost",
  maximumBytes: 16_000,
  successStatus: 200,
  unauthorizedMessage: "An authorized real organization session is required.",
  invalidParamsMessage: "An authorized organization journal is required.",
  invalidParamsStatus: 403,
  invalidMessage: "Provide an audit reason of at least 10 characters.",
  failureMessage: "The journal could not be unposted. It must be a posted manual journal in an open period with no reversal, source, tax, subledger, or reconciliation dependency.",
  auditReason: (body) => body.reason,
  authorize: (_body, principal) => principal.sessionMode !== "real"
    ? { error: "Journal administration is unavailable in the public demo.", status: 403 }
    : !hasRecentStepUp(principal)
      ? { error: "Current MFA assurance is required before unposting a journal.", status: 428 }
      : undefined,
  invoke: (body, context, params) => unpostJournal({
    context,
    journalId: params.journalId,
    ...body,
  }),
});
