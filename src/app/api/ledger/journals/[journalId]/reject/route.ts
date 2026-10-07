import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { journalRecoveryBodySchema, journalWorkflowMutationOptions } from "@/app/api/_shared/journal-workflow-mutation-route";
import { rejectSubmittedJournal } from "@/modules/ledger/journal-workflow-service";

export const POST = createMutationRoute({
  ...journalWorkflowMutationOptions("reject"),
  schema: journalRecoveryBodySchema,
  invoke: (body, context, params) => rejectSubmittedJournal({
    context,
    journalId: params.journalId,
    ...body,
  }),
});
