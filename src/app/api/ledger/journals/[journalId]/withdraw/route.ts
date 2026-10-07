import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { journalRecoveryBodySchema, journalWorkflowMutationOptions } from "@/app/api/_shared/journal-workflow-mutation-route";
import { withdrawSubmittedJournal } from "@/modules/ledger/journal-workflow-service";

export const POST = createMutationRoute({
  ...journalWorkflowMutationOptions("withdraw"),
  schema: journalRecoveryBodySchema,
  invoke: (body, context, params) => withdrawSubmittedJournal({
    context,
    journalId: params.journalId,
    ...body,
  }),
});
